#!/usr/bin/env bash
# Build and deploy the multi-agent stack: IAM role, SQS queues, DynamoDB tables,
# receiver + processor Lambdas, SQS->processor triggers, and HTTP API. Safe to re-run.
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
PREFIX="claude-bot"
ROLE_NAME="${PREFIX}-role"
DLQ_NAME="${PREFIX}-dlq"
RECEIVER_FN="${PREFIX}-receiver"
API_NAME="${PREFIX}-api"
MODEL="${ANTHROPIC_MODEL:-claude-haiku-4-5-20251001}"

# Agent configuration (add more as needed)
declare -a AGENTS=("orchestrator" "researcher" "writer" "reviewer")

cd "$(dirname "$0")/.."
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

echo "==> Building Lambda bundle"
npm run package

# ---------------------------------------------------------------------------
# 1) IAM execution role (with DynamoDB permissions)
# ---------------------------------------------------------------------------
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "==> Creating IAM role $ROLE_NAME"
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSQSFullAccess
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess
  echo "==> Waiting for IAM role to propagate"
  sleep 12
else
  echo "==> Role already exists. Ensuring DynamoDB policy is attached..."
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess 2>/dev/null || true
fi
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# ---------------------------------------------------------------------------
# 2) DynamoDB tables (task state + conversation history)
# ---------------------------------------------------------------------------
echo "==> Checking DynamoDB tables"

# Tasks table
if ! aws dynamodb describe-table --table-name claude-bot-tasks --region "$REGION" >/dev/null 2>&1; then
  echo "==> Creating DynamoDB table: claude-bot-tasks"
  aws dynamodb create-table \
    --table-name claude-bot-tasks \
    --attribute-definitions AttributeName=taskId,AttributeType=S \
    --key-schema AttributeName=taskId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" >/dev/null
  aws dynamodb wait table-exists --table-name claude-bot-tasks --region "$REGION"
  aws dynamodb update-time-to-live \
    --table-name claude-bot-tasks \
    --time-to-live-specification AttributeName=ttl,Enabled=true \
    --region "$REGION" >/dev/null 2>&1 || true
fi

# History table
if ! aws dynamodb describe-table --table-name claude-bot-history --region "$REGION" >/dev/null 2>&1; then
  echo "==> Creating DynamoDB table: claude-bot-history"
  aws dynamodb create-table \
    --table-name claude-bot-history \
    --attribute-definitions \
      AttributeName=agentId,AttributeType=S \
      AttributeName=taskId,AttributeType=S \
    --key-schema \
      AttributeName=agentId,KeyType=HASH \
      AttributeName=taskId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" >/dev/null
  aws dynamodb wait table-exists --table-name claude-bot-history --region "$REGION"
  aws dynamodb update-time-to-live \
    --table-name claude-bot-history \
    --time-to-live-specification AttributeName=ttl,Enabled=true \
    --region "$REGION" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# 3) SQS queues (DLQ + agent-specific queues)
# ---------------------------------------------------------------------------
echo "==> Setting up SQS queues"

# Dead-letter queue
DLQ_URL="$(aws sqs get-queue-url --queue-name "$DLQ_NAME" --region "$REGION" \
  --query QueueUrl --output text 2>/dev/null || true)"
if [ -z "$DLQ_URL" ] || [ "$DLQ_URL" = "None" ]; then
  echo "==> Creating SQS dead-letter queue $DLQ_NAME"
  DLQ_URL="$(aws sqs create-queue --queue-name "$DLQ_NAME" \
    --attributes MessageRetentionPeriod=1209600 --region "$REGION" --query QueueUrl --output text)"
fi
DLQ_ARN="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --region "$REGION" --query 'Attributes.QueueArn' --output text)"

