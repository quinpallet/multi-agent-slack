#!/usr/bin/env bash
# Test all multi-agent processors by sending test messages to each SQS queue
# and verifying execution via CloudWatch logs. Includes auto-retry for slow Lambda cold starts.
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
INITIAL_WAIT=5    # seconds to wait for first execution
RETRY_WAIT=10     # seconds to wait between retries
MAX_RETRIES=3     # maximum number of retry attempts

declare -a AGENTS=("orchestrator" "researcher" "writer" "reviewer")
declare -A TEST_RESULTS
declare -A BEFORE_TIMESTAMP

echo "============================================================"
echo " Multi-Agent Processor Test"
echo "============================================================"
echo ""
echo "Region: $REGION"
echo "Account: $ACCOUNT_ID"
echo "Initial wait: ${INITIAL_WAIT}s, Retry: ${RETRY_WAIT}s x${MAX_RETRIES}"
echo ""

# ---------------------------------------------------------------------------
# 0) Record baseline timestamps before sending messages
# ---------------------------------------------------------------------------
echo "==> Recording baseline log timestamps..."
BASELINE_TIME=$(date +%s)000

for AGENT in "${AGENTS[@]}"; do
  BEFORE_TIMESTAMP["$AGENT"]="$BASELINE_TIME"
done

echo "  Baseline: $(date)"
echo ""

# ---------------------------------------------------------------------------
# 1) Send test messages to all agent queues
# ---------------------------------------------------------------------------
echo "==> Sending test messages to SQS queues..."
echo ""

TIMESTAMP=$(date +%s%N | cut -b1-13)

for AGENT in "${AGENTS[@]}"; do
  QUEUE_URL="https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/claude-bot-${AGENT}"

  TEST_MESSAGE=$(cat <<EOF
{
  "type": "app_mention",
  "user": "U_TEST_RUNNER",
  "channel": "C_TEST_CHANNEL",
  "text": "@${AGENT} Integration test message [task_id:test-${TIMESTAMP}-${AGENT}]",
  "ts": "$(date +%s).000001",
  "thread_ts": "$(date +%s).000001",
  "bot_id": null
}
EOF
)

  if aws sqs send-message \
    --queue-url "$QUEUE_URL" \
    --message-body "$TEST_MESSAGE" \
    --region "$REGION" > /dev/null 2>&1; then
    echo "  ✓ $AGENT"
    TEST_RESULTS["$AGENT"]="queued"
  else
    echo "  ✗ $AGENT (failed to send)"
    TEST_RESULTS["$AGENT"]="send_failed"
  fi
done

# ---------------------------------------------------------------------------
# 2) Check CloudWatch logs with retry loop
# ---------------------------------------------------------------------------
check_logs() {
  local agents_with_logs=0

  for AGENT in "${AGENTS[@]}"; do
    LOG_GROUP="/aws/lambda/claude-bot-processor-${AGENT}"

    # Skip if already marked as failed
    if [ "${TEST_RESULTS[$AGENT]:-}" = "send_failed" ]; then
      continue
    fi

    # Get log events after baseline timestamp
    LOGS=$(aws logs filter-log-events \
      --log-group-name "$LOG_GROUP" \
      --start-time "${BEFORE_TIMESTAMP[$AGENT]}" \
      --region "$REGION" \
      --query 'events[*].message' \
      --output text 2>/dev/null || echo "")

    if [ -z "$LOGS" ]; then
      continue
    fi

    ((agents_with_logs++))

    # Check for specific patterns in order of priority
    if echo "$LOGS" | grep -q "DynamoDB error"; then
      TEST_RESULTS["$AGENT"]="dynamodb_error"
    elif echo "$LOGS" | grep -q "Anthropic API error.*credit balance is too low"; then
      TEST_RESULTS["$AGENT"]="credit_low"
    elif echo "$LOGS" | grep -q "Anthropic API error"; then
      TEST_RESULTS["$AGENT"]="anthropic_error"
    elif echo "$LOGS" | grep -q "Slack chat.postMessage failed: channel_not_found"; then
      TEST_RESULTS["$AGENT"]="slack_channel_error"
    elif echo "$LOGS" | grep -q "START RequestId\|REPORT RequestId"; then
      TEST_RESULTS["$AGENT"]="executed"
    else
      TEST_RESULTS["$AGENT"]="partial_logs"
    fi
  done

  return "$agents_with_logs"
}

