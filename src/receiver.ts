import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getSecret } from './lib/ssm';
import { verifySlackSignature } from './lib/slack';
import { loadAgentConfig, agentByBotId, agentByUserId, AGENT_NAMES, AgentName } from './lib/config';

const QUEUE_URL = process.env.QUEUE_URL ?? '';
const sqs = new SQSClient({});

const SIGNING_SECRET_PARAMS = [
  '/claude-bot/SIGNING_SECRET_ORCHESTRATOR',
  '/claude-bot/SIGNING_SECRET_RESEARCHER',
  '/claude-bot/SIGNING_SECRET_WRITER',
  '/claude-bot/SIGNING_SECRET_REVIEWER',
];

export interface AgentJob {
  agent: AgentName;
  channel: string;
  threadTs: string;
  msgTs: string;
  text: string;
  /** Human sender's user ID, if the message came from a human. */
  senderUserId?: string;
  /** Sending agent's name, if the message came from one of our bots. */
  senderAgent?: AgentName;
  eventId?: string;
}

async function verifyWithAnySecret(
  headers: Record<string, string | undefined>,
  rawBody: string,
): Promise<boolean> {
  const secrets = await Promise.all(SIGNING_SECRET_PARAMS.map((p) => getSecret(p)));
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

  if (body.type === 'url_verification') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: body.challenge }),
    };
  }

  if (!(await verifyWithAnySecret(event.headers ?? {}, rawBody))) {
    console.warn('[receiver] signature verification failed');
    return { statusCode: 401, body: 'invalid signature' };
  }

  const ev = body.event;
  if (ev?.type !== 'app_mention') {
    return { statusCode: 200, body: 'ok' };
  }

  const cfg = await loadAgentConfig();

  // Identify the sender: a human, one of our 4 agents, or a foreign bot.
  let senderAgent: AgentName | undefined;
  if (ev.bot_id) {
    senderAgent = agentByBotId(cfg, ev.bot_id);
    if (!senderAgent) {
      console.info(`[receiver] ignoring message from non-allowlisted bot ${ev.bot_id}`);
      return { statusCode: 200, body: 'ok' };
    }
  }

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

// Re-export for processor-side type imports.
export { AGENT_NAMES };
