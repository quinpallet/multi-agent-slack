# claude-bot — マルチエージェント Slack 協調システム

複数の Claude Bot が Slack チャンネルで相互にメンションし合い、協調してタスクを達成するシステムです。

```
@kenqlo: @orchestrator レポート作成して
  ↓
API Gateway (共通) → receiver Lambda
  ├→ @orchestrator SQS → processor Lambda
  ├→ @researcher SQS → processor Lambda
  ├→ @writer SQS → processor Lambda
  └→ @reviewer SQS → processor Lambda
  ↓
@kenqlo: 最終レポート完成
```

## アーキテクチャ

```
claude-bot/
├── src/
│   ├── receiver.ts        # API Gateway エンドポイント。署名検証 → エージェント別に SQS へルーティング
│   ├── processor.ts       # SQS トリガー。AGENT_NAME で役割を切り替え → Anthropic API → Slack
│   └── lib/
│       ├── ssm.ts         # SSM Parameter Store からのシークレット取得（キャッシュ付き）
│       ├── slack.ts       # 署名検証 + chat.postMessage
│       └── anthropic.ts   # Anthropic Messages API 呼び出し（非使用、processor が直接使用）
├── scripts/
│   ├── setup-ssm.sh       # Bot Token / AGENT_CONFIG を SSM へ登録
│   └── deploy.sh          # 全 AWS リソース作成・更新（再実行可能）
├── package.json
└── tsconfig.json
```

## デプロイ済みリソース（ap-northeast-1）

| リソース | 名前 | 説明 |
|---|---|---|
| IAM ロール | `claude-bot-role` | Lambda 実行ロール（SQS/SSM/DynamoDB アクセス） |
| DynamoDB (tasks) | `claude-bot-tasks` | タスク状態管理・無限ループ防止用ホップカウント |
| DynamoDB (history) | `claude-bot-history` | エージェント別の会話履歴管理 |
| SQS DLQ | `claude-bot-dlq` | 失敗メッセージ隔離（3回失敗で自動転送、保持14日） |
| SQS キュー | `claude-bot-orchestrator` | orchestrator processor 用 |
| SQS キュー | `claude-bot-researcher` | researcher processor 用 |
| SQS キュー | `claude-bot-writer` | writer processor 用 |
| SQS キュー | `claude-bot-reviewer` | reviewer processor 用 |
| Lambda (receiver) | `claude-bot-receiver` | 共通エンドポイント。メンション対象を判定してルーティング |
| Lambda (processors) | `claude-bot-processor-orchestrator` | orchestrator エージェント |
| | `claude-bot-processor-researcher` | researcher エージェント |
| | `claude-bot-processor-writer` | writer エージェント |
| | `claude-bot-processor-reviewer` | reviewer エージェント |
| HTTP API | `claude-bot-api` | API Gateway v2 |
| Request URL | `https://{API_ID}.execute-api.ap-northeast-1.amazonaws.com/prod/slack/events` | 全 Slack Apps で共通使用 |

SSM パラメータ:
- `/claude-bot/ANTHROPIC_API_KEY` (SecureString)
- `/claude-bot/ORCHESTRATOR_BOT_TOKEN` (SecureString)
- `/claude-bot/RESEARCHER_BOT_TOKEN` (SecureString)
- `/claude-bot/WRITER_BOT_TOKEN` (SecureString)
- `/claude-bot/REVIEWER_BOT_TOKEN` (SecureString)
- `/claude-bot/AGENT_CONFIG` (String, JSON)
- `/claude-bot/SLACK_SIGNING_SECRET` (SecureString, オプション)

## セットアップ手順

### 0. AWS デプロイ

```bash
cd claude-bot
bash scripts/deploy.sh
```

このコマンドが以下を自動作成：
- IAM ロール
- DynamoDB テーブル ×2
- SQS キュー ×5（DLQ + agent キュー）
- Lambda 関数 ×5（receiver + processor ×4）
- HTTP API

### 1. Slack App 作成（複数）

4 つの独立した Slack App を作成：
- `orchestrator`
- `researcher`
- `writer`
- `reviewer`