# Agent-specific queues
declare -A QUEUE_URLS QUEUE_ARNS
for AGENT in "${AGENTS[@]}"; do
  QUEUE_NAME="${PREFIX}-${AGENT}"
  QUEUE_URL="$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" \
    --query QueueUrl --output text 2>/dev/null || true)"
  if [ -z "$QUEUE_URL" ] || [ "$QUEUE_URL" = "None" ]; then
    echo "==> Creating SQS queue $QUEUE_NAME"
    QUEUE_URL="$(aws sqs create-queue --queue-name "$QUEUE_NAME" \
      --attributes VisibilityTimeout=60 --region "$REGION" --query QueueUrl --output text)"
  fi

  QUEUE_URLS["$AGENT"]="$QUEUE_URL"
  QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" \
    --attribute-names QueueArn --region "$REGION" --query 'Attributes.QueueArn' --output text)"
  QUEUE_ARNS["$AGENT"]="$QUEUE_ARN"

  # Attach redrive policy (idempotent): move to DLQ after 3 receives
  REDRIVE_FILE="$(mktemp)"
  printf '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"3\\"}"}' "$DLQ_ARN" > "$REDRIVE_FILE"
  aws sqs set-queue-attributes --queue-url "$QUEUE_URL" \
    --attributes "file://$REDRIVE_FILE" --region "$REGION"
  rm -f "$REDRIVE_FILE"
done

# ---------------------------------------------------------------------------
# 4) Lambda functions (create or update)
# ---------------------------------------------------------------------------
deploy_fn() {
  local name="$1" handler="$2" timeout="$3" env_json="$4"
  if aws lambda get-function --function-name "$name" --region "$REGION" >/dev/null 2>&1; then
    echo "==> Updating function $name"
    aws lambda update-function-code --function-name "$name" \
      --zip-file fileb://lambda.zip --region "$REGION" >/dev/null
    aws lambda wait function-updated --function-name "$name" --region "$REGION"
    aws lambda update-function-configuration --function-name "$name" \
      --handler "$handler" --timeout "$timeout" --runtime nodejs24.x --role "$ROLE_ARN" \
      --environment "$env_json" --region "$REGION" >/dev/null
  else
    echo "==> Creating function $name"
    aws lambda create-function --function-name "$name" --runtime nodejs24.x \
      --role "$ROLE_ARN" --handler "$handler" --timeout "$timeout" \
      --zip-file fileb://lambda.zip --environment "$env_json" --region "$REGION" >/dev/null
  fi
  aws lambda wait function-updated --function-name "$name" --region "$REGION"
}

# Build AGENT_CONFIG JSON
AGENT_CONFIG="{}"
for AGENT in "${AGENTS[@]}"; do
  # Placeholder: Bot user IDs must be manually verified and updated in SSM
  BOT_USER_ID="U_${AGENT^^}_ID"
  AGENT_CONFIG=$(echo "$AGENT_CONFIG" | jq \
    --arg agent "$AGENT" \
    --arg userId "$BOT_USER_ID" \
    --arg queueUrl "${QUEUE_URLS[$AGENT]}" \
    --arg tokenParam "/claude-bot/${AGENT^^}_BOT_TOKEN" \
    '.[$agent] = {userId: $userId, sqsQueueUrl: $queueUrl, botTokenParam: $tokenParam}')
done

# Receiver Lambda
deploy_fn "$RECEIVER_FN" "receiver.handler" 10 \
  "{\"Variables\":{\"AGENT_CONFIG_PARAM\":\"/claude-bot/AGENT_CONFIG\"}}"

# Processor Lambdas (one per agent)
for AGENT in "${AGENTS[@]}"; do
  PROCESSOR_FN="${PREFIX}-processor-${AGENT}"
  deploy_fn "$PROCESSOR_FN" "processor.handler" 60 \
    "{\"Variables\":{\"AGENT_NAME\":\"${AGENT}\",\"SLACK_BOT_TOKEN_PARAM\":\"/claude-bot/${AGENT^^}_BOT_TOKEN\",\"ANTHROPIC_API_KEY_PARAM\":\"/claude-bot/ANTHROPIC_API_KEY\",\"ANTHROPIC_MODEL\":\"${MODEL}\"}}"
