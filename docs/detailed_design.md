# マルチエージェント Slack Bot 詳細設計書

> 対象システム：claude-bot（4エージェント協調型レポート作成システム）
> 作成日：2026-06-11 ／ E2E 検証済み（task_id: pzqigl）

---

## 1. 概要

Slack チャンネル上で人間が `@orchestrator` にレポート作成を依頼すると、
4つの Claude エージェント（orchestrator / researcher / writer / reviewer）が
メンションで連携しながら調査 → 執筆 → レビュー → 成果物提出までを自動実行する。

### 1.1 設計原則

| 原則 | 実装 |
|---|---|
| LLM への指示とコードによる保証を分離 | ループ防止・回数制限・重複排除はすべてコード（DynamoDB）で強制。プロンプトは「振る舞いの期待」のみ記述 |
| エージェントの行動はすべてツール経由 | Anthropic tool use（`post_progress` / `mention_agent` / `upload_file`）。LLM の自由文がそのまま Slack に流れるのは fallback のみ |
| イベント駆動・ステートレス | 各エージェントはメンション受信ごとに起動し「次の1手」のみ実行。文脈は DynamoDB のタスク履歴で引き継ぐ |
| 冪等デプロイ | `deploy.sh` は何度実行しても安全 |

### 1.2 検証済みの前提（2026-06-11 実機確認）

- Bot 発のメッセージでも、メンションされた Bot アプリに `app_mention` イベントが配信される（チャンネル内・約3秒）
- `files.getUploadURLExternal` は JSON ボディ不可。form-urlencoded のみ受け付ける

---

## 2. システム構成

```
                         Slack ワークスペース
   ┌──────────────────────────────────────────────────────────┐
   │  4つの Slack App（共通 Request URL）                       │
   │  @orchestrator  @researcher  @writer  @reviewer            │
   └──────────────┬───────────────────────────▲────────────────┘
                  │ app_mention               │ chat.postMessage(thread)
                  ▼                           │ files.uploadV2
   ┌─────────────────────────┐                │
   │ API Gateway (HTTP API)  │                │
   │ claude-bot-api          │                │
   └──────────┬──────────────┘                │
              ▼                               │
   ┌───────────────────────────────┐          │
   │ receiver（Lambda:             │          │
   │   claude-bot-handler）        │          │
   │ ・署名検証（4 secrets）        │          │
   │ ・Bot許可リスト判定            │          │
   │ ・メンション先→ジョブ振り分け  │          │
   └──────────┬────────────────────┘          │
              ▼                               │
   ┌─────────────────────────────┐            │
   │ SQS claude-bot-queue        │            │
   │ （+ claude-bot-dlq, 3回で退避）│           │
   └──────────┬──────────────────┘            │
              ▼                               │
   ┌──────────────────────────────────────────┴───┐
   │ processor（Lambda: claude-bot-processor）     │
   │  Anthropic Messages API（tool use ループ）     │
   │   ├ post_progress  → 工程リスト/完了通知       │
   │   ├ mention_agent  → 次エージェントへ依頼      │
   │   └ upload_file    → files.uploadV2           │
   └───┬──────────────────────┬────────────────────┘
       ▼                      ▼
   ┌────────────────┐   ┌──────────────────────────┐
   │ SSM Parameter  │   │ DynamoDB claude-bot-tasks │
   │ Store          │   │  task# / thread# / event# │
   └────────────────┘   └──────────────────────────┘
```

### 2.1 AWS リソース一覧

| リソース | 名前 | 備考 |
|---|---|---|
| Lambda | `claude-bot-handler` | receiver。handler `receiver.handler`、timeout 30s、env `QUEUE_URL` |
| Lambda | `claude-bot-processor` | processor。handler `processor.handler`、timeout 300s、env `TASKS_TABLE`、batch size 1 |
| SQS | `claude-bot-queue` | VisibilityTimeout 360s（processor timeout 以上） |
| SQS | `claude-bot-dlq` | maxReceiveCount 3 で退避、保持14日 |
| DynamoDB | `claude-bot-tasks` | pk(S) のみ、On-Demand、TTL属性 `ttl` |
| API Gateway | `claude-bot-api` | HTTP API。`/prod/slack/events` → receiver |
| IAM | `claude-bot-role` | Lambda基本実行 + SSM読取 + SQS/DynamoDB（インラインポリシー） |

