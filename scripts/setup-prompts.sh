#!/usr/bin/env bash
# Register agent system prompts and AGENT_CONFIG (with bot IDs) to SSM.
# Prompts use Intelligent-Tiering since they can exceed the 4KB Standard limit.

set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$(cd "$DIR/../multi-agent-slack-assets" && pwd)"

echo "==> Registering agent prompts to SSM ($REGION)"
for agent in orchestrator researcher writer reviewer; do
  file="$DIR/prompts/${agent}.md"
  if [ ! -f "$file" ]; then
    echo "  ⚠️  $file not found, skipped"
    continue
  fi
  aws ssm put-parameter \
    --name "/claude-bot/prompt/${agent}" \
    --value "file://$file" \
    --type String --tier Intelligent-Tiering --overwrite \
    --region "$REGION" >/dev/null
  echo "  ✅ /claude-bot/prompt/${agent} ($(wc -c < "$file") bytes)"
done

echo ""
echo "==> Building AGENT_CONFIG (resolving bot IDs via auth.test)"
CONFIG="{"
first=true
for agent in orchestrator researcher writer reviewer; do
  upper=$(echo "$agent" | tr '[:lower:]' '[:upper:]')
  token=$(tr -d '[:space:]' < "$ASSETS/${upper}_BOT_TOKEN.txt")
  auth=$(curl -s -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $token")
  ok=$(echo "$auth" | jq -r .ok)
  if [ "$ok" != "true" ]; then
    echo "  ❌ auth.test failed for $agent: $(echo "$auth" | jq -r .error)"
    exit 1
  fi
  user_id=$(echo "$auth" | jq -r .user_id)
  bot_id=$(echo "$auth" | jq -r .bot_id)
  echo "  ✅ $agent: userId=$user_id botId=$bot_id"
  $first || CONFIG="$CONFIG,"
  first=false
  CONFIG="$CONFIG\"$agent\":{\"userId\":\"$user_id\",\"botId\":\"$bot_id\",\"botTokenParam\":\"/claude-bot/${upper}_BOT_TOKEN\"}"
done
CONFIG="$CONFIG}"

aws ssm put-parameter --name /claude-bot/AGENT_CONFIG \
  --value "$CONFIG" --type String --overwrite --region "$REGION" >/dev/null
echo "  ✅ /claude-bot/AGENT_CONFIG updated"
