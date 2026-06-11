#!/usr/bin/env bash
# Register secrets to SSM Parameter Store for simplified Slack bot
#
# Required files:
#   - ANTHROPIC_API_KEY.txt (Anthropic API key)
#   - ORCHESTRATOR_BOT_TOKEN.txt (Slack bot token)
#   - SLACK_SIGNING_SECRET.txt (Slack app signing secret)

set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

put() {
  local name="$1" value="$2" type="${3:-SecureString}"
  if [ -z "$value" ]; then
    echo "  ⚠️  skipped $name (empty value)"
    return
  fi
  aws ssm put-parameter --name "$name" --value "$value" --type "$type" --overwrite \
    --region "$REGION" >/dev/null
  echo "  ✅ registered $name"
}

echo "==> Registering credentials to SSM Parameter Store ($REGION)"
echo ""

# 1. Anthropic API Key
echo "1️⃣  Anthropic API Key"
if [ -f "$ROOT/ANTHROPIC_API_KEY.txt" ]; then
  API_KEY=$(cat "$ROOT/ANTHROPIC_API_KEY.txt")
  put "/claude-bot/ANTHROPIC_API_KEY" "$API_KEY"
else
  echo "  ⚠️  ANTHROPIC_API_KEY.txt not found in $ROOT"
  echo "     Create this file with your Anthropic API key"
fi

echo ""

# 2. Slack Bot Token
echo "2️⃣  Slack Bot Token"
BOT_TOKEN_FILE="$ROOT/multi-agent-slack-assets/ORCHESTRATOR_BOT_TOKEN.txt"
if [ -f "$BOT_TOKEN_FILE" ]; then
  BOT_TOKEN=$(cat "$BOT_TOKEN_FILE")
  put "/claude-bot/ORCHESTRATOR_BOT_TOKEN" "$BOT_TOKEN"
else
  # Try alternate location
  if [ -f "$ROOT/ORCHESTRATOR_BOT_TOKEN.txt" ]; then
    BOT_TOKEN=$(cat "$ROOT/ORCHESTRATOR_BOT_TOKEN.txt")
    put "/claude-bot/ORCHESTRATOR_BOT_TOKEN" "$BOT_TOKEN"
  else
    echo "  ⚠️  ORCHESTRATOR_BOT_TOKEN.txt not found"
    echo "     Create this file with your Slack bot token (xoxb-...)"
  fi
fi

echo ""

# 3. Slack Signing Secret
echo "3️⃣  Slack Signing Secret"
SIGNING_SECRET_FILE="$ROOT/multi-agent-slack-assets/SLACK_SIGNING_SECRET.txt"
if [ -f "$SIGNING_SECRET_FILE" ]; then
  SIGNING_SECRET=$(cat "$SIGNING_SECRET_FILE")
  put "/claude-bot/SLACK_SIGNING_SECRET" "$SIGNING_SECRET"
else
  # Try alternate location
  if [ -f "$ROOT/SLACK_SIGNING_SECRET.txt" ]; then
    SIGNING_SECRET=$(cat "$ROOT/SLACK_SIGNING_SECRET.txt")
    put "/claude-bot/SLACK_SIGNING_SECRET" "$SIGNING_SECRET"
  else
    echo "  ⚠️  SLACK_SIGNING_SECRET.txt not found"
    echo "     Create this file with your Slack app's Signing Secret"
  fi
fi

echo ""
echo "============================================================"
echo "✅ SSM registration complete"
echo ""
echo "Registered parameters:"
echo "  - /claude-bot/ANTHROPIC_API_KEY"
echo "  - /claude-bot/ORCHESTRATOR_BOT_TOKEN"
echo "  - /claude-bot/SLACK_SIGNING_SECRET"
echo ""
echo "You can verify with:"
echo "  aws ssm describe-parameters --region $REGION --query 'Parameters[?Name==\`/claude-bot/*\`]'"
echo "============================================================"