done

# ---------------------------------------------------------------------------
# 5) SQS -> processor triggers
# ---------------------------------------------------------------------------
echo "==> Setting up SQS -> processor event source mappings"
for AGENT in "${AGENTS[@]}"; do
  PROCESSOR_FN="${PREFIX}-processor-${AGENT}"
  QUEUE_ARN="${QUEUE_ARNS[$AGENT]}"

  # Check if mapping already exists
  if ! aws lambda list-event-source-mappings --function-name "$PROCESSOR_FN" --region "$REGION" \
      --query "EventSourceMappings[?EventSourceArn=='$QUEUE_ARN'].UUID" --output text | grep -q .; then
    echo "==> Creating SQS -> $PROCESSOR_FN event source mapping"
    aws lambda create-event-source-mapping --function-name "$PROCESSOR_FN" \
      --event-source-arn "$QUEUE_ARN" --batch-size 1 --region "$REGION" >/dev/null
  fi
done

# ---------------------------------------------------------------------------
# 6) HTTP API (API Gateway v2)
# ---------------------------------------------------------------------------
echo "==> Setting up HTTP API"
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)"
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  echo "==> Creating HTTP API $API_NAME"
  API_ID="$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP \
    --region "$REGION" --query ApiId --output text)"
fi

RECEIVER_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${RECEIVER_FN}"

# Reuse an existing integration for this API if one is already present.
INTEGRATION_ID="$(aws apigatewayv2 get-integrations --api-id "$API_ID" --region "$REGION" \
  --query 'Items[0].IntegrationId | [0]' --output text 2>/dev/null || true)"
if [ -z "$INTEGRATION_ID" ] || [ "$INTEGRATION_ID" = "None" ]; then
  INTEGRATION_ID="$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --integration-uri "$RECEIVER_ARN" \
    --payload-format-version 2.0 --region "$REGION" --query IntegrationId --output text)"
fi

aws apigatewayv2 create-route --api-id "$API_ID" --route-key 'POST /slack/events' \
  --target "integrations/${INTEGRATION_ID}" --region "$REGION" >/dev/null 2>&1 || true
aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name prod --auto-deploy \
  --region "$REGION" >/dev/null 2>&1 || true

aws lambda add-permission --function-name "$RECEIVER_FN" --statement-id apigw-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*/slack/events" \
  --region "$REGION" >/dev/null 2>&1 || true

ENDPOINT="https://${API_ID}.execute-api.${REGION}.amazonaws.com/prod/slack/events"

# ---------------------------------------------------------------------------
# 7) Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " Multi-Agent Deploy Complete"
echo ""
echo " Slack Event Subscriptions Request URL:"
echo "   $ENDPOINT"
echo ""
echo " Next steps:"
echo "   1. Register agent Bot Tokens in SSM:"
echo "      aws ssm put-parameter --name /claude-bot/ORCHESTRATOR_BOT_TOKEN --value 'xoxb-...' --type SecureString --region $REGION"
echo "      aws ssm put-parameter --name /claude-bot/RESEARCHER_BOT_TOKEN --value 'xoxb-...' --type SecureString --region $REGION"
echo "      aws ssm put-parameter --name /claude-bot/WRITER_BOT_TOKEN --value 'xoxb-...' --type SecureString --region $REGION"
echo "      aws ssm put-parameter --name /claude-bot/REVIEWER_BOT_TOKEN --value 'xoxb-...' --type SecureString --region $REGION"
echo ""
echo "   2. Update agent User IDs in SSM /claude-bot/AGENT_CONFIG:"
echo "      (Get each bot's User ID from Slack, e.g., U123ABC...)"
echo ""
echo "   3. Register AGENT_CONFIG in SSM:"
echo "      bash scripts/setup-ssm.sh"
echo ""
echo "============================================================"
