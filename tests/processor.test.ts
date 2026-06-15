import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
    constructor(_opts: any) {}
  },
}));

vi.mock('../src/lib/store', () => ({
  claimEvent: vi.fn(),
  releaseEvent: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  findTaskIdByThread: vi.fn(),
  bumpHops: vi.fn(),
  decrementHops: vi.fn(),
  bumpMentionCount: vi.fn(),
  appendHistory: vi.fn(),
}));

vi.mock('../src/lib/slack', () => ({
  postMessage: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock('../src/lib/ssm', () => ({ getSecret: vi.fn() }));

vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/config')>()),
  loadAgentConfig: vi.fn(),
}));

import { handler } from '../src/processor';
import * as store from '../src/lib/store';
import { postMessage, uploadFile } from '../src/lib/slack';
import { getSecret } from '../src/lib/ssm';
import { loadAgentConfig } from '../src/lib/config';

const CFG = {
  orchestrator: {
    userId: 'U_ORCH', botId: 'B_ORCH', botTokenParam: '/p/o', signingSecretParam: '/s/o',
    description: '司令塔',
    // メンション回数制限は設定駆動：orchestrator→writer は3回（初回+修正2回）まで
    mentionLimits: { writer: 3 },
  },
  researcher: {
    userId: 'U_RES', botId: 'B_RES', botTokenParam: '/p/r', signingSecretParam: '/s/r',
    // Web 検索はエージェント別の設定駆動（researcher のみ有効）
    webSearch: true,
  },
  writer: { userId: 'U_WRI', botId: 'B_WRI', botTokenParam: '/p/w', signingSecretParam: '/s/w' },
  reviewer: { userId: 'U_REV', botId: 'B_REV', botTokenParam: '/p/v', signingSecretParam: '/s/v' },
  // コード変更なしで AGENT_CONFIG に追加された新エージェント
  translator: {
    userId: 'U_TRA', botId: 'B_TRA', botTokenParam: '/p/t', signingSecretParam: '/s/t',
    description: '翻訳者',
  },
} as any;

const TASK = {
  pk: 'task#t1',
  taskId: 't1',
  channel: 'C1',
  threadTs: '100.001',
  requesterUserId: 'U_HUMAN',
  hops: 1,
  history: [{ author: 'user', text: '以前のやり取り' }],
};

function sqsEvent(job: object): SQSEvent {
  return { Records: [{ body: JSON.stringify(job) } as any] };
}

function job(overrides: object = {}) {
  return {
    agent: 'orchestrator',
    channel: 'C1',
    threadTs: '100.001',
    msgTs: '100.002',
    text: '<@U_ORCH> お願いします [task_id:t1]',
    senderUserId: 'U_HUMAN',
    ...overrides,
  };
}

/** stop_reason 付きのモック応答を作る */
const textBlock = (text: string) => ({ type: 'text', text });
const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const response = (stop: string, content: any[]) => ({ stop_reason: stop, content });

beforeEach(() => {
  vi.mocked(createMock).mockReset();
  vi.mocked(store.claimEvent).mockReset().mockResolvedValue(true);
  vi.mocked(store.releaseEvent).mockReset().mockResolvedValue();
  vi.mocked(store.getTask).mockReset().mockResolvedValue({ ...TASK, history: [...TASK.history] });
  vi.mocked(store.createTask).mockReset();
  vi.mocked(store.findTaskIdByThread).mockReset().mockResolvedValue(undefined);
  vi.mocked(store.bumpHops).mockReset().mockResolvedValue(2);
  vi.mocked(store.decrementHops).mockReset().mockResolvedValue(1);
  vi.mocked(store.bumpMentionCount).mockReset().mockResolvedValue(1);
  vi.mocked(store.appendHistory).mockReset().mockResolvedValue();
  vi.mocked(postMessage).mockReset().mockResolvedValue();
  vi.mocked(uploadFile).mockReset().mockResolvedValue();
  vi.mocked(loadAgentConfig).mockReset().mockResolvedValue(CFG);
  vi.mocked(getSecret)
    .mockReset()
    .mockImplementation(async (name: string) => {
      if (name.startsWith('/claude-bot/prompt/')) return 'あなたはテスト用エージェントです。';
      if (name === '/claude-bot/ANTHROPIC_API_KEY') return 'sk-test';
      return 'xoxb-test-token';
    });
});

