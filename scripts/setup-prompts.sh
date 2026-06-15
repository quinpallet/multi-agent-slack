#!/usr/bin/env bash
# =============================================================================
# setup-prompts.sh — エージェント定義一式を SSM に登録する
#
# エージェントの一覧は prompts/agents.json（マニフェスト）が唯一の源泉。
# ここに1エントリ追加して本スクリプトを実行するだけで、コード変更・
# Lambda 再デプロイなしに新しいエージェントを追加できる。
#
# エージェントごとに登録するもの：
#   /claude-bot/prompt/<agent>          : 役割プロンプト（prompts/<agent>.md）
#   /claude-bot/<AGENT>_BOT_TOKEN       : Bot Token（assets にファイルがあれば）
#   /claude-bot/SIGNING_SECRET_<AGENT>  : Signing Secret（assets にファイルがあれば）
#   /claude-bot/AGENT_CONFIG            : 全エージェントの構成 JSON
#                                         （userId/botId は auth.test で実機解決）
#
# 前提ファイル（リポジトリ外 ../multi-agent-slack-assets/）：
#   <AGENT>_BOT_TOKEN.txt / <AGENT>_SIGNING_SECRET.txt
#
# プロンプトは 4KB（Standard 上限）を超えうるため Intelligent-Tiering で登録。
# Lambda 側の SSM キャッシュは TTL 60秒なので、実行後約1分で全エージェントに反映。
# =============================================================================

set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$(cd "$DIR/../multi-agent-slack-assets" && pwd)"
MANIFEST="$DIR/prompts/agents.json"

if [ ! -f "$MANIFEST" ]; then
  echo "❌ $MANIFEST not found" >&2
  exit 1
fi

# エージェント一覧はマニフェストのキーから動的に取得（ハードコードしない）
AGENTS=$(jq -r 'keys[]' "$MANIFEST")

echo "==> Agents in manifest: $(echo $AGENTS | tr '\n' ' ')"

echo ""
echo "==> Registering agent prompts to SSM ($REGION)"
for agent in $AGENTS; do
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
echo "==> Registering tokens / signing secrets from assets (if present)"
for agent in $AGENTS; do
  upper=$(echo "$agent" | tr '[:lower:]' '[:upper:]')
  token_file="$ASSETS/${upper}_BOT_TOKEN.txt"
  secret_file="$ASSETS/${upper}_SIGNING_SECRET.txt"
  if [ -f "$token_file" ]; then
    aws ssm put-parameter --name "/claude-bot/${upper}_BOT_TOKEN" \
      --value "$(tr -d '[:space:]' < "$token_file")" \
      --type SecureString --overwrite --region "$REGION" >/dev/null
    echo "  ✅ /claude-bot/${upper}_BOT_TOKEN"
  else
    echo "  ⚠️  $token_file not found（既登録ならそのまま使われます）"
  fi
  if [ -f "$secret_file" ]; then
    aws ssm put-parameter --name "/claude-bot/SIGNING_SECRET_${upper}" \
      --value "$(tr -d '[:space:]' < "$secret_file")" \
      --type SecureString --overwrite --region "$REGION" >/dev/null
    echo "  ✅ /claude-bot/SIGNING_SECRET_${upper}"
  else
    echo "  ⚠️  $secret_file not found（既登録ならそのまま使われます）"
  fi
done

echo ""
echo "==> Building AGENT_CONFIG (resolving bot IDs via auth.test)"
CONFIG="{}"
for agent in $AGENTS; do
  upper=$(echo "$agent" | tr '[:lower:]' '[:upper:]')
  # Bot Token は assets のファイル、無ければ SSM の既登録値から取得して auth.test に使う
  if [ -f "$ASSETS/${upper}_BOT_TOKEN.txt" ]; then
    token=$(tr -d '[:space:]' < "$ASSETS/${upper}_BOT_TOKEN.txt")
  else
    token=$(aws ssm get-parameter --name "/claude-bot/${upper}_BOT_TOKEN" \
      --with-decryption --query 'Parameter.Value' --output text --region "$REGION")
  fi
  # auth.test で userId / botId を実機解決（再インストールによる ID 変化に追従）
  auth=$(curl -s -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $token")
  ok=$(echo "$auth" | jq -r .ok)
  if [ "$ok" != "true" ]; then
    echo "  ❌ auth.test failed for $agent: $(echo "$auth" | jq -r .error)"
    exit 1
  fi
  user_id=$(echo "$auth" | jq -r .user_id)
  bot_id=$(echo "$auth" | jq -r .bot_id)
  echo "  ✅ $agent: userId=$user_id botId=$bot_id"

  # マニフェストのメタ情報（description / mentionLimits）に実機解決した ID を合成
  CONFIG=$(jq -cn \
    --argjson cfg "$CONFIG" \
    --argjson meta "$(jq -c ".\"$agent\"" "$MANIFEST")" \
    --arg agent "$agent" \
    --arg userId "$user_id" \
    --arg botId "$bot_id" \
    --arg tokenParam "/claude-bot/${upper}_BOT_TOKEN" \
    --arg secretParam "/claude-bot/SIGNING_SECRET_${upper}" \
    '$cfg + {($agent): ($meta + {userId: $userId, botId: $botId, botTokenParam: $tokenParam, signingSecretParam: $secretParam})}')
done

aws ssm put-parameter --name /claude-bot/AGENT_CONFIG \
  --value "$CONFIG" --type String --overwrite --region "$REGION" >/dev/null
echo "  ✅ /claude-bot/AGENT_CONFIG updated"
echo ""
echo "Done. Lambda には SSM キャッシュ TTL（60秒）経過後に反映されます。"