> ⚠️ Lambda に顧客管理 KMS キーを設定しないこと。削除済みキーの暗号化残骸が残ると
> ログも出ずに起動失敗する（2026-06-11 に発生。関数の削除・再作成でのみ復旧可能）。

---

## 3. コンポーネント詳細

### 3.1 receiver（`src/receiver.ts`）

**責務：** Slack イベントの受付・検証・SQS への振り分け。3秒以内に 200 を返す。

処理フロー：

1. `url_verification` → challenge をそのまま返す（署名検証より先）
2. 署名検証：4アプリの signing secret（SSM）すべてで試行し、1つでも一致すれば通す
3. `app_mention` 以外のイベント → 200 で終了
4. **送信者判定：**
   - `event.bot_id` あり → AGENT_CONFIG の botId と照合。許可リスト外の Bot は無視（外部Botとのループ防止）
   - `event.bot_id` なし → 人間（`event.user`）
5. **宛先解決：** 本文の `<@Uxxxx>` をすべて抽出し、AGENT_CONFIG の userId と突合。
   送信者自身は除外（自己メンションループ防止）
6. 宛先エージェントごとに `AgentJob` を SQS へ送信

`AgentJob` スキーマ（SQS メッセージボディ）：

```typescript
{
  agent: 'orchestrator' | 'researcher' | 'writer' | 'reviewer',
  channel: string,      // 投稿チャンネル
  threadTs: string,     // スレッド親 ts（thread_ts ?? ts）
  msgTs: string,        // このメッセージの ts（重複排除キーの一部）
  text: string,         // メッセージ本文
  senderUserId?: string,   // 人間発の場合のみ
  senderAgent?: AgentName, // Bot発の場合のみ
  eventId?: string
}
```

### 3.2 processor（`src/processor.ts`）

**責務：** エージェント1回分の思考と行動（tool use ループ）の実行。

処理フロー：

1. **重複排除：** `event#{channel}:{msgTs}:{agent}` を条件付き Put。既存なら即終了
   （Slack の3秒再送・SQS の at-least-once 配信の両方に対応）
2. **タスク解決：** 本文の `[task_id:xxx]` → なければ `thread#` ポインタ → なければ新規作成
   （taskId は6文字英数。新規時の requester は送信者の userId）
3. **ホップガード：** `hops` をアトミックにインクリメント。`MAX_HOPS=10` 超過で停止
   （超過直後の1回だけ ⚠️ をスレッドに投稿し、以降は無言で破棄）
4. **プロンプト構築：** SSM `/claude-bot/prompt/{agent}` + 実行時情報（自分の名前・task_id・
   requester・日付）を system に設定
5. **入力構築：** DynamoDB のタスク履歴（transcript）+ 今回の受信メッセージを user メッセージに
6. **tool use ループ：** 最大 `MAX_TOOL_ROUNDS=10` 回。`stop_reason !== 'tool_use'` で終了
7. **fallback 投稿：** ループ終了時に未送信の自由文が残っており、かつ mention 未使用なら
   スレッドへ投稿（応答が無言で消えるのを防ぐ）
8. **履歴永続化：** 受信メッセージ + 実行した全アクションを `appendHistory` で保存

### 3.3 ツール仕様

