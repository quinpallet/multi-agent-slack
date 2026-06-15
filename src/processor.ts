// =============================================================================
// processor.ts — 共通エージェント実行 Lambda（SQS トリガー）
//
// receiver が積んだジョブを受け取り、担当エージェントとして Claude を起動する。
// この Lambda は全エージェント共通で1つ：どのエージェントとして動くかは
// SQS メッセージ内の agent フィールドで決まり、役割の違いは
// SSM 上のプロンプト（/claude-bot/prompt/{agent}）だけで表現される。
// つまり「コード = 共通の実行基盤」「プロンプト = エージェント個性」と分離されており、
// プロンプトの変更・エージェントの追加にコード修正は不要。
//
// エージェントの振る舞いは二層で制御する：
//   - LLM 指示  : 役割・口調・作業手順（SSM プロンプト。破られる可能性がある）
//   - コード強制: ホップ上限・メンション回数上限・イベント重複排除（絶対に破られない）
// =============================================================================
import Anthropic from '@anthropic-ai/sdk';
import type { Context, SQSEvent } from 'aws-lambda';
import { getSecret } from './lib/ssm';
import { postMessage, uploadFile } from './lib/slack';
import { loadAgentConfig, agentNames, AgentConfig, AgentName } from './lib/config';
import {
  claimEvent,
  releaseEvent,
  getTask,
  createTask,
  findTaskIdByThread,
  bumpHops,
  decrementHops,
  bumpMentionCount,
  appendHistory,
  TaskState,
  HistoryEntry,
} from './lib/store';
import type { AgentJob } from './receiver';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
const API_KEY_PARAM = '/claude-bot/ANTHROPIC_API_KEY';

// --- 暴走防止のためのコード強制ガード（LLM の判断では変更不可能） ---
// 1タスクあたりのエージェント起動回数の上限。Bot 同士のメンション連鎖が
// 想定外に続いた場合でも、ここで必ず止まる（コスト・無限ループ対策の最終防衛線）。
// 内訳の目安: 正常系7ホップ + 修正2回（各+4）で15。確認の問い返し等の
// 揺らぎを許容して16（実運用で10では正常フローでも枯渇したため引き上げ）
const MAX_HOPS = 16;
// 1回の起動内でのツール呼び出しラウンド上限（LLM が延々とツールを叩き続ける事故の防止）。
// Web 検索の中断・再開（pause_turn）も1ラウンドを消費するため、検索ありの
// エージェントが完走できるよう余裕を持たせている
const MAX_TOOL_ROUNDS = 20;
// 1回の起動内での Web 検索回数の上限（検索は従量課金のためコストの暴走を防ぐ）
const MAX_WEB_SEARCHES = 5;
// Lambda タイムアウトの何ミリ秒前に処理を自主中断するか。
// ハードタイムアウトで殺されるとクレーム解放が実行できずジョブが失われるため、
// 期限前に例外で抜けて「クレーム解放 → SQS リトライ」の正規ルートに乗せる
const TIMEOUT_GUARD_MS = 60_000;
// ※ エージェント間のメンション回数制限（例: orchestrator→writer の修正依頼上限）は
//    コード定数ではなく AGENT_CONFIG の mentionLimits で設定する（runTool 参照）

/**
 * エージェントが使えるツール定義を生成する。
 * mention_agent の宛先候補は AGENT_CONFIG から動的に組み立てるため、
 * エージェントを追加すると全エージェントの宛先候補にも自動で現れる。
 * 「Slack への投稿はすべてツール経由」に統一することで、task_id の自動付与・
 * 履歴記録・回数制限をコード側で一元的に保証できる。
 *
 * AGENT_CONFIG で webSearch が有効なエージェントには、Anthropic の
 * サーバーサイド Web 検索ツールを追加する（検索は Anthropic 側で実行され、
 * 結果は引用付きで応答に組み込まれる。Lambda 側にコードは不要）。
 */
function buildTools(cfg: AgentConfig, agent: AgentName): Anthropic.Messages.ToolUnion[] {
  const tools: Anthropic.Messages.ToolUnion[] = [
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
            enum: [...agentNames(cfg), 'requester'],
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

  if (cfg[agent]?.webSearch) {
    tools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: MAX_WEB_SEARCHES,
    });
  }

  return tools;
}

