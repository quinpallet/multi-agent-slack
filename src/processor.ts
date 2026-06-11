import Anthropic from '@anthropic-ai/sdk';
import type { SQSEvent } from 'aws-lambda';
import { getSecret } from './lib/ssm';
import { postMessage, uploadFile } from './lib/slack';
import { loadAgentConfig, AgentConfig, AgentName, AGENT_NAMES } from './lib/config';
import {
  claimEvent,
  getTask,
  createTask,
  findTaskIdByThread,
  bumpHops,
  bumpWriterMentions,
  appendHistory,
  TaskState,
  HistoryEntry,
} from './lib/store';
import type { AgentJob } from './receiver';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
const API_KEY_PARAM = '/claude-bot/ANTHROPIC_API_KEY';
const MAX_HOPS = 10;
const MAX_WRITER_MENTIONS = 3; // initial request + up to 2 revisions
const MAX_TOOL_ROUNDS = 10;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'post_progress',
    description:
      '作業工程リスト（📋）や工程完了通知（✅）など、進捗メッセージをSlackチャンネルのスレッドに投稿する。',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: '投稿するメッセージ本文' } },
      required: ['text'],
    },
  },
  {
    name: 'mention_agent',
    description:
      '他のエージェントまたは依頼者にメンション付きメッセージを送り、作業を引き継ぐ・報告する・質問する。1回の起動につき1回しか使えない。',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: [...AGENT_NAMES, 'requester'],
          description: '宛先。requester はタスクの依頼者（人間）',
        },
        text: { type: 'string', description: 'メンションに続けて送る本文' },
      },
      required: ['target', 'text'],
    },
  },
  {
    name: 'upload_file',
    description: '成果物を Markdown ファイルとしてSlackチャンネルのスレッドに添付する。',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '例: research_result.md' },
        content: { type: 'string', description: 'ファイルの中身（Markdown）' },
        comment: { type: 'string', description: '添付時に付けるコメント（任意）' },
      },
      required: ['filename', 'content'],
    },
  },
];

interface ToolContext {
  agent: AgentName;
  cfg: AgentConfig;
  botToken: string;
  task: TaskState;
  historyAdds: HistoryEntry[];
  mentionUsed: boolean;
}

async function runTool(ctx: ToolContext, name: string, input: any): Promise<string> {
  const { task } = ctx;
  const thread = { channel: task.channel, thread_ts: task.threadTs };

  if (name === 'post_progress') {
    const text = `${input.text}\n[task_id:${task.taskId}]`;
    await postMessage(ctx.botToken, { ...thread, text });
    ctx.historyAdds.push({ author: ctx.agent, text: input.text });
    return '投稿しました。';
  }

  if (name === 'mention_agent') {
    if (ctx.mentionUsed) {
      return 'エラー: mention_agent は1回の起動につき1回までです。今回の処理を終了してください。';
    }
    const target = String(input.target) as AgentName | 'requester';
    const userId = target === 'requester' ? task.requesterUserId : ctx.cfg[target]?.userId;
    if (!userId) {
      return `エラー: 宛先 ${target} が見つかりません。`;
    }
    if (ctx.agent === 'orchestrator' && target === 'writer') {
      const count = await bumpWriterMentions(task.taskId);
      if (count > MAX_WRITER_MENTIONS) {
        return 'エラー: 修正依頼の上限（2回）に達しました。writer への依頼はできません。現状のレポートを最終版として upload_file で提出し、requester に完了報告してください。';
      }
    }
    const text = `<@${userId}> ${input.text}\n[task_id:${task.taskId}]`;
    await postMessage(ctx.botToken, { ...thread, text });
    ctx.mentionUsed = true;
    ctx.historyAdds.push({ author: ctx.agent, text: `（${target} 宛メンション）${input.text}` });
    return `${target} にメンションを送信しました。`;
  }

  if (name === 'upload_file') {
    const comment = input.comment ? `${input.comment}\n[task_id:${task.taskId}]` : `[task_id:${task.taskId}]`;
    await uploadFile(ctx.botToken, {
      channel: task.channel,
      threadTs: task.threadTs,
      filename: String(input.filename),
      content: String(input.content),
      initialComment: comment,
    });
    ctx.historyAdds.push({
      author: ctx.agent,
      text: `（ファイル添付 ${input.filename}）\n${input.content}`,
    });
    return `${input.filename} を添付しました。`;
  }

  return `エラー: 不明なツール ${name}`;
}

