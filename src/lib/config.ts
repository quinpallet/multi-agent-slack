import { getSecret } from './ssm';

export const AGENT_NAMES = ['orchestrator', 'researcher', 'writer', 'reviewer'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export interface AgentInfo {
  userId: string;
  botId: string;
  botTokenParam: string;
}

export type AgentConfig = Record<AgentName, AgentInfo>;

const CONFIG_PARAM = '/claude-bot/AGENT_CONFIG';

export async function loadAgentConfig(): Promise<AgentConfig> {
  const raw = await getSecret(CONFIG_PARAM);
  if (!raw) throw new Error(`SSM parameter ${CONFIG_PARAM} is empty`);
  return JSON.parse(raw) as AgentConfig;
}

export function agentByUserId(cfg: AgentConfig, userId: string): AgentName | undefined {
  return AGENT_NAMES.find((name) => cfg[name]?.userId === userId);
}

export function agentByBotId(cfg: AgentConfig, botId: string): AgentName | undefined {
  return AGENT_NAMES.find((name) => cfg[name]?.botId === botId);
}