各 App について：
1. https://api.slack.com/apps で **Create New App**
2. App Name / Display Name を設定
3. **Bot Token Scopes** に以下を追加：
   - `app_mentions:read`
   - `chat:write`
4. **Event Subscriptions** → **Enable Events** → ON
5. **Request URL** に以下を貼り付け → **Verified** 確認
   ```
   https://{API_ID}.execute-api.ap-northeast-1.amazonaws.com/prod/slack/events
   ```
   （API_ID は `aws apigatewayv2 get-apis --region ap-northeast-1` で確認可能）
6. **Subscribe to Bot Events** に `app_mention` を追加 → **Save Changes**
7. **Install to Workspace** / **Reinstall App**
8. **Basic Information** で Bot Token (`xoxb-...`) を取得

### 2. Bot Token / User ID / Signing Secret 登録

各 Bot の token、user ID、signing secret を`.txt` ファイルで保存（リポジトリルート）：

```bash
# リポジトリルート
# Bot Tokens (Slack App > Install > Bot User OAuth Token から)
echo "xoxb-..." > ORCHESTRATOR_BOT_TOKEN.txt
echo "xoxb-..." > RESEARCHER_BOT_TOKEN.txt
echo "xoxb-..." > WRITER_BOT_TOKEN.txt
echo "xoxb-..." > REVIEWER_BOT_TOKEN.txt

# Bot User IDs (Slack で @bot-name と入力時に表示される U.... から)
echo "U123ABC..." > ORCHESTRATOR_BOT_USER_ID.txt
echo "U456DEF..." > RESEARCHER_BOT_USER_ID.txt
echo "U789GHI..." > WRITER_BOT_USER_ID.txt
echo "U0AB1CD..." > REVIEWER_BOT_USER_ID.txt

# Signing Secrets (Slack App > Basic Information > Signing Secret から)
echo "xxxx..." > ORCHESTRATOR_SIGNING_SECRET.txt
echo "yyyy..." > RESEARCHER_SIGNING_SECRET.txt
echo "zzzz..." > WRITER_SIGNING_SECRET.txt
echo "wwww..." > REVIEWER_SIGNING_SECRET.txt
```

**または、すべての App で同じ Signing Secret を使用する場合**:

```bash
echo "xxxx..." > SLACK_SIGNING_SECRET.txt
```

### 3. SSM へ登録

```bash
bash scripts/setup-ssm.sh
```

このコマンドが以下を登録：
- 各エージェントの Bot Token
- 各エージェントの Signing Secret（またはフォールバック統一 secret）
- AGENT_CONFIG JSON（User ID → SQS URL マッピング）

### 4. Bot をチャンネルに招待

```bash
/invite @orchestrator
/invite @researcher
/invite @writer
/invite @reviewer
```

（すべて同じチャンネルに招待可能。例：`#claude`）

### 5. 動作確認

```bash
# Slack チャンネルで
@orchestrator 生成AIの最新動向についてレポートを作成して
```

`#claude` チャンネルのスレッド内で：
1. orchestrator が調査タスクを researcher に割り当て
2. researcher が調査結果を返信
3. orchestrator が writer に執筆指示
4. writer がレポート作成
5. orchestrator が reviewer にレビュー指示
6. reviewer がレビュー完了
7. orchestrator が最終レポートを投稿

CloudWatch ログで確認：
```bash
aws logs tail /aws/lambda/claude-bot-processor-orchestrator --follow --region ap-northeast-1
aws logs tail /aws/lambda/claude-bot-processor-researcher --follow --region ap-northeast-1
aws logs tail /aws/lambda/claude-bot-processor-writer --follow --region ap-northeast-1
aws logs tail /aws/lambda/claude-bot-processor-reviewer --follow --region ap-northeast-1
```

## エージェント役割

| エージェント | 役割 | システムプロンプト |
|---|---|---|
| **orchestrator** | 指揮・分解・集約 | タスク分解 → エージェント割り当て → 結果集約 |
| **researcher** | 調査・情報収集 | トピック調査 → 事実・データ整理 |
| **writer** | 文章作成 | 情報 → 読みやすい文章に整形 |
| **reviewer** | レビュー・品質確認 | 文章検査 → 誤り・改善点指摘 |

