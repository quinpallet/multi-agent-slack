import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadAgentConfig, agentByUserId, agentByBotId, AgentConfig } from '../src/lib/config';
import { getSecret } from '../src/lib/ssm';

vi.mock('../src/lib/ssm', () => ({ getSecret: vi.fn() }));

const FIXTURE: AgentConfig = {
  orchestrator: { userId: 'U_ORCH', botId: 'B_ORCH', botTokenParam: '/p/o' },
  researcher: { userId: 'U_RES', botId: 'B_RES', botTokenParam: '/p/r' },
  writer: { userId: 'U_WRI', botId: 'B_WRI', botTokenParam: '/p/w' },
  reviewer: { userId: 'U_REV', botId: 'B_REV', botTokenParam: '/p/v' },
};

beforeEach(() => {
  vi.mocked(getSecret).mockReset();
});

describe('loadAgentConfig', () => {
  it('SSM の JSON をパースして返す', async () => {
    vi.mocked(getSecret).mockResolvedValue(JSON.stringify(FIXTURE));
    const cfg = await loadAgentConfig();
    expect(cfg.researcher.userId).toBe('U_RES');
    expect(getSecret).toHaveBeenCalledWith('/claude-bot/AGENT_CONFIG');
  });

  it('パラメータが空なら例外を投げる', async () => {
    vi.mocked(getSecret).mockResolvedValue('');
    await expect(loadAgentConfig()).rejects.toThrow('/claude-bot/AGENT_CONFIG');
  });
});

describe('agentByUserId / agentByBotId', () => {
  it('userId からエージェント名を逆引きする', () => {
    expect(agentByUserId(FIXTURE, 'U_WRI')).toBe('writer');
    expect(agentByUserId(FIXTURE, 'U_UNKNOWN')).toBeUndefined();
  });

  it('botId からエージェント名を逆引きする（許可リスト判定に使用）', () => {
    expect(agentByBotId(FIXTURE, 'B_REV')).toBe('reviewer');
    expect(agentByBotId(FIXTURE, 'B_FOREIGN')).toBeUndefined();
  });
});
