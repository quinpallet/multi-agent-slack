// =============================================================================
// store.ts — タスク状態の永続化（DynamoDB シングルテーブル設計）
//
// 1テーブル（claude-bot-tasks）に pk のプレフィックスで3種類のアイテムを格納する：
//   task#<taskId>            : タスク本体（カウンタ・会話履歴を含む）
//   thread#<channel>:<ts>    : スレッド → taskId の逆引きポインタ
//   event#<eventKey>         : 処理済みイベントの記録（重複排除用）
// すべて TTL 付きで自動消滅するため、運用上のクリーンアップ作業は不要。
// =============================================================================
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TASKS_TABLE ?? 'claude-bot-tasks';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

/** タスク履歴の1エントリ（発言者 + 本文。ファイル添付は本文に内容ごと記録） */
export interface HistoryEntry {
  author: string;
  text: string;
}

export interface TaskState {
  pk: string;
  taskId: string;
  channel: string;
  /** タスクの全やり取りがぶら下がるスレッドの親 ts */
  threadTs: string;
  /** タスクを依頼した人間の UserID（完了報告の宛先になる） */
  requesterUserId: string;
  /** エージェント起動の累計回数（MAX_HOPS ガードの判定値） */
  hops: number;
  /** タスク全体の会話履歴。エージェント間の唯一の文脈共有手段 */
  history?: HistoryEntry[];
  // このほか「mentions:<from>-><to>」という動的属性でエージェント間の
  // メンション回数カウンタを持つ（bumpMentionCount が ADD で自動生成する）
}

/**
 * イベントの処理権を獲得する（重複排除）。
 * 条件付き Put の「先勝ち」により、Slack の再送や SQS の重複配信で
 * 同じイベントが並行して届いても、処理されるのは必ず1回だけになる。
 * 既に他の実行が獲得済みの場合は false を返す。
 */
export async function claimEvent(eventKey: string): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        // TTL 6時間：Slack の再送猶予を十分にカバーしつつテーブル肥大を防ぐ
        Item: { pk: `event#${eventKey}`, ttl: nowSec() + 6 * HOUR },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/**
 * イベントのクレーム（処理権）を解放する。
 * claimEvent で処理権を取った後に処理が失敗（例外・タイムアウト接近）した場合、
 * クレームを残したままだと SQS のリトライ配信が「重複」として破棄され、
 * ジョブが静かに失われてフローが止まる。失敗時は必ずこれで解放してから
 * 例外を再スローし、リトライに処理権を譲る。
 */
export async function releaseEvent(eventKey: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `event#${eventKey}` } }));
}

export async function getTask(taskId: string): Promise<TaskState | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: `task#${taskId}` } }));
  return res.Item as TaskState | undefined;
}

/**
 * 新規タスクを作成する（人間からの最初の依頼時に呼ばれる）。
 * タスク本体と同時にスレッドポインタも作成し、以降同じスレッドへの発言が
 * [task_id:...] タグなしでも同一タスクに紐付くようにする。
 * TTL 24時間：それを超えて続くタスクは異常系とみなし自然消滅させる。
 */
export async function createTask(args: {
  taskId: string;
  channel: string;
  threadTs: string;
  requesterUserId: string;
}): Promise<TaskState> {
  const task: TaskState = {
    pk: `task#${args.taskId}`,
    taskId: args.taskId,
    channel: args.channel,
    threadTs: args.threadTs,
    requesterUserId: args.requesterUserId,
    hops: 0,
    history: [],
  };
  await doc.send(new PutCommand({ TableName: TABLE, Item: { ...task, ttl: nowSec() + 24 * HOUR } }));
  // スレッド → taskId の逆引きポインタ
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `thread#${args.channel}:${args.threadTs}`,
        taskId: args.taskId,
        ttl: nowSec() + 24 * HOUR,
      },
    }),
  );
  return task;
}

/** スレッドの親 ts から所属タスクを逆引きする（タグなし発言のタスク特定用） */
export async function findTaskIdByThread(channel: string, threadTs: string): Promise<string | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE, Key: { pk: `thread#${channel}:${threadTs}` } }),
  );
  return res.Item?.taskId as string | undefined;
}

/**
 * カウンタをアトミックに増減して更新後の値を返す。
 * DynamoDB の ADD 式を使うことで、複数エージェントが同時に起動しても
 * 取りこぼしなく正確にカウントされる（read-modify-write の競合が起きない）。
 */
async function addToCounter(taskId: string, attr: string, delta: number): Promise<number> {
  const res = await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `task#${taskId}` },
      UpdateExpression: 'ADD #a :d',
      ExpressionAttributeNames: { '#a': attr },
      ExpressionAttributeValues: { ':d': delta },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(res.Attributes?.[attr] ?? 0);
}

/** 互換用エイリアス（+1 専用） */
const bumpCounter = (taskId: string, attr: string) => addToCounter(taskId, attr, 1);

/** ホップ数（エージェント起動回数）を+1。戻り値が MAX_HOPS 超過なら処理を止める */
export const bumpHops = (taskId: string) => bumpCounter(taskId, 'hops');

/**
 * ホップ数を-1する（失敗ターンの返却用）。
 * 起動が失敗して SQS リトライに回る場合、bumpHops 済みのカウントを返却しないと
 * 「失敗1回 + リトライ1回」で2ホップ消費してしまい、上限到達が早まる。
 */
export const decrementHops = (taskId: string) => addToCounter(taskId, 'hops', -1);

/**
 * エージェント間メンション回数を+1して新しい値を返す。
 * 「誰から誰へ」のペアごとに独立したカウンタを持つため、AGENT_CONFIG の
 * mentionLimits に任意のペアの上限を設定するだけで回数制限を追加できる
 * （例: orchestrator→writer の修正依頼制限）。コード変更は不要。
 */
export const bumpMentionCount = (taskId: string, from: string, to: string) =>
  bumpCounter(taskId, `mentions:${from}->${to}`);

// 履歴の上限。DynamoDB のアイテム上限 400KB を超えないための安全弁
const MAX_HISTORY_ENTRIES = 60;
const MAX_ENTRY_CHARS = 20000;

/**
 * タスク履歴にエントリを追記する。
 * 1エントリ20,000文字でトリム（巨大な成果物ファイルでアイテムが膨張するのを防止）し、
 * 全体が60件を超えたら古いものから切り捨てる（直近の文脈を優先して残す）。
 */
export async function appendHistory(taskId: string, entries: HistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const trimmed = entries.map((e) => ({
    author: e.author,
    text: e.text.length > MAX_ENTRY_CHARS ? `${e.text.slice(0, MAX_ENTRY_CHARS)}\n…（長文のため省略）` : e.text,
  }));
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `task#${taskId}` },
      UpdateExpression: 'SET history = list_append(if_not_exists(history, :empty), :e)',
      ExpressionAttributeValues: { ':e': trimmed, ':empty': [] },
    }),
  );
  // 件数上限チェック。超過時は直近 MAX_HISTORY_ENTRIES 件だけ残して上書きする
  const task = await getTask(taskId);
  const history = task?.history ?? [];
  if (history.length > MAX_HISTORY_ENTRIES) {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `task#${taskId}` },
        UpdateExpression: 'SET history = :h',
        ExpressionAttributeValues: { ':h': history.slice(history.length - MAX_HISTORY_ENTRIES) },
      }),
    );
  }
}
