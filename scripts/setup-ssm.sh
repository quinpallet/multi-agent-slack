#!/usr/bin/env bash
# Register secrets and agent configuration into SSM Parameter Store.
#
#   ANTHROPIC_API_KEY is read from ANTHROPIC_API_KEY.txt
#   Agent Bot Tokens are read from ORCHESTRATOR_BOT_TOKEN.txt, RESEARCHER_BOT_TOKEN.txt, etc.
#   Agent User IDs are read from corresponding _BOT_USER_ID.txt files (or provided via env)
#   SLACK_SIGNING_SECRET is optional for request verification
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

put() {
  local name="$1" value="$2" type="${3:-SecureString}"
  aws ssm put-parameter --name "$name" --value "$value" --type "$type" --overwrite \
    --region "$REGION" >/dev/null
  echo "  registered $name"
}

echo "==> Registering secrets to SSM Parameter Store ($REGION)"

# Anthropic API Key
put "/claude-bot/ANTHROPIC_API_KEY" "$(cat "$ROOT/ANTHROPIC_API_KEY.txt")"

# Agent Bot Tokens and User IDs
declare -a AGENTS=("orchestrator" "researcher" "writer" "reviewer")
declare -A AGENT_CONFIG

for AGENT in "${AGENTS[@]}"; do
  AGENT_UPPER=$(echo "$AGENT" | tr '[:lower:]' '[:upper:]')
  TOKEN_FILE="$ROOT/multi-agent-slack-assets/${AGENT_UPPER}_BOT_TOKEN.txt"
  USER_ID_FILE="$ROOT/multi-agent-slack-assets/${AGENT_UPPER}_BOT_USER_ID.txt"

  if [ -f "$TOKEN_FILE" ]; then
    BOT_TOKEN=$(cat "$TOKEN_FILE")
    put "/claude-bot/${AGENT_UPPER}_BOT_TOKEN" "$BOT_TOKEN"
  else
    echo "  (skip) ${AGENT_UPPER}_BOT_TOKEN.txt not found"
    continue
  fi

  # Get User ID from file or environment
  USER_ID=""
  if [ -f "$USER_ID_FILE" ]; then
    USER_ID=$(cat "$USER_ID_FILE")
  elif [ -n "${!AGENT_UPPER:-}" ] 2>/dev/null; then
    USER_ID="${!AGENT_UPPER}"
  fi

  if [ -n "$USER_ID" ]; then
    # Store in associative array for later
    AGENT_CONFIG["$AGENT"]="$USER_ID"
  else
    echo "  ⚠️  ${AGENT_UPPER}_BOT_USER_ID.txt not found and env not set. User ID is required for routing."
  fi
done

# Build and register AGENT_CONFIG JSON
if [ ${#AGENT_CONFIG[@]} -gt 0 ]; then
  AGENT_CONFIG_JSON="{}"
  for AGENT in "${AGENTS[@]}"; do
    if [ -n "${AGENT_CONFIG[$AGENT]:-}" ]; then
      USER_ID="${AGENT_CONFIG[$AGENT]}"
      AGENT_UPPER=$(echo "$AGENT" | tr '[:lower:]' '[:upper:]')
      QUEUE_URL="https://sqs.${REGION}.amazonaws.com/$(aws sts get-caller-identity --query Account --output text)/claude-bot-${AGENT}"

      AGENT_CONFIG_JSON=$(echo "$AGENT_CONFIG_JSON" | jq \
        --arg agent "$AGENT" \
        --arg userId "$USER_ID" \
        --arg queueUrl "$QUEUE_URL" \
        --arg tokenParam "/claude-bot/${AGENT_UPPER}_BOT_TOKEN" \
        '.[$agent] = {userId: $userId, sqsQueueUrl: $queueUrl, botTokenParam: $tokenParam}')
    fi
  done

  put "/claude-bot/AGENT_CONFIG" "$AGENT_CONFIG_JSON" "String"
else
  echo "  ⚠️  No agent configurations found. Please provide bot tokens and user IDs."
fi

# Signing Secret (optional)
if [ -n "${SLACK_SIGNING_SECRET:-}" ]; then
  put "/claude-bot/SLACK_SIGNING_SECRET" "$SLACK_SIGNING_SECRET"
else
  echo "  (skip) SLACK_SIGNING_SECRET is not set — signature verification will be DISABLED."
  echo "         Get it from Slack App > Basic Information > Signing Secret, then run:"
  echo "         SLACK_SIGNING_SECRET=xxxx bash scripts/setup-ssm.sh"
fi

echo ""
echo "==> SSM registration complete"