| ツール | 入力 | 動作 | コード側の制約 |
|---|---|---|---|
| `post_progress` | `text` | スレッドへ投稿。`[task_id:..]` 自動付与 | なし（複数回可） |
| `mention_agent` | `target`（agent名 or `requester`）、`text` | `<@userId> text [task_id:..]` をスレッドへ投稿 | **1起動につき1回**。orchestrator→writer は `writerMentions` をインクリメントし **3回超（初回+修正2回）で拒否**（エラー文で最終版化を指示） |
| `upload_file` | `filename`、`content`、`comment?` | files.uploadV2 3段階フローで添付 | content は履歴保存時 20,000 字で切り詰め |

ツール実行エラーは例外を握りつぶし、エラーメッセージを `tool_result` として LLM に返す
（LLM がリカバリ判断できるようにする）。

### 3.4 ライブラリ（`src/lib/`）

| ファイル | 内容 |
|---|---|
| `config.ts` | AGENT_CONFIG（SSM）のロードと userId / botId 逆引き |
| `slack.ts` | 署名検証（HMAC-SHA256 + 5分リプレイ防止 + timingSafeEqual）、`postMessage`、`uploadFile`（form-urlencoded → raw POST → completeUploadExternal、各段階で `ok` チェック） |
| `ssm.ts` | SecureString/String 取得。コンテナ生存中の無期限キャッシュ（プロンプト更新はコールドスタートまで反映されない点に注意） |
| `store.ts` | DynamoDB 操作一式（下記 4章） |

---

## 4. データ設計（DynamoDB `claude-bot-tasks`）

単一テーブル・pk のみ。3種類のアイテムをプレフィックスで区別する。

| pk | 属性 | TTL | 用途 |
|---|---|---|---|
| `task#{taskId}` | taskId, channel, threadTs, requesterUserId, hops(N), writerMentions(N), history(L) | 24h | タスク状態・ガードカウンタ・会話履歴 |
| `thread#{channel}:{threadTs}` | taskId | 24h | task_id なしメッセージ（人間の返信等）のタスク逆引き |
| `event#{channel}:{msgTs}:{agent}` | なし | 6h | 受信イベントの重複排除（条件付き Put） |

履歴（history）の設計：

- エントリ：`{ author: string, text: string }`。author はエージェント名 or `user`
- 1エントリ最大 20,000 字（超過分は切り詰め）、全体最大 60 エントリ（古い順に削除）
  → 400KB アイテム上限への対策
- **ファイル添付の内容も履歴に保存**する。これにより次のエージェントは Slack の
  添付ファイルを読みに行かずに全文脈を取得できる（`files:read` 不要）

---

## 5. シーケンス

### 5.1 正常系（修正なし・実測7ホップ）

```
人間 ──@orchestrator 依頼──► receiver ──► SQS ──► processor(orchestrator) hops=1
  orchestrator: 📋工程リスト → mention researcher
    └─Slack→receiver→SQS→ processor(researcher) hops=2
        researcher: 📋調査工程 → ✅×N → 📎research_result.md → mention orchestrator
          └─► processor(orchestrator) hops=3
              orchestrator: ✅調査完了 → mention writer
                └─► processor(writer) hops=4
                    writer: 📋執筆工程 → ✅×3 → 📎report_draft.md → mention orchestrator
                      └─► processor(orchestrator) hops=5
                          orchestrator: ✅執筆完了 → mention reviewer
                            └─► processor(reviewer) hops=6
                                reviewer: 📋レビュー工程 → ✅×5 → 📎review_result.md
                                  → mention orchestrator「[judge:approved]」
                                  └─► processor(orchestrator) hops=7
                                      orchestrator: ✅全工程完了 → 📎final_report.md
                                        → mention requester（完了通知）   ※連鎖終了
```

### 5.2 要修正分岐

reviewer のメンションに `[judge:needs_fix]` が含まれる場合、orchestrator は writer に
修正を依頼する。`mention_agent(writer)` 呼び出し時に `writerMentions` がインクリメントされ、
**4回目（=3回目の修正依頼）でツールがエラーを返す** → orchestrator はプロンプトの指示に従い
現状レポートを最終版として完了処理する。

