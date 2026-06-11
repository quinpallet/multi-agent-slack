import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TASKS_TABLE ?? 'claude-bot-tasks';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

export interface HistoryEntry {
  author: string;
  text: string;
}

export interface TaskState {
  pk: string;
  taskId: string;
  channel: string;
  threadTs: string;
  requesterUserId: string;
  hops: number;
  writerMentions: number;
  history?: HistoryEntry[];
}

/**
 * Claim an inbound event for processing. Returns false if another invocation
 * (e.g. a Slack retry delivery) already claimed the same event.
 */
export async function claimEvent(eventKey: string): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE,
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

export async function getTask(taskId: string): Promise<TaskState | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: `task#${taskId}` } }));
  return res.Item as TaskState | undefined;
}

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
    writerMentions: 0,
    history: [],
  };
  await doc.send(new PutCommand({ TableName: TABLE, Item: { ...task, ttl: nowSec() + 24 * HOUR } }));
  // Thread pointer so follow-up messages without [task_id:...] still find the task.
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

export async function findTaskIdByThread(channel: string, threadTs: string): Promise<string | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE, Key: { pk: `thread#${channel}:${threadTs}` } }),
  );
  return res.Item?.taskId as string | undefined;
}

async function bumpCounter(taskId: string, attr: 'hops' | 'writerMentions'): Promise<number> {
  const res = await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `task#${taskId}` },
      UpdateExpression: 'ADD #a :one',
      ExpressionAttributeNames: { '#a': attr },
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(res.Attributes?.[attr] ?? 0);
}

/** Atomically increment the task hop count; returns the new value. */
export const bumpHops = (taskId: string) => bumpCounter(taskId, 'hops');

/** Atomically count orchestrator->writer mentions (initial request + revisions). */
export const bumpWriterMentions = (taskId: string) => bumpCounter(taskId, 'writerMentions');

const MAX_HISTORY_ENTRIES = 60;
const MAX_ENTRY_CHARS = 20000;

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
  // Cap total history length to stay well under the 400KB item limit.
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
