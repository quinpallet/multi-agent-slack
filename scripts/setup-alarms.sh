#!/usr/bin/env bash
# Set up operational monitoring for the multi-agent Slack bot:
#   - SNS topic + email subscription
#   - DLQ message alarm (claude-bot-dlq has any message)
#   - Lambda error alarms (claude-bot-handler / claude-bot-processor)
# Idempotent: safe to re-run.

set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
PREFIX="claude-bot"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
NOTIFICATION_EMAIL="${NOTIFICATION_EMAIL:-kenqlo@gmail.com}"

TOPIC_NAME="${PREFIX}-alerts"
DLQ_NAME="${PREFIX}-dlq"
HANDLER_FN="${PREFIX}-handler"
PROCESSOR_FN="${PREFIX}-processor"

echo "============================================================"
echo " Multi-Agent Slack Bot - Alarm Setup"
echo "============================================================"

# ---------------------------------------------------------------------------
# 1) SNS topic + email subscription
# ---------------------------------------------------------------------------
echo "==> SNS topic"
TOPIC_ARN="$(aws sns create-topic --name "$TOPIC_NAME" --region "$REGION" --query TopicArn --output text)"
echo "  ✅ $TOPIC_ARN"

EXISTING_SUB="$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --region "$REGION" \
  --query "Subscriptions[?Endpoint=='${NOTIFICATION_EMAIL}'].SubscriptionArn | [0]" --output text)"
if [ -z "$EXISTING_SUB" ] || [ "$EXISTING_SUB" = "None" ]; then
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$NOTIFICATION_EMAIL" \
    --region "$REGION" >/dev/null
  echo "  ✅ subscribed $NOTIFICATION_EMAIL (confirmation email sent - click the link to activate)"
else
  echo "  ✅ already subscribed: $NOTIFICATION_EMAIL"
fi

# ---------------------------------------------------------------------------
# 2) DLQ alarm: any message in claude-bot-dlq means a job exhausted retries
# ---------------------------------------------------------------------------
echo "==> DLQ alarm"
aws cloudwatch put-metric-alarm \
  --alarm-name "${PREFIX}-dlq-messages" \
  --alarm-description "claude-bot-dlq にメッセージが入った（処理失敗がリトライ上限まで到達）" \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value="$DLQ_NAME" \
  --statistic Maximum \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN" \
  --region "$REGION" >/dev/null
echo "  ✅ ${PREFIX}-dlq-messages"

# ---------------------------------------------------------------------------
# 3) Lambda error alarms (receiver / processor)
# ---------------------------------------------------------------------------
echo "==> Lambda error alarms"
for FN in "$HANDLER_FN" "$PROCESSOR_FN"; do
  aws cloudwatch put-metric-alarm \
    --alarm-name "${FN}-errors" \
    --alarm-description "${FN} で Lambda 実行エラーが発生した" \
    --namespace AWS/Lambda \
    --metric-name Errors \
    --dimensions Name=FunctionName,Value="$FN" \
    --statistic Sum \
    --period 300 \
    --evaluation-periods 1 \
    --threshold 1 \
    --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "$TOPIC_ARN" \
    --region "$REGION" >/dev/null
  echo "  ✅ ${FN}-errors"
done

echo ""
echo "============================================================"
echo " Done. Check $NOTIFICATION_EMAIL for an SNS subscription"
echo " confirmation email and click the confirmation link."
echo "============================================================"
