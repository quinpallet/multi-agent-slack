// =============================================================================
// receiver.ts — Slack イベント受信 Lambda（API Gateway 直結）
//
// 各エージェントの Slack App が共通の Request URL としてこのエンドポイントを使う。
// 役割は「正当な app_mention を検証し、宛先エージェントごとのジョブとして
// SQS に積む」ことだけ。Slack は 3 秒以内に 200 を返さないと再送してくるため、
// 重い処理（Claude API 呼び出し等）は一切行わず processor 側へ委譲する。
//
// エージェントの一覧・ID・Signing Secret の在処はすべて SSM の AGENT_CONFIG から
// 動的に読むため、エージェントを追加してもこのコードに変更は発生しない。
// =============================================================================
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getSecret } from './lib/ssm';
import { verifySlackSignature } from './lib/slack';
import { loadAgentConfig, agentByBotId, agentByUserId, AgentConfig, AgentName } from './lib/config';

const QUEUE_URL = process.env.QUEUE_URL ?? '';
const sqs = new SQSClient({});

/** SQS 経由で processor に渡す1ジョブ（= 1エージェントへの1メンション） */
export interface AgentJob {
  /** 処理を担当するエージェント名（メンションされた側） */
  agent: AgentName;
  channel: string;
  /** スレッドの親 ts。返信はすべてこのスレッドにぶら下げる */
  threadTs: string;
  /** メンションが書かれたメッセージ自体の ts（イベント重複排除キーに使用） */
  msgTs: string;
  text: string;
  /** 送信者が人間の場合の UserID（新規タスクの「依頼者」として記録される） */
  senderUserId?: string;
  /** 送信者が自前 Bot の場合のエージェント名（Bot連鎖の発信元特定用） */
  senderAgent?: AgentName;
  eventId?: string;
}

/**
 * 全エージェントの Signing Secret を順に試し、どれか1つでも検証が通れば
 * 正当なリクエストとする。App ごとに Secret が異なるが、リクエストからは
 * どの App 経由かを判別できないため総当たりで検証する。
 */
async function verifyWithAnySecret(
  cfg: AgentConfig,
  headers: Record<string, string | undefined>,
  rawBody: string,
): Promise<boolean> {
  const params = [...new Set(Object.values(cfg).map((a) => a.signingSecretParam).filter(Boolean))];
  const secrets = await Promise.all(params.map((p) => getSecret(p)));
  return secrets.some((s) => s && verifySlackSignature(s, headers, rawBody));
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const rawBody = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : '';

  let body: any;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return { statusCode: 400, body: 'invalid json' };
  }

  // Slack 管理画面で Request URL を登録する際の疎通確認（url_verification）。
  // 署名検証より前に応答しないと URL 登録自体ができないため、ここで即返す。
  if (body.type === 'url_verification') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: body.challenge }),
    };
  }

  // エージェント構成（一覧・ID・Secret の在処）は SSM から動的に取得する
  const cfg = await loadAgentConfig();

  // なりすまし防止：Slack 以外からの POST はすべて拒否する
  if (!(await verifyWithAnySecret(cfg, event.headers ?? {}, rawBody))) {
    console.warn('[receiver] signature verification failed');
    return { statusCode: 401, body: 'invalid signature' };
  }

  // 各 App は app_mention のみ購読している想定だが、念のため種別を確認。
  // 反応するのは「メンションされたとき」だけ（通常メッセージには反応しない）
  const ev = body.event;
  if (ev?.type !== 'app_mention') {
    return { statusCode: 200, body: 'ok' };
  }

  // 送信者の身元を判定する：人間／自前エージェント／外部Bot のいずれか。
  // 外部 Bot を無視するのは、許可リスト外の Bot との相互メンションによる
  // 無限ループ（Bot同士の応酬）を防ぐため。
  let senderAgent: AgentName | undefined;
  if (ev.bot_id) {
    senderAgent = agentByBotId(cfg, ev.bot_id);
    if (!senderAgent) {
      console.info(`[receiver] ignoring message from non-allowlisted bot ${ev.bot_id}`);
      return { statusCode: 200, body: 'ok' };
    }
  }

  // 本文中の <@Uxxxx> 形式メンションをすべて抽出し、自前エージェント宛のものに絞る。
  // 送信者自身へのメンションは除外する（自分宛に送って自己ループするのを防ぐ）。
  const text = String(ev.text ?? '');
  const mentionedIds = [...text.matchAll(/<@(U[A-Z0-9]+)>/g)].map((m) => m[1]);
  const targets = [...new Set(mentionedIds)]
    .map((id) => agentByUserId(cfg, id))
    .filter((a): a is AgentName => Boolean(a) && a !== senderAgent);

  if (targets.length === 0) {
    return { statusCode: 200, body: 'ok' };
  }

  console.log('[receiver] routing', {
    sender: senderAgent ?? ev.user,
    targets,
    channel: ev.channel,
    eventId: body.event_id,
  });

  // 宛先エージェントごとに1ジョブを SQS へ送信（1メッセージで複数エージェントに
  // メンションした場合は、それぞれが独立に処理を開始する）。
  // thread_ts が無い = スレッド外の投稿なので、そのメッセージ自体を親にする。
  await Promise.all(
    targets.map((agent) => {
      const job: AgentJob = {
        agent,
        channel: ev.channel,
        threadTs: ev.thread_ts ?? ev.ts,
        msgTs: ev.ts,
        text,
        senderUserId: ev.user,
        senderAgent,
        eventId: body.event_id,
      };
      return sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    }),
  );

  return { statusCode: 200, body: 'ok' };
};