describe('processor.handler', () => {
  it('重複配信はスキップする（Claude API を呼ばない）', async () => {
    vi.mocked(store.claimEvent).mockResolvedValue(false);
    await handler(sqsEvent(job()));
    expect(createMock).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('MAX_HOPS 超過時は⚠️を1回だけ投稿して停止する', async () => {
    vi.mocked(store.bumpHops).mockResolvedValue(17);
    await handler(sqsEvent(job()));
    expect(createMock).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(postMessage).mock.calls[0][1].text).toContain('上限');

    // 18ホップ目以降は投稿もしない
    vi.mocked(postMessage).mockClear();
    vi.mocked(store.claimEvent).mockResolvedValue(true);
    vi.mocked(store.bumpHops).mockResolvedValue(18);
    await handler(sqsEvent(job({ msgTs: '100.003' })));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('tool use ループ：post_progress → mention_agent → 終了', async () => {
    createMock
      .mockResolvedValueOnce(
        response('tool_use', [
          textBlock('工程を投稿します'),
          toolUse('tu1', 'post_progress', { text: '📋 作業工程\n1. 調査' }),
        ]),
      )
      .mockResolvedValueOnce(
        response('tool_use', [toolUse('tu2', 'mention_agent', { target: 'researcher', text: '調査してください' })]),
      )
      .mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job()));

    expect(createMock).toHaveBeenCalledTimes(3);
    const posts = vi.mocked(postMessage).mock.calls.map((c) => c[1]);

    // 進捗投稿：task_id 自動付与・スレッド投稿
    const progress = posts.find((p) => p.text.includes('📋 作業工程'));
    expect(progress).toBeDefined();
    expect(progress!.text).toContain('[task_id:t1]');
    expect(progress!.thread_ts).toBe('100.001');

    // メンション：実 userId に解決される
    const mention = posts.find((p) => p.text.startsWith('<@U_RES>'));
    expect(mention).toBeDefined();
    expect(mention!.text).toContain('調査してください');
    expect(mention!.text).toContain('[task_id:t1]');

    // 履歴保存：受信メッセージ + 各アクション
    expect(store.appendHistory).toHaveBeenCalledOnce();
    const entries = vi.mocked(store.appendHistory).mock.calls[0][1];
    expect(entries[0]).toMatchObject({ author: 'user' });
    expect(entries.some((e) => e.author === 'orchestrator')).toBe(true);
  });

  it('mention_agent の2回目はエラーを返して投稿しない（分岐爆発防止）', async () => {
    createMock
      .mockResolvedValueOnce(
        response('tool_use', [
          toolUse('tu1', 'mention_agent', { target: 'researcher', text: '1回目' }),
          toolUse('tu2', 'mention_agent', { target: 'writer', text: '2回目' }),
        ]),
      )
      .mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job()));

    const mentions = vi.mocked(postMessage).mock.calls.filter((c) => c[1].text.startsWith('<@'));
    expect(mentions).toHaveLength(1);

    // 2回目の tool_result はエラー文
    const secondCallMessages = createMock.mock.calls[1][0].messages;
    const toolResults = secondCallMessages.at(-1).content;
    expect(toolResults[1].content).toContain('1回');
  });

  it('mentionLimits 設定があるペア（orchestrator→writer）は上限超過でエラー文を返す', async () => {
    vi.mocked(store.bumpMentionCount).mockResolvedValue(4); // 4回目 = 3回目の修正依頼
    createMock
      .mockResolvedValueOnce(
        response('tool_use', [toolUse('tu1', 'mention_agent', { target: 'writer', text: '再修正して' })]),
      )
      .mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job()));

    // writer へのメンションは投稿されない
    expect(vi.mocked(postMessage).mock.calls.some((c) => c[1].text.startsWith('<@U_WRI'))).toBe(false);
    // LLM には最終版化を指示するエラーが返る
    const toolResults = createMock.mock.calls[1][0].messages.at(-1).content;
    expect(toolResults[0].content).toContain('上限');
    expect(toolResults[0].content).toContain('最終版');
  });

  it('mentionLimits 未設定のペアはカウンタを消費しない', async () => {
    createMock
      .mockResolvedValueOnce(
        response('tool_use', [toolUse('tu1', 'mention_agent', { target: 'researcher', text: '調査して' })]),
      )
      .mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job()));

    expect(store.bumpMentionCount).not.toHaveBeenCalled();
    expect(vi.mocked(postMessage).mock.calls.some((c) => c[1].text.startsWith('<@U_RES>'))).toBe(true);
  });

  it('設定に追加しただけの新エージェントにもメンションできる（拡張性）', async () => {
    createMock
      .mockResolvedValueOnce(
        response('tool_use', [toolUse('tu1', 'mention_agent', { target: 'translator', text: '英訳して' })]),
      )
      .mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job()));

    const mention = vi.mocked(postMessage).mock.calls.find((c) => c[1].text.startsWith('<@U_TRA>'));
    expect(mention).toBeDefined();
    // ツール定義の宛先候補（enum）にも動的に含まれる
    const tools = createMock.mock.calls[0][0].tools;
    const targetEnum = tools.find((t: any) => t.name === 'mention_agent').input_schema.properties.target.enum;
    expect(targetEnum).toContain('translator');
  });

  it('webSearch が有効なエージェントにのみ Web 検索ツールを付与する', async () => {
    createMock.mockResolvedValue(response('end_turn', []));

    // researcher（webSearch: true）→ web_search あり
    await handler(sqsEvent(job({ agent: 'researcher', text: '<@U_RES> 調査して [task_id:t1]' })));
    const researcherTools = createMock.mock.calls[0][0].tools;
    expect(researcherTools.some((t: any) => t.type === 'web_search_20250305')).toBe(true);

    // orchestrator（未設定）→ web_search なし
    vi.mocked(store.claimEvent).mockResolvedValue(true);
    await handler(sqsEvent(job({ msgTs: '100.003' })));
    const orchTools = createMock.mock.calls[1][0].tools;
    expect(orchTools.some((t: any) => t.type === 'web_search_20250305')).toBe(false);
  });

  it('pause_turn（サーバーサイドツール実行中断）は応答を積み直して継続する', async () => {
    createMock
      .mockResolvedValueOnce(
        response('pause_turn', [{ type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'x' } }]),
      )
      .mockResolvedValueOnce(response('end_turn', [textBlock('検索結果に基づく回答')]));

    await handler(sqsEvent(job({ agent: 'researcher', text: '<@U_RES> 調査して [task_id:t1]' })));

    expect(createMock).toHaveBeenCalledTimes(2);
    // 2回目のリクエストには pause_turn 時点の assistant 応答がそのまま積まれている
    const secondMessages = createMock.mock.calls[1][0].messages;
    expect(secondMessages.at(-1).role).toBe('assistant');
    expect(secondMessages.at(-1).content[0].type).toBe('server_tool_use');
    // 完了後は通常どおり fallback 投稿される
    expect(vi.mocked(postMessage).mock.calls[0][1].text).toContain('検索結果に基づく回答');
  });

  it('システムプロンプトに AGENT_CONFIG 由来のチーム一覧が注入される', async () => {
    createMock.mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job()));

    const system = createMock.mock.calls[0][0].system as string;
    expect(system).toContain('translator：翻訳者');
    expect(system).toContain('orchestrator：司令塔');
  });

  it('upload_file は files.uploadV2 で添付し task_id 付きコメントを付ける', async () => {
    createMock
      .mockResolvedValueOnce(
        response('tool_use', [
          toolUse('tu1', 'upload_file', { filename: 'report.md', content: '# 本文', comment: '完成です' }),
        ]),
      )
      .mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job()));

    expect(uploadFile).toHaveBeenCalledOnce();
    const args = vi.mocked(uploadFile).mock.calls[0][1];
    expect(args).toMatchObject({ channel: 'C1', threadTs: '100.001', filename: 'report.md', content: '# 本文' });
    expect(args.initialComment).toContain('完成です');
    expect(args.initialComment).toContain('[task_id:t1]');
  });

  it('ツールを使わない自由文応答は fallback でスレッドに投稿する', async () => {
    createMock.mockResolvedValueOnce(response('end_turn', [textBlock('こんにちは、何をお手伝いしますか？')]));

    await handler(sqsEvent(job()));

    expect(postMessage).toHaveBeenCalledOnce();
    const text = vi.mocked(postMessage).mock.calls[0][1].text;
    expect(text).toContain('こんにちは');
    expect(text).toContain('[task_id:t1]');
  });

  it('task_id もスレッドポインタもない場合は新規タスクを作成する', async () => {
    vi.mocked(store.getTask).mockResolvedValue(undefined);
    vi.mocked(store.createTask).mockResolvedValue({ ...TASK, taskId: 'newid', pk: 'task#newid' });
    createMock.mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job({ text: '<@U_ORCH> 新しい依頼です' })));

    expect(store.createTask).toHaveBeenCalledOnce();
    expect(vi.mocked(store.createTask).mock.calls[0][0]).toMatchObject({
      channel: 'C1',
      threadTs: '100.001',
      requesterUserId: 'U_HUMAN',
    });
  });

  it('処理が失敗したらクレーム解放 + ホップ返却して例外を再スローする（SQS リトライに委ねる）', async () => {
    createMock.mockRejectedValue(new Error('api down'));

    await expect(handler(sqsEvent(job()))).rejects.toThrow('api down');

    expect(store.releaseEvent).toHaveBeenCalledWith('C1:100.002:orchestrator');
    // 失敗ターンが bumpHops したぶんを返却（リトライの二重計上防止）
    expect(store.decrementHops).toHaveBeenCalledWith('t1');
  });

  it('正常完了時はクレーム解放もホップ返却もしない', async () => {
    createMock.mockResolvedValueOnce(response('end_turn', []));
    await handler(sqsEvent(job()));
    expect(store.releaseEvent).not.toHaveBeenCalled();
    expect(store.decrementHops).not.toHaveBeenCalled();
  });

  it('Lambda タイムアウト接近時は API を呼ばず中断し、クレームを解放する', async () => {
    // 残り30秒（< ガード60秒）の context を渡す
    const context = { getRemainingTimeInMillis: () => 30_000 } as any;

    await expect(handler(sqsEvent(job()), context)).rejects.toThrow('タイムアウト');

    expect(createMock).not.toHaveBeenCalled();
    expect(store.releaseEvent).toHaveBeenCalledWith('C1:100.002:orchestrator');
  });

  it('ツール実行が例外を投げても tool_result でエラーを返して継続する', async () => {
    vi.mocked(postMessage).mockRejectedValueOnce(new Error('rate_limited'));
    createMock
      .mockResolvedValueOnce(response('tool_use', [toolUse('tu1', 'post_progress', { text: 'x' })]))
      .mockResolvedValueOnce(response('end_turn', []));

    await handler(sqsEvent(job()));

    const toolResults = createMock.mock.calls[1][0].messages.at(-1).content;
    expect(toolResults[0].content).toContain('rate_limited');
  });
});
