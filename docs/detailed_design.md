# マルチエージェント Slack Bot 詳細設計書

> 対象システム：claude-bot（マルチエージェント協調型レポート作成システム）
> 作成日：2026-06-11 ／ E2E 検証済み（task_id: pzqigl）
> 改訂：2026-06-12 共通エージェント化（エージェント定義を SSM/マニフェストへ分離）

---

## 1. 概要

Slack チャンネル上で人間が `@orchestrator` にレポート作成を依頼すると、
4つの Claude エージェント（orchestrator / researcher / writer / reviewer）が
メンションで連携しながら調査 → 執筆 → レビュー → 成果物提出までを自動実行する。

### 1.1 設計原則

| 原則 | 実装 |
|---|---|
| コードとエージェント定義の分離（共通エージェント化） | コードはエージェント名を一切ハードコードしない。一覧・ID・役割説明・メンション制限は SSM `AGENT_CONFIG`、役割プロンプトは SSM `/claude-bot/prompt/{agent}`。マスターは `prompts/agents.json`。**エージェント追加・プロンプト変更にコード修正・再デプロイ不要**（7.1 参照） |
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
| Lambda | `claude-bot-processor` | processor。handler `processor.handler`、timeout 900s（Web 検索ありの起動が完走できる長さ）、env `TASKS_TABLE`、batch size 1 |
| SQS | `claude-bot-queue` | VisibilityTimeout 960s（processor timeout 以上） |
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
2. 署名検証：AGENT_CONFIG の全エージェントの `signingSecretParam` が指す secret で試行し、1つでも一致すれば通す（エージェント数に自動追従）
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
  agent: string,        // AGENT_CONFIG のキー（例: 'orchestrator'）
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
   （Slack の3秒再送・SQS の at-least-once 配信の両方に対応）。
   **処理が失敗した場合はクレームを削除（解放）してから例外を再スロー**する —
   解放しないと SQS リトライが重複として破棄され、ジョブが静かに失われる
   （2026-06-12 に実際に発生し修正済み）
2. **タスク解決：** 本文の `[task_id:xxx]` → なければ `thread#` ポインタ → なければ新規作成
   （taskId は6文字英数。新規時の requester は送信者の userId）
3. **ホップガード：** `hops` をアトミックにインクリメント。`MAX_HOPS=16` 超過で停止
   （超過直後の1回だけ ⚠️ をスレッドに投稿し、以降は無言で破棄）。
   起動が失敗した場合はカウント済みホップを返却する（リトライの二重計上防止）
4. **プロンプト構築：** SSM `/claude-bot/prompt/{agent}` + 実行時情報（自分の名前・task_id・
   requester・日付）+ **チームのエージェント一覧**（AGENT_CONFIG の name と description から
   自動生成。新エージェントは既存プロンプトを書き換えなくても全員に認知される）を system に設定
5. **入力構築：** DynamoDB のタスク履歴（transcript）+ 今回の受信メッセージを user メッセージに
6. **tool use ループ：** 最大 `MAX_TOOL_ROUNDS=20` 回（Web 検索の `pause_turn` 再開も
   1ラウンド消費するため余裕を持たせている）。`stop_reason !== 'tool_use'` で終了。
   各ラウンド開始前に**タイムアウトウォッチドッグ**（残り60秒未満で自主中断 →
   クレーム解放 → SQS リトライ）が働き、ハードタイムアウトによるジョブ消失を防ぐ
7. **fallback 投稿：** ループ終了時に未送信の自由文が残っており、かつ mention 未使用なら
   スレッドへ投稿（応答が無言で消えるのを防ぐ）
8. **履歴永続化：** 受信メッセージ + 実行した全アクションを `appendHistory` で保存

### 3.3 ツール仕様

| ツール | 入力 | 動作 | コード側の制約 |
|---|---|---|---|
| `post_progress` | `text` | スレッドへ投稿。`[task_id:..]` 自動付与 | なし（複数回可） |
| `mention_agent` | `target`（agent名 or `requester`）、`text` | `<@userId> text [task_id:..]` をスレッドへ投稿。宛先候補（enum）は AGENT_CONFIG から動的生成 | **1起動につき1回**。AGENT_CONFIG の `mentionLimits` に設定されたペアは `mentions:{from}->{to}` カウンタで制限（例: orchestrator→writer = 3回。超過時はエラー文で最終版化を指示） |
| `upload_file` | `filename`、`content`、`comment?` | files.uploadV2 3段階フローで添付 | content は履歴保存時 20,000 字で切り詰め |
| `web_search`（サーバーサイド） | （Claude が自動制御） | Anthropic 側で Web 検索を実行し、引用付きで応答に組み込む。Lambda 側に実装なし | AGENT_CONFIG の `webSearch: true` のエージェントのみ付与（現在 researcher）。`max_uses=5`/起動。検索中断（`pause_turn`）は応答を積み直して自動再開 |