各エージェントは `AGENT_NAME` 環境変数で役割を切り替え。システムプロンプトは processor.ts に定義。

## 無限ループ防止機構

複数エージェントの相互メンション → 無限ループリスク。以下の多重防御：

| 対策 | 場所 | 説明 |
|---|---|---|
| **MAX_HOPS チェック** | processor.ts | task_id ごとのメンション中継回数 (max 10) を DynamoDB 管理 |
| **Bot メッセージ無視** | receiver.ts | `slackEvent.bot_id` 存在 → キューイング不可 |
| **TTL 自動削除** | DynamoDB | task レコード 1 時間後に自動削除 |
| **スレッド限定処理** | processor.ts | `thread_ts` でスレッド内に閉じる |

## DLQ（デッドレターキュー）

処理が **3回連続で失敗** → `claude-bot-dlq` へ自動隔離：

```bash
# DLQ メッセージ数確認
aws sqs get-queue-attributes \
  --queue-url https://sqs.ap-northeast-1.amazonaws.com/{ACCOUNT_ID}/claude-bot-dlq \
  --attribute-names ApproximateNumberOfMessages --region ap-northeast-1

# 中身確認
aws sqs receive-message \
  --queue-url https://sqs.ap-northeast-1.amazonaws.com/{ACCOUNT_ID}/claude-bot-dlq \
  --region ap-northeast-1
```

原因解消後、DLQ → メインキュー戻し（AWS Console / `start-message-move-task`）

## 署名検証を有効化（セキュリティ推奨）

```bash
SLACK_SIGNING_SECRET=xxxxxxxx bash scripts/setup-ssm.sh
```

（Slack App > **Basic Information** > **Signing Secret** から取得）

## 設定可能な環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Claude モデル（コスト効率化） |
| `ANTHROPIC_API_KEY_PARAM` | `/claude-bot/ANTHROPIC_API_KEY` | SSM パラメータ名 |
| `SLACK_BOT_TOKEN_PARAM` | `/claude-bot/{AGENT_NAME^^}_BOT_TOKEN` | 各エージェント token SSM パラメータ |
| `AGENT_NAME` | N/A | エージェント役割（orchestrator/researcher/writer/reviewer） |

## 再デプロイ

コード変更後：

```bash
npm run package          # ビルド & lambda.zip 作成
bash scripts/deploy.sh   # AWS リソース更新
```

（idempotent — 既存リソースは更新、新規リソースは作成）

## ローカル検証

```bash
npm run typecheck        # 型チェック
npm run build            # esbuild バンドル
```

## マルチエージェント疎通テスト

デプロイ後、全エージェント processor が正常に動作することを確認：

```bash
npm run test:agents
```

このコマンドが実行すること：
1. 各エージェント SQS に test メッセージを送信
2. 10 秒待機（Lambda 実行待ち）
3. CloudWatch ログを確認して各プロセッサの実行状況を判定
4. 結果をサマリー表示

出力例：
```
✅ orchestrator — Lambda executed successfully
✅ researcher — Lambda executed successfully
✅ writer — Lambda executed successfully
✅ reviewer — Lambda executed successfully

Summary
  Passed: 4 / 4
  Failed: 0 / 4

✅ All agents are operational!
```

**トラブルシューティング**：
- `⚠️ Anthropic API key low on credits` → 本番環境では問題なし（テスト API key 残高不足）
- `⚠️ Slack channel test error` → 予期した動作（テスト用存在しないチャンネル ID）
- `❌ DynamoDB error` → IAM 権限確認：`bash scripts/deploy.sh` 再実行
- `❌ No log stream found` → Lambda がまだ初回実行していない（数分待機後に再試行）

## 今後の拡張

- **Web Search 統合**：researcher に Anthropic web_search tool
- **ファイル出力**：writer が S3 → PDF/Markdown 生成
- **承認フロー**：reviewer 「修正が必要」→ writer に自動差し戻し
- **複数チャンネル対応**：プロジェクト別専用チャンネル + 動的エージェント割り当て
- **Slack Workflow Builder 連携**：ボタン UI で特定エージェントチーム起動