修正1回あたり +4 ホップ（orch→writer→orch→reviewer→orch）。修正2回 + 正常系 = 最大15ホップ
となるが `MAX_HOPS=10` が先に効くため、**修正2回を完走させたい場合は MAX_HOPS=16 への
引き上げを検討**（現状は安全側に倒している）。

### 5.3 不明点の確認（人間への質問）

エージェントが `mention_agent(requester)` で質問して終了 → 人間がスレッド内で
Bot にメンション付きで返信 → 本文に task_id がなくても `thread#` ポインタで
同一タスクとして再開され、履歴に質問までの経緯が含まれているため文脈が継続する。

### 5.4 ガード発動

| ガード | 発動条件 | 動作 |
|---|---|---|
| イベント重複 | 同一 `(channel, msgTs, agent)` の2回目以降 | 無言でスキップ |
| ホップ上限 | `hops > 10` | 11ホップ目のみ⚠️投稿、以降は無言破棄 |
| 修正回数上限 | orchestrator→writer メンション4回目 | ツールがエラー文を返し最終版化を誘導 |
| mention 多重 | 1起動内で `mention_agent` 2回目 | ツールがエラー文を返す（連鎖の分岐爆発防止）|
| 外部Bot | AGENT_CONFIG にない bot_id | receiver で破棄 |
| 処理失敗 | processor 例外 | SQS リトライ最大3回 → DLQ（14日保持）|

---

## 6. 設定・シークレット（SSM Parameter Store）

| パラメータ | 型 | 内容 |
|---|---|---|
| `/claude-bot/prompt/{agent}` ×4 | String (Intelligent-Tiering) | システムプロンプト。`prompts/*.md` から `setup-prompts.sh` で登録 |
| `/claude-bot/AGENT_CONFIG` | String | `{agent: {userId, botId, botTokenParam}}`。`setup-prompts.sh` が auth.test で botId を解決して自動生成 |
| `/claude-bot/{AGENT}_BOT_TOKEN` ×4 | SecureString | 各 Bot の xoxb トークン |
| `/claude-bot/SIGNING_SECRET_{AGENT}` ×4 | SecureString | 各アプリの signing secret |
| `/claude-bot/ANTHROPIC_API_KEY` | SecureString | Anthropic API キー |

モデルは processor の環境変数 `ANTHROPIC_MODEL`（デフォルト `claude-haiku-4-5-20251001`）。

### 6.1 Slack アプリ要件（4アプリ共通）

- Event Subscriptions：Request URL = `https://optkfpmo3a.execute-api.ap-northeast-1.amazonaws.com/prod/slack/events`、`app_mention` を購読
- OAuth Scopes：`app_mentions:read`、`chat:write`、`files:write`
- 4 Bot 全員を対象チャンネルに招待しておくこと

---

## 7. 運用

| 操作 | コマンド |
|---|---|
| デプロイ（冪等） | `bash scripts/deploy.sh` |
| プロンプト更新 | `prompts/*.md` 編集 → `bash scripts/setup-prompts.sh`（※ウォームコンテナには反映されない。確実に反映するには processor を再デプロイ） |
| テスト | `npm test`（ユニット）、`npm run typecheck` |
| 連鎖の監視 | CloudWatch Logs `/aws/lambda/claude-bot-processor` の `[processor]` 行 |
| 詰まったタスクの調査 | DynamoDB `task#{taskId}` の history / hops、SQS DLQ |

## 8. 制限事項・今後の課題

1. **researcher は Web 検索不可**（モデル知識のみ）。Anthropic の web search ツール追加で解決可能
2. **Slack 添付ファイルは読まない**（履歴で代替）。人間が添付したファイルを扱う場合は `files:read` + url_private ダウンロードの実装が必要
3. **SSM キャッシュは無期限**。プロンプト即時反映が必要なら TTL 付きキャッシュへ変更
4. 修正2回を完走させる場合は `MAX_HOPS` の引き上げが必要（5.2 参照）
5. 同一スレッドで複数タスクの並走は不可（thread# ポインタが1対1）