function renderTranscript(task: TaskState): string {
  const history = task.history ?? [];
  if (history.length === 0) return '（履歴なし。これがこのタスクの最初のメッセージです）';
  return history.map((e) => `【${e.author}】\n${e.text}`).join('\n\n');
}

async function processJob(job: AgentJob): Promise<void> {
  const eventKey = `${job.channel}:${job.msgTs}:${job.agent}`;
  if (!(await claimEvent(eventKey))) {
    console.info(`[processor] duplicate delivery skipped: ${eventKey}`);
    return;
  }

  const [cfg, apiKey] = await Promise.all([loadAgentConfig(), getSecret(API_KEY_PARAM)]);
  const botToken = await getSecret(cfg[job.agent].botTokenParam);
  if (!botToken || !apiKey) throw new Error('Missing credentials');

  // Resolve the task: explicit [task_id:...] tag -> thread pointer -> new task.
  let taskId = job.text.match(/\[task_id:([^\]]+)\]/)?.[1];
  if (!taskId) taskId = await findTaskIdByThread(job.channel, job.threadTs);
  let task = taskId ? await getTask(taskId) : undefined;
  if (!task) {
    taskId = taskId ?? Math.random().toString(36).slice(2, 8);
    task = await createTask({
      taskId,
      channel: job.channel,
      threadTs: job.threadTs,
      requesterUserId: job.senderUserId ?? '',
    });
  }

  const hops = await bumpHops(task.taskId);
  if (hops > MAX_HOPS) {
    console.warn(`[processor] task ${task.taskId} exceeded MAX_HOPS(${MAX_HOPS})`);
    if (hops === MAX_HOPS + 1) {
      await postMessage(botToken, {
        channel: task.channel,
        thread_ts: task.threadTs,
        text: `⚠️ エージェント間のやり取りが上限（${MAX_HOPS}ホップ）に達したため、このタスクを停止します。[task_id:${task.taskId}]`,
      });
    }
    return;
  }

  const promptParam = `/claude-bot/prompt/${job.agent}`;
  const rolePrompt = await getSecret(promptParam);
  if (!rolePrompt) throw new Error(`SSM parameter ${promptParam} is empty`);

  const senderLabel = job.senderAgent ?? (job.senderUserId ? `依頼者 <@${job.senderUserId}>` : '不明');
  const system = `${rolePrompt}

【実行時情報】
- あなたのエージェント名: ${job.agent}
- task_id: ${task.taskId}（投稿への付与はシステムが自動で行うため、本文に書く必要はない）
- 依頼者（人間）の UserID: ${task.requesterUserId || '不明'}
- 今日の日付: ${new Date().toISOString().slice(0, 10)}`;

  const inbound = `これまでのタスクの経緯:
${renderTranscript(task)}

---
今回あなた宛に届いたメッセージ（送信者: ${senderLabel}）:
${job.text}

---
あなたの役割とルールに従い、ツールを使って処理を実行してください。`;

  const anthropic = new Anthropic({ apiKey });
  const ctx: ToolContext = {
    agent: job.agent,
    cfg,
    botToken,
    task,
    historyAdds: [{ author: job.senderAgent ?? 'user', text: job.text }],
    mentionUsed: false,
  };

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: inbound }];
  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system,
      messages,
      tools: TOOLS,
    });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let result: string;
      try {
        result = await runTool(ctx, tu.name, tu.input);
      } catch (err: any) {
        console.error(`[processor] tool ${tu.name} failed:`, err);
        result = `エラー: ツール実行に失敗しました（${err?.message ?? err}）`;
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }

  // Any trailing free text that wasn't delivered via tools goes to the thread.
  if (finalText.trim() && !ctx.mentionUsed) {
    await postMessage(botToken, {
      channel: task.channel,
      thread_ts: task.threadTs,
      text: `${finalText}\n[task_id:${task.taskId}]`,
    });
    ctx.historyAdds.push({ author: job.agent, text: finalText });
  }

  await appendHistory(task.taskId, ctx.historyAdds);
  console.log(`[processor] ${job.agent} finished task ${task.taskId} (hops=${hops})`);
}

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    const job = JSON.parse(record.body) as AgentJob;
    console.log('[processor] job received', {
      agent: job.agent,
      channel: job.channel,
      msgTs: job.msgTs,
    });
    await processJob(job);
  }
};