ツール実行エラーは例外を握りつぶし、エラーメッセージを `tool_result` として LLM に返す
（LLM がリカバリ判断できるようにする）。

### 3.4 ライブラリ（`src/lib/`）

| ファイル | 内容 |
|---|---|
| `config.ts` | AGENT_CONFIG（SSM）のロード、エージェント一覧（`agentNames`）、userId / botId 逆引き。エージェント名の固定リストは持たない |
| `slack.ts` | 署名検証（HMAC-SHA256 + 5分リプレイ防止 + timingSafeEqual）、`postMessage`、`uploadFile`（form-urlencoded → raw POST → completeUploadExternal、各段階で `ok` チェック） |
| `ssm.ts` | SecureString/String 取得。**TTL 60秒のキャッシュ**（プロンプト・AGENT_CONFIG の更新は再デプロイなしで約1分以内に反映される） |
| `store.ts` | DynamoDB 操作一式（下記 4章） |

---

## 4. データ設計（DynamoDB `claude-bot-tasks`）

単一テーブル・pk のみ。3種類のアイテムをプレフィックスで区別する。

| pk | 属性 | TTL | 用途 |
|---|---|---|---|
| `task#{taskId}` | taskId, channel, threadTs, requesterUserId, hops(N), `mentions:{from}->{to}`(N 動的), history(L) | 24h | タスク状態・ガードカウンタ・会話履歴 |
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
修正を依頼する。`mention_agent(writer)` 呼び出し時に `mentions:orchestrator->writer`
カウンタがインクリメントされ、**上限（`agents.json` の mentionLimits、現在3）の超過
= 4回目でツールがエラーを返す** → orchestrator はプロンプトの指示に従い
現状レポートを最終版として完了処理する。

修正1回あたり +4 ホップ（orch→writer→orch→reviewer→orch）。修正2回 + 正常系 = 最大15ホップ。
`MAX_HOPS=16` はこれに確認の問い返し等の揺らぎ分を加えた値（2026-06-12 に 10 から引き上げ。
10 では正常フロー + 問い返しで枯渇する事象が実際に発生した）。

### 5.3 不明点の確認（人間への質問）

エージェントが `mention_agent(requester)` で質問して終了 → 人間がスレッド内で
Bot にメンション付きで返信 → 本文に task_id がなくても `thread#` ポインタで
同一タスクとして再開され、履歴に質問までの経緯が含まれているため文脈が継続する。

### 5.4 ガード発動

| ガード | 発動条件 | 動作 |
|---|---|---|
| イベント重複 | 同一 `(channel, msgTs, agent)` の2回目以降 | 無言でスキップ |
| ホップ上限 | `hops > 16` | 17ホップ目のみ⚠️投稿、以降は無言破棄 |
| メンション回数上限 | `mentionLimits` 設定ペアの上限超過（例: orchestrator→writer 4回目） | ツールがエラー文を返し最終版化を誘導 |
| mention 多重 | 1起動内で `mention_agent` 2回目 | ツールがエラー文を返す（連鎖の分岐爆発防止）|
| 外部Bot | AGENT_CONFIG にない bot_id | receiver で破棄 |
| 処理失敗 | processor 例外 | イベントクレームを解放 + 消費ホップを返却 → SQS リトライ最大3回 → DLQ（14日保持）。リトライ時は進捗投稿が重複しうる（フロー停止よりは許容） |
| タイムアウト接近 | Lambda 残り時間 < 60秒 | tool ループを自主中断し、処理失敗と同じ経路（クレーム解放 → リトライ）へ |

---

## 6. 設定・シークレット（SSM Parameter Store）

エージェント定義のマスターは `prompts/agents.json`（マニフェスト）。
`setup-prompts.sh` がこれを読み、以下をエージェント数ぶん SSM に登録する。

