#!/usr/bin/env bash
# Deploy multi-agent Slack bot:
#   API Gateway -> receiver Lambda (claude-bot-handler) -> SQS -> processor Lambda
#   + DynamoDB task table, DLQ, IAM. Idempotent.

set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
PREFIX="claude-bot"
API_NAME="claude-bot-api"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
QUEUE_NAME="${PREFIX}-queue"
DLQ_NAME="${PREFIX}-dlq"
TABLE_NAME="${PREFIX}-tasks"
RECEIVER_FN="${PREFIX}-handler"     # existing function wired to API Gateway; now runs receiver
PROCESSOR_FN="${PREFIX}-processor"
ROLE_NAME="${PREFIX}-role"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "============================================================"
echo " Multi-Agent Slack Bot Deployment"
echo "============================================================"

# ---------------------------------------------------------------------------
# 1) IAM role + inline policy (SQS / DynamoDB on top of existing SSM + logs)
# ---------------------------------------------------------------------------
echo "==> IAM role"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  TRUST="$(mktemp)"
  cat > "$TRUST" <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$TRUST" >/dev/null
  rm -f "$TRUST"
  sleep 8
fi
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess >/dev/null 2>&1 || true

POLICY="$(mktemp)"
cat > "$POLICY" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      "Resource": ["arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}", "arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${DLQ_NAME}"]
    },
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}"
    }
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "${PREFIX}-sqs-dynamodb" --policy-document "file://$POLICY" >/dev/null
rm -f "$POLICY"

# ---------------------------------------------------------------------------
# 2) DynamoDB table (pk only, TTL on "ttl")
# ---------------------------------------------------------------------------
echo "==> DynamoDB table $TABLE_NAME"
if ! aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST --region "$REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
  aws dynamodb update-time-to-live --table-name "$TABLE_NAME" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" --region "$REGION" >/dev/null
fi

# ---------------------------------------------------------------------------
# 3) SQS queue + DLQ (visibility >= processor timeout)
# ---------------------------------------------------------------------------
echo "==> SQS queues"
DLQ_URL="$(aws sqs create-queue --queue-name "$DLQ_NAME" --region "$REGION" \
  --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)"
DLQ_ARN="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --region "$REGION" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)"
if QUEUE_URL="$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" \
  --query QueueUrl --output text 2>/dev/null)"; then
  # VisibilityTimeout は processor の Lambda タイムアウト（900s）より長くする
  aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --region "$REGION" \
    --attributes "{\"VisibilityTimeout\":\"960\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}"
else
  QUEUE_URL="$(aws sqs create-queue --queue-name "$QUEUE_NAME" --region "$REGION" \
    --attributes "{\"VisibilityTimeout\":\"960\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" \
    --query QueueUrl --output text)"
fi
QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}"

# ---------------------------------------------------------------------------
# 4) Build & deploy Lambdas
# ---------------------------------------------------------------------------
echo "==> Building bundle"
npm run package

deploy_fn() {
  local fn="$1" handler="$2" timeout="$3" env="$4"
  if aws lambda get-function --function-name "$fn" --region "$REGION" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$fn" \
      --zip-file fileb://lambda.zip --region "$REGION" >/dev/null
    aws lambda wait function-updated --function-name "$fn" --region "$REGION"
    aws lambda update-function-configuration --function-name "$fn" \
      --handler "$handler" --timeout "$timeout" --memory-size 512 \
      --environment "$env" --runtime nodejs24.x --region "$REGION" >/dev/null
    aws lambda wait function-updated --function-name "$fn" --region "$REGION"
  else
    aws lambda create-function --function-name "$fn" --runtime nodejs24.x \
      --role "$ROLE_ARN" --handler "$handler" --timeout "$timeout" --memory-size 512 \
      --environment "$env" --zip-file fileb://lambda.zip --region "$REGION" >/dev/null
    aws lambda wait function-active --function-name "$fn" --region "$REGION"
  fi
  echo "  ✅ $fn ($handler)"
}

deploy_fn "$RECEIVER_FN" "receiver.handler" 30 "Variables={QUEUE_URL=${QUEUE_URL}}"
# 900s: Web 検索ありの researcher が複数ラウンドの生成+検索を完走できる長さ
deploy_fn "$PROCESSOR_FN" "processor.handler" 900 "Variables={TASKS_TABLE=${TABLE_NAME}}"

# SQS -> processor event source mapping (batch size 1)
echo "==> SQS event source mapping"
MAPPING="$(aws lambda list-event-source-mappings --function-name "$PROCESSOR_FN" \
  --event-source-arn "$QUEUE_ARN" --region "$REGION" --query 'EventSourceMappings[0].UUID' --output text)"
if [ -z "$MAPPING" ] || [ "$MAPPING" = "None" ]; then
  aws lambda create-event-source-mapping --function-name "$PROCESSOR_FN" \
    --event-source-arn "$QUEUE_ARN" --batch-size 1 --region "$REGION" >/dev/null
  echo "  ✅ created"
else
  aws lambda update-event-source-mapping --uuid "$MAPPING" --enabled --region "$REGION" >/dev/null
  echo "  ✅ exists ($MAPPING, enabled)"
fi

# ---------------------------------------------------------------------------
# 5) HTTP API (reuse existing; integration already targets $RECEIVER_FN)
# ---------------------------------------------------------------------------
echo "==> HTTP API"
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)"
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID="$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP \
    --target "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${RECEIVER_FN}" \
    --region "$REGION" --query ApiId --output text)"
  aws lambda add-permission --function-name "$RECEIVER_FN" \
    --statement-id "AllowAPIGateway-$API_ID" --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --region "$REGION" >/dev/null 2>&1 || true
fi
STAGE_NAME="$(aws apigatewayv2 get-stages --api-id "$API_ID" --region "$REGION" \
  --query 'Items[0].StageName' --output text 2>/dev/null || echo prod)"

echo ""
echo "============================================================"
echo " Deployment Complete"
echo ""
echo " Request URL: https://${API_ID}.execute-api.${REGION}.amazonaws.com/${STAGE_NAME}/slack/events"
echo " Queue:       ${QUEUE_URL}"
echo " Table:       ${TABLE_NAME}"
echo ""
echo " Prompts/AGENT_CONFIG: bash scripts/setup-prompts.sh"
echo "============================================================"