/** 1回のエージェント起動の間、ツール実行に引き回す状態 */
interface ToolContext {
  agent: AgentName;
  cfg: AgentConfig;
  botToken: string;
  task: TaskState;
  /** この起動で発生した発言・成果物。最後にまとめてタスク履歴へ保存する */
  historyAdds: HistoryEntry[];
  /** mention_agent を使用済みか。1起動1メンションの強制に使う */
  mentionUsed: boolean;
}

/**
 * ツール1件を実行し、LLM に返す結果文字列を生成する。
 * ビジネスルール違反（メンション2回目・回数上限超過など）は例外ではなく
 * 「エラー文を tool_result として返す」ことで、LLM 自身に方針転換させる。
 */
async function runTool(ctx: ToolContext, name: string, input: any): Promise<string> {
  const { task } = ctx;
  const thread = { channel: task.channel, thread_ts: task.threadTs };

  if (name === 'post_progress') {
    // task_id はシステム側で必ず末尾に付与する（LLM の書き忘れによる
    // タスク迷子を防ぐため、LLM 任せにしない）
    const text = `${input.text}\n[task_id:${task.taskId}]`;
    await postMessage(ctx.botToken, { ...thread, text });
    ctx.historyAdds.push({ author: ctx.agent, text: input.text });
    return '投稿しました。';
  }

  if (name === 'mention_agent') {
    // 1起動1メンションの強制：1回の起動で複数エージェントを起こすと
    // 処理フローが分岐爆発するため、「次の1アクション」だけを許可する
    if (ctx.mentionUsed) {
      return 'エラー: mention_agent は1回の起動につき1回までです。今回の処理を終了してください。';
    }
    const target = String(input.target);
    // 'requester' はタスク作成時に記録した依頼者（人間）の UserID に解決する
    const userId = target === 'requester' ? task.requesterUserId : ctx.cfg[target]?.userId;
    if (!userId) {
      return `エラー: 宛先 ${target} が見つかりません。`;
    }
    // メンション回数制限：AGENT_CONFIG の mentionLimits に「自分→宛先」の上限が
    // 設定されているペアのみカウント・制限する。
    // 例: orchestrator→writer = 3（初回依頼1回 + 修正依頼2回）で、reviewer が
    // 承認しないまま修正を繰り返す「修正地獄」をコードで打ち切る。
    // 上限超過時はメンションを実行せず、「現状を最終版として確定せよ」と
    // LLM に指示するエラー文を返してサイクルを強制終了させる
    if (target !== 'requester') {
      const limit = ctx.cfg[ctx.agent]?.mentionLimits?.[target];
      if (limit !== undefined) {
        const count = await bumpMentionCount(task.taskId, ctx.agent, target);
        if (count > limit) {
          return `エラー: ${target} へのメンション回数が上限（${limit}回）に達しました。これ以上 ${target} には依頼できません。現状の成果物を最終版として確定し（必要なら upload_file で提出し）、requester に完了報告してください。`;
        }
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
    // ファイル内容ごと履歴に残す。後続エージェント（reviewer 等）は履歴経由で
    // 成果物を読めるため、Slack の files:read 権限を各 App に付与せずに済む
    ctx.historyAdds.push({
      author: ctx.agent,
      text: `（ファイル添付 ${input.filename}）\n${input.content}`,
    });
    return `${input.filename} を添付しました。`;
  }

  return `エラー: 不明なツール ${name}`;
}

/**
 * タスク履歴を「【発言者】本文」形式の読みやすいトランスクリプトに整形する。
 * エージェントは毎回ステートレスに起動されるため、これが唯一の文脈共有手段。
 */
function renderTranscript(task: TaskState): string {
  const history = task.history ?? [];
  if (history.length === 0) return '（履歴なし。これがこのタスクの最初のメッセージです）';
  return history.map((e) => `【${e.author}】\n${e.text}`).join('\n\n');
}

/**
 * チーム編成の一覧（エージェント名と役割説明）を生成してプロンプトに注入する。
 * AGENT_CONFIG から動的に組み立てるため、新エージェントを追加すると
 * 既存エージェント全員が（プロンプトを書き換えなくても）その存在を認知できる。
 */
function renderRoster(cfg: AgentConfig): string {
  return agentNames(cfg)
    .map((name) => `- ${name}${cfg[name].description ? `：${cfg[name].description}` : ''}`)
    .join('\n');
}

async function processJob(job: AgentJob, deadline: number): Promise<void> {
  // イベント重複排除：Slack の再送（3秒以内に応答できなかった場合等）や
  // SQS の at-least-once 配信により同じメンションが複数回届きうる。
  // 「チャンネル:メッセージts:宛先エージェント」を一意キーとして先勝ちで処理する
  const eventKey = `${job.channel}:${job.msgTs}:${job.agent}`;
  if (!(await claimEvent(eventKey))) {
    console.info(`[processor] duplicate delivery skipped: ${eventKey}`);
    return;
  }

  // 処理が失敗した場合はクレームを解放してから例外を再スローする。
  // 解放しないと SQS のリトライ配信が重複排除で破棄され、ジョブが静かに
  // 失われてエージェント連鎖が止まる（リトライ時は進捗投稿等が重複しうるが、
  // フロー停止よりは許容できるトレードオフ）
  const turn: TurnState = {};
  try {
    await runAgentTurn(job, deadline, turn);
  } catch (err) {
    console.error(`[processor] job failed, releasing claim ${eventKey}:`, err);
    await releaseEvent(eventKey).catch((e) =>
      console.error(`[processor] failed to release claim ${eventKey}:`, e),
    );
    // 失敗ターンが消費したホップを返却する（SQS リトライが再度 bumpHops するため、
    // 返却しないと「失敗1回+リトライ1回」で2ホップ消費し上限到達が早まる）
    if (turn.hopsCountedTaskId) {
      await decrementHops(turn.hopsCountedTaskId).catch(() => {});
    }
    throw err;
  }
}

/** 失敗時の補償処理（ホップ返却）のために runAgentTurn から進行状況を受け取る器 */
interface TurnState {
  /** bumpHops 実行済みの場合のみセットされる taskId */
  hopsCountedTaskId?: string;
}

/** エージェント1回分の起動（タスク解決 → ガード → tool use ループ → 履歴保存） */
async function runAgentTurn(job: AgentJob, deadline: number, turn: TurnState): Promise<void> {
  const [cfg, apiKey] = await Promise.all([loadAgentConfig(), getSecret(API_KEY_PARAM)]);
  const agentInfo = cfg[job.agent];
  if (!agentInfo) throw new Error(`Unknown agent in job: ${job.agent}`);
  const botToken = await getSecret(agentInfo.botTokenParam);
  if (!botToken || !apiKey) throw new Error('Missing credentials');

  // タスクの特定は3段階のフォールバック：
  //   1. 本文中の [task_id:xxx] タグ（エージェント間メンションには自動付与されている）
  //   2. スレッドポインタ（同じスレッド内の追加発言はタグが無くても同一タスク扱い）
  //   3. どちらも無ければ新規タスクを作成（人間からの最初の依頼がこのケース）
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

  // ホップ数ガード：上限超過したら Claude を起動せずに終了する。
  // 警告投稿は「超過後の最初の1回」だけに限定（超過が続いても警告を連投しない）
  const hops = await bumpHops(task.taskId);
  turn.hopsCountedTaskId = task.taskId;
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

  // 役割プロンプトは SSM で管理（コード変更・再デプロイなしで各エージェントの
  // 振る舞いを調整できる。SSM キャッシュの TTL により約1分以内に反映される）
  const promptParam = `/claude-bot/prompt/${job.agent}`;
  const rolePrompt = await getSecret(promptParam);
  if (!rolePrompt) throw new Error(`SSM parameter ${promptParam} is empty`);

  // システムプロンプト = 役割定義（SSM） + 実行時情報（誰として動くか・チーム編成・誰の依頼か）
  const senderLabel = job.senderAgent ?? (job.senderUserId ? `依頼者 <@${job.senderUserId}>` : '不明');
  const system = `${rolePrompt}

【実行時情報】
- あなたのエージェント名: ${job.agent}
- task_id: ${task.taskId}（投稿への付与はシステムが自動で行うため、本文に書く必要はない）
- 依頼者（人間）の UserID: ${task.requesterUserId || '不明'}
- 今日の日付: ${new Date().toISOString().slice(0, 10)}

【チームのエージェント一覧】
${renderRoster(cfg)}`;

  // ユーザーメッセージ = タスクの全履歴 + 今回受信したメンション。
  // 「経緯を踏まえて次の1アクションを取る」のがすべてのエージェント共通の動作原則
  const inbound = `これまでのタスクの経緯:
${renderTranscript(task)}

---
今回あなた宛に届いたメッセージ（送信者: ${senderLabel}）:
${job.text}

---
あなたの役割とルールに従い、ツールを使って処理を実行してください。`;

  // maxRetries: 429（レート制限）等の一過性エラーを SDK の指数バックオフで
  // 乗り切る。組織のトークン/分制限は約1分で回復するため、デフォルトの2回では
  // 待ち切れずターン全体が失敗することがある（2026-06-12 に実際に発生）
  const anthropic = new Anthropic({ apiKey, maxRetries: 5 });
  const ctx: ToolContext = {
    agent: job.agent,
    cfg,
    botToken,
    task,
    // 受信メッセージ自体も履歴に積む（次に起動されるエージェントが文脈を辿れるように）
    historyAdds: [{ author: job.senderAgent ?? 'user', text: job.text }],
    mentionUsed: false,
  };

  // --- Anthropic tool-use ループ ---
  // LLM がツールを要求する限り「実行 → 結果を返す → 続きを生成」を繰り返し、
  // end_turn（またはラウンド上限）で終了する
  const tools = buildTools(cfg, job.agent);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: inbound }];
  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // タイムアウトウォッチドッグ：Lambda のハードタイムアウトで殺される前に
    // 自主的に中断する。例外は processJob でクレーム解放に変換され、
    // SQS リトライが新しい実行時間枠でやり直す
    if (Date.now() > deadline - TIMEOUT_GUARD_MS) {
      throw new Error(
        `[processor] Lambda タイムアウト接近のため中断（round=${round}）。クレームを解放して SQS リトライに委ねる`,
      );
    }

    // cache_control（自動キャッシュ）：ツールループの各ラウンドは直前ラウンドの
    // 全履歴を共通プレフィックスとして再送するため、キャッシュが効くと
    // 2ラウンド目以降の入力がキャッシュ読取（約0.1倍コスト・レート制限の
    // 消費も大幅減）になる。長い履歴 × 複数ラウンドでの 429 対策の本命
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      cache_control: { type: 'ephemeral' },
      system,
      messages,
      tools,
    });

    // pause_turn：サーバーサイドツール（Web 検索等）の実行途中で API が
    // 一時停止した状態。応答をそのまま積み直して再リクエストすると、
    // サーバー側が続きから自動再開する（追加のユーザー入力は不要）
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

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
        // Slack API エラー等で1ツールが失敗しても起動全体は落とさず、
        // エラー内容を LLM に返してリカバリー（再試行・代替手段）を委ねる
        console.error(`[processor] tool ${tu.name} failed:`, err);
        result = `エラー: ツール実行に失敗しました（${err?.message ?? err}）`;
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }

  // フォールバック投稿：LLM がツールを使わず自由文だけで応答を終えた場合
  // （挨拶や単純な質問への回答など）、その文章を取りこぼさずスレッドに届ける。
  // メンション送信済みの場合は引き継ぎが完了しているため重複投稿しない
  if (finalText.trim() && !ctx.mentionUsed) {
    await postMessage(botToken, {
      channel: task.channel,
      thread_ts: task.threadTs,
      text: `${finalText}\n[task_id:${task.taskId}]`,
    });
    ctx.historyAdds.push({ author: job.agent, text: finalText });
  }

  // この起動分の発言・成果物をまとめてタスク履歴へ永続化
  await appendHistory(task.taskId, ctx.historyAdds);
  console.log(`[processor] ${job.agent} finished task ${task.taskId} (hops=${hops})`);
}

export const handler = async (event: SQSEvent, context?: Context): Promise<void> => {
  // Lambda の残り実行時間から自主中断の期限を算出（テスト等 context なしは15分相当）
  const deadline = Date.now() + (context?.getRemainingTimeInMillis() ?? 15 * 60_000);
  for (const record of event.Records) {
    const job = JSON.parse(record.body) as AgentJob;
    console.log('[processor] job received', {
      agent: job.agent,
      channel: job.channel,
      msgTs: job.msgTs,
    });
    await processJob(job, deadline);
  }
};
