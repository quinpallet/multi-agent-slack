import Anthropic from '@anthropic-ai/sdk';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { getSecret } from './lib/ssm';
import { postMessage } from './lib/slack';

const dynamo = new DynamoDBClient({});
const AGENT_NAME = process.env.AGENT_NAME ?? 'orchestrator';
const BOT_TOKEN_PARAM = process.env.SLACK_BOT_TOKEN_PARAM ?? '/claude-bot/SLACK_BOT_TOKEN';
const API_KEY_PARAM = process.env.ANTHROPIC_API_KEY_PARAM ?? '/claude-bot/ANTHROPIC_API_KEY';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
const MAX_HOPS = 10;

const SYSTEM_PROMPTS: Record<string, string> = {
  orchestrator: `あなたは優秀なプロジェクトマネージャーです。
ユーザーから依頼されたタスクを分析し、researcher/writer/reviewer に適切に割り振ります。
各エージェントへの指示は必ず [task_id:{id}] タグを含めてください。
全エージェントの結果が揃ったら最終回答をユーザーに返してください。`,

  researcher: `あなたは優秀なリサーチャーです。
与えられたトピックについて調査し、重要な事実・データ・最新情報を箇条書きで返します。
回答の末尾に必ず [task_id:{id}] タグを含めて orchestrator に返信してください。`,

  writer: `あなたは優秀なライターです。
与えられた情報を読みやすい文章・レポート形式に整形します。
回答の末尾に必ず [task_id:{id}] タグを含めて orchestrator に返信してください。`,

  reviewer: `あなたは優秀なレビュアーです。
与えられた文章を確認し、誤り・改善点・追加すべき情報を指摘します。
問題がなければ「承認」と返答してください。
回答の末尾に必ず [task_id:{id}] タグを含めて orchestrator に返信してください。`,
};

async function checkAndIncrementHops(taskId: string): Promise<boolean> {
  try {
    const res = await dynamo.send(
      new GetItemCommand({
        TableName: 'claude-bot-tasks',
        Key: { taskId: { S: taskId } },
      }),
    );
    const hops = parseInt(res.Item?.hops?.N ?? '0');
    if (hops >= MAX_HOPS) {
      console.warn(`Task ${taskId} exceeded MAX_HOPS(${MAX_HOPS}). Stopping.`);
      return false;
    }
    await dynamo.send(
      new PutItemCommand({
        TableName: 'claude-bot-tasks',
        Item: {
          taskId: { S: taskId },
          hops: { N: String(hops + 1) },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 3600) },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error('DynamoDB error:', err);
    return true;
  }
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const [botToken, apiKey] = await Promise.all([
    getSecret(BOT_TOKEN_PARAM),
    getSecret(API_KEY_PARAM),
  ]);

  const anthropic = new Anthropic({ apiKey });

  for (const record of event.Records) {
    const slackEvent = JSON.parse(record.body);
    const userMessage = String(slackEvent.text ?? '')
      .replace(/<@[^>]+>/g, '')
      .trim();
    const channel: string = slackEvent.channel;
    const requesterId: string | undefined = slackEvent.user;
    const threadTs = slackEvent.thread_ts ?? slackEvent.ts;

    const taskIdMatch = userMessage.match(/\[task_id:([^\]]+)\]/);
    const taskId = taskIdMatch?.[1] ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const canProceed = await checkAndIncrementHops(taskId);
    if (!canProceed) {
      const mention = requesterId ? `<@${requesterId}> ` : '';
      await postMessage(botToken, {
        channel,
        thread_ts: threadTs,
        text: `${mention}⚠️ タスク ${taskId} が最大処理回数を超えました。処理を中止します。`,
      });
      continue;
    }

    const systemPrompt = SYSTEM_PROMPTS[AGENT_NAME] ?? 'あなたは親切なアシスタントです。';
    const finalSystemPrompt = systemPrompt.replace(/{id}/g, taskId);

    let reply: string;
    try {
      const response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        system: finalSystemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      const textBlock = response.content.find(b => b.type === 'text');
      reply = textBlock?.type === 'text' ? textBlock.text : '処理できませんでした。';
    } catch (err) {
      console.error('Anthropic API error:', err);
      reply = '申し訳ありません。処理中にエラーが発生しました。';
    }

    const mention = requesterId ? `<@${requesterId}> ` : '';
    await postMessage(botToken, {
      channel,
      thread_ts: threadTs,
      text: `${mention}${reply}`,
    });
  }
};
