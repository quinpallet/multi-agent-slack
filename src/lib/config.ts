// =============================================================================
// config.ts — エージェント構成の定義と SSM からの読み込み
//
// エージェントの一覧と属性は SSM パラメータ /claude-bot/AGENT_CONFIG に
// JSON で一元管理し、コードはエージェント名を一切ハードコードしない。
// これにより「Slack App を作成し、prompts/agents.json に1エントリ追加して
// scripts/setup-prompts.sh を実行する」だけで、コード変更・再デプロイなしに
// 新しいエージェントを追加できる。
//
// Slack App を再インストールすると ID が変わりうるため、ID もコードに直書きせず
// scripts/setup-prompts.sh が auth.test で実際の ID を取得して再登録する運用。
// =============================================================================
import { getSecret } from './ssm';

/** エージェント名。固定の列挙ではなく AGENT_CONFIG のキーがすべて */
export type AgentName = string;

export interface AgentInfo {
  /** Slack 上のメンション対象 ID（<@Uxxxx> の中身）。受信メンションの宛先判定に使う */
  userId: string;
  /** メッセージの bot_id。受信イベントの送信元 Bot 判定（許可リスト照合）に使う */
  botId: string;
  /** この App の Bot Token が入っている SSM パラメータ名（トークン自体は持たない） */
  botTokenParam: string;
  /** この App の Signing Secret が入っている SSM パラメータ名（署名検証に使う） */
  signingSecretParam: string;
  /** 役割の一行説明。各エージェントのシステムプロンプトに「チーム一覧」として注入され、
   *  新エージェントを追加すると既存エージェントからも自動的に認知される */
  description?: string;
  /** このエージェントから特定の宛先へのメンション回数上限。
   *  例: orchestrator に { "writer": 3 } → 初回依頼1回 + 修正依頼2回で打ち切り */
  mentionLimits?: Record<AgentName, number>;
  /** true のとき Anthropic のサーバーサイド Web 検索ツールを有効化する。
   *  検索の実行は Anthropic 側で行われるため Lambda 側の実装は不要。
   *  検索が必要な役割（researcher 等）だけに付与してコストを抑える */
  webSearch?: boolean;
}

export type AgentConfig = Record<AgentName, AgentInfo>;

const CONFIG_PARAM = '/claude-bot/AGENT_CONFIG';

export async function loadAgentConfig(): Promise<AgentConfig> {
  const raw = await getSecret(CONFIG_PARAM);
  if (!raw) throw new Error(`SSM parameter ${CONFIG_PARAM} is empty`);
  return JSON.parse(raw) as AgentConfig;
}

/** 構成に含まれる全エージェント名（AGENT_CONFIG のキー） */
export function agentNames(cfg: AgentConfig): AgentName[] {
  return Object.keys(cfg);
}

/** メンションされた UserID がどのエージェントか逆引きする（宛先ルーティング用） */
export function agentByUserId(cfg: AgentConfig, userId: string): AgentName | undefined {
  return agentNames(cfg).find((name) => cfg[name]?.userId === userId);
}

/** 送信元 bot_id がどのエージェントか逆引きする（自前Bot許可リスト判定用） */
export function agentByBotId(cfg: AgentConfig, botId: string): AgentName | undefined {
  return agentNames(cfg).find((name) => cfg[name]?.botId === botId);
}