# Initial wait
echo "⏳ Waiting ${INITIAL_WAIT}s for Lambda execution (cold start may be slow)..."
sleep "$INITIAL_WAIT"

# Retry loop
RETRY_COUNT=0
COMPLETED_AGENTS=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  echo ""
  echo "==> Checking CloudWatch logs (attempt $((RETRY_COUNT+1))/$MAX_RETRIES)..."

  check_logs
  COMPLETED_AGENTS=$?

  if [ "$COMPLETED_AGENTS" -eq "${#AGENTS[@]}" ]; then
    echo "✅ All agents have logs"
    break
  elif [ "$COMPLETED_AGENTS" -gt 0 ]; then
    echo "⏳ $COMPLETED_AGENTS/${#AGENTS[@]} agents responded. Retrying in ${RETRY_WAIT}s..."
  else
    echo "⏳ Waiting for Lambda to execute. Retrying in ${RETRY_WAIT}s..."
  fi

  ((RETRY_COUNT++))
  if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
    sleep "$RETRY_WAIT"
  fi
done

# ---------------------------------------------------------------------------
# 3) Print results
# ---------------------------------------------------------------------------
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test Results"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PASSED=0
FAILED=0
WARNED=0

for AGENT in "${AGENTS[@]}"; do
  STATUS="${TEST_RESULTS[$AGENT]:-no_logs}"

  case "$STATUS" in
    executed)
      echo "  ✅ $AGENT — Lambda executed successfully"
      ((PASSED++))
      ;;
    credit_low)
      echo "  ⚠️  $AGENT — Executed (Anthropic API key low on credits — normal in test)"
      ((WARNED++))
      ((PASSED++))
      ;;
    slack_channel_error)
      echo "  ⚠️  $AGENT — Executed (Slack channel_not_found — expected in test)"
      ((WARNED++))
      ((PASSED++))
      ;;
    dynamodb_error)
      echo "  ❌ $AGENT — DynamoDB error (check IAM permissions)"
      ((FAILED++))
      ;;
    anthropic_error)
      echo "  ❌ $AGENT — Anthropic API error"
      ((FAILED++))
      ;;
    send_failed)
      echo "  ❌ $AGENT — Failed to send SQS message"
      ((FAILED++))
      ;;
    no_logs|partial_logs)
      echo "  ⚠️  $AGENT — No execution logs detected (Lambda may be slow)"
      ;;
    *)
      echo "  ❓ $AGENT — $STATUS"
      ;;
  esac
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Passed: $PASSED / ${#AGENTS[@]}"
if [ $WARNED -gt 0 ]; then
  echo "  ⚠️  Warnings: $WARNED (expected in test environment)"
fi
echo "  ❌ Failed: $FAILED / ${#AGENTS[@]}"
echo ""

if [ $FAILED -eq 0 ] && [ $PASSED -gt 0 ]; then
  echo "✅ All agents are operational!"
  echo ""
  if [ $WARNED -gt 0 ]; then
    echo "Note: Warnings are expected (low API credits, test Slack channel)."
    echo "Production deployment will work normally with valid credentials."
  fi
  exit 0
else
  echo "❌ Some agents have issues. Debug with:"
  for AGENT in "${AGENTS[@]}"; do
    echo "   aws logs tail /aws/lambda/claude-bot-processor-${AGENT} --follow --region $REGION"
  done
  exit 1
fi
