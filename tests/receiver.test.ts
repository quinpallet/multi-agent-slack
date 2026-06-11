import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { handler } from '../src/receiver';
import { getSecret } from '../src/lib/ssm';

vi.mock('../src/lib/ssm', () => ({ getSecret: vi.fn() }));

const sqsMock = mockClient(SQSClient);
const SECRET = 'test-signing-secret';

const CFG = {
  orchestrator: { userId: 'U0ORCH', botId: 'B_ORCH', botTokenParam: '/p/o' },
  researcher: { userId: 'U0RES', botId: 'B_RES', botTokenParam: '/p/r' },
  writer: { userId: 'U0WRI', botId: 'B_WRI', botTokenParam: '/p/w' },
  reviewer: { userId: 'U0REV', botId: 'B_REV', botTokenParam: '/p/v' },
};

function makeEvent(payload: object, opts: { signed?: boolean } = { signed: true }): any {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig =
    'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex');
  return {
    body,
    isBase64Encoded: false,
    headers: opts.signed
      ? { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }
      : { 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=deadbeef' },
  };
}

function appMention(ev: object) {
  return { type: 'event_callback', event_id: 'Ev123', event: { type: 'app_mention', ...ev } };
}

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(SendMessageCommand).resolves({});
  vi.mocked(getSecret).mockReset();
  vi.mocked(getSecret).mockImplementation(async (name: string) => {
    if (name === '/claude-bot/AGENT_CONFIG') return JSON.stringify(CFG);
    if (name.startsWith('/claude-bot/SIGNING_SECRET')) return SECRET;
    return '';
  });
});

function sentJobs() {
  return sqsMock
    .commandCalls(SendMessageCommand)
    .map((c) => JSON.parse(String(c.args[0].input.MessageBody)));
}

describe('receiver.handler', () => {
  it('url_verification には署名なしで challenge を返す', async () => {
    const res = await handler(makeEvent({ type: 'url_verification', challenge: 'ch42' }, { signed: false }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ challenge: 'ch42' });
  });

  it('署名が不正なら 401', async () => {
    const res = await handler(makeEvent(appMention({ text: 'x' }), { signed: false }));
    expect(res.statusCode).toBe(401);
    expect(sentJobs()).toHaveLength(0);
  });

  it('人間からのメンションを対象エージェントのジョブとして SQS に送る', async () => {
    const res = await handler(
      makeEvent(
        appMention({
          user: 'U0HUMAN',
          text: '<@U0ORCH> レポートを作成してください',
          channel: 'C1',
          ts: '100.001',
        }),
      ),
    );
    expect(res.statusCode).toBe(200);
    const jobs = sentJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      agent: 'orchestrator',
      channel: 'C1',
      threadTs: '100.001', // thread_ts なし → ts が親
      msgTs: '100.001',
      senderUserId: 'U0HUMAN',
    });
    expect(jobs[0].senderAgent).toBeUndefined();
  });

  it('許可リスト内の Bot 発メンションは senderAgent 付きでルーティングする（Bot連鎖）', async () => {
    await handler(
      makeEvent(
        appMention({
          bot_id: 'B_ORCH',
          text: '<@U0RES> 調査してください [task_id:abc]',
          channel: 'C1',
          ts: '100.002',
          thread_ts: '100.001',
        }),
      ),
    );
    const jobs = sentJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      agent: 'researcher',
      senderAgent: 'orchestrator',
      threadTs: '100.001',
      msgTs: '100.002',
    });
  });

  it('許可リスト外の Bot は無視する（外部Botループ防止）', async () => {
    const res = await handler(
      makeEvent(
        appMention({ bot_id: 'B_FOREIGN', text: '<@U0RES> hello', channel: 'C1', ts: '1.2' }),
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(sentJobs()).toHaveLength(0);
  });

  it('送信者自身へのメンションは除外する（自己ループ防止）', async () => {
    await handler(
      makeEvent(
        appMention({ bot_id: 'B_RES', text: '<@U0RES> 自分宛', channel: 'C1', ts: '1.2' }),
      ),
    );
    expect(sentJobs()).toHaveLength(0);
  });

  it('複数エージェントへのメンションはそれぞれにジョブを送る', async () => {
    await handler(
      makeEvent(
        appMention({
          user: 'U0HUMAN',
          text: '<@U0RES> と <@U0WRI> お願いします',
          channel: 'C1',
          ts: '1.2',
        }),
      ),
    );
    expect(sentJobs().map((j) => j.agent).sort()).toEqual(['researcher', 'writer']);
  });

  it('エージェント宛でないメンションは何もしない', async () => {
    await handler(
      makeEvent(appMention({ user: 'U0HUMAN', text: '<@U0SOMEONE> hi', channel: 'C1', ts: '1.2' })),
    );
    expect(sentJobs()).toHaveLength(0);
  });

  it('app_mention 以外のイベントは無視する', async () => {
    const res = await handler(
      makeEvent({ type: 'event_callback', event: { type: 'message', text: '<@U0RES> hi' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(sentJobs()).toHaveLength(0);
  });
});