| パラメータ | 型 | 内容 |
|---|---|---|
| `/claude-bot/prompt/{agent}` ×N | String (Intelligent-Tiering) | システムプロンプト。`prompts/{agent}.md` から登録 |
| `/claude-bot/AGENT_CONFIG` | String | `{agent: {userId, botId, botTokenParam, signingSecretParam, description?, mentionLimits?, webSearch?}}`。userId/botId は auth.test で実機解決、それ以外のメタ情報は `agents.json` から合成 |
| `/claude-bot/{AGENT}_BOT_TOKEN` ×N | SecureString | 各 Bot の xoxb トークン（assets の `{AGENT}_BOT_TOKEN.txt` から登録） |
| `/claude-bot/SIGNING_SECRET_{AGENT}` ×N | SecureString | 各アプリの signing secret（assets の `{AGENT}_SIGNING_SECRET.txt` から登録） |
| `/claude-bot/ANTHROPIC_API_KEY` | SecureString | Anthropic API キー |

モデルは processor の環境変数 `ANTHROPIC_MODEL`（デフォルト `claude-haiku-4-5-20251001`）。

### 6.1 Slack アプリ要件（全アプリ共通）

- Event Subscriptions：Request URL = `https://optkfpmo3a.execute-api.ap-northeast-1.amazonaws.com/prod/slack/events`、`app_mention` を購読
- OAuth Scopes：`app_mentions:read`、`chat:write`、`files:write`
- 全 Bot を対象チャンネルに招待しておくこと

---

## 7. 運用

| 操作 | コマンド |
|---|---|
| デプロイ（冪等） | `bash scripts/deploy.sh`（コード変更時のみ必要） |
| プロンプト更新 | `prompts/{agent}.md` 編集 → `bash scripts/setup-prompts.sh` → **約1分で全 Lambda に反映**（SSM キャッシュ TTL 60秒。再デプロイ不要） |
| エージェント追加 | 7.1 参照（コード変更・再デプロイ不要） |
| テスト | `npm test`（ユニット）、`npm run typecheck` |
| 連鎖の監視 | CloudWatch Logs `/aws/lambda/claude-bot-processor` の `[processor]` 行 |
| 詰まったタスクの調査 | DynamoDB `task#{taskId}` の history / hops、SQS DLQ |

### 7.1 エージェント追加手順（コード変更・再デプロイ不要）

例として `@translator` を追加する場合：

1. **Slack App を作成**（既存4アプリと同じ要件：6.1 参照）
   - Request URL を共通エンドポイントに設定し `app_mention` を購読、対象チャンネルへ招待
2. **認証情報を assets に配置**（リポジトリ外 `../multi-agent-slack-assets/`）
   - `TRANSLATOR_BOT_TOKEN.txt`（xoxb トークン）
   - `TRANSLATOR_SIGNING_SECRET.txt`（signing secret）
3. **役割プロンプトを作成**：`prompts/translator.md`
4. **マニフェストに1エントリ追加**：`prompts/agents.json`
   ```json
   "translator": {
     "description": "翻訳者。指示された文書を翻訳して提出する",
     "mentionLimits": {}
   }
   ```
5. **登録スクリプトを実行**：`bash scripts/setup-prompts.sh`
   - プロンプト・トークン・signing secret・AGENT_CONFIG（auth.test で ID 解決）が SSM に登録される

約1分後（SSM キャッシュ TTL 経過後）から、receiver は `@translator` 宛メンションを
ルーティングし、processor は translator として起動する。既存エージェントの
システムプロンプトには「チームのエージェント一覧」として translator が自動で
現れるため、orchestrator のプロンプトに工程として組み込みたい場合のみ
`prompts/orchestrator.md` を編集して再登録する。

## 8. 制限事項・今後の課題

1. ~~researcher は Web 検索不可~~ **解決済み（2026-06-12）**：Anthropic サーバーサイド Web 検索ツール（`web_search_20250305`）を導入。AGENT_CONFIG の `webSearch: true` で任意のエージェントに付与可能（現在 researcher のみ。検索は従量課金 $10/1,000回 + トークン）
2. **Slack 添付ファイルは読まない**（履歴で代替）。人間が添付したファイルを扱う場合は `files:read` + url_private ダウンロードの実装が必要
3. ~~修正2回を完走させる場合は MAX_HOPS の引き上げが必要~~ **解決済み（2026-06-12）**：MAX_HOPS=16 に引き上げ
4. 同一スレッドで複数タスクの並走は不可（thread# ポインタが1対1）
5. モデル・max_tokens は全エージェント共通（環境変数）。エージェント別に変えたい場合は AGENT_CONFIG への `model` 追加が必要
