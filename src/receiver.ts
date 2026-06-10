import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getSecret } from './lib/ssm';
import { verifySlackSignature } from './lib/slack';

const sqs = new SQSClient({});
const ssm = new SSMClient({});
const SIGNING_SECRET_PARAM =
  process.env.SLACK_SIGNING_SECRET_PARAM ?? '/claude-bot/SLACK_SIGNING_SECRET';
const AGENT_CONFIG_PARAM =
  process.env.AGENT_CONFIG_PARAM ?? '/claude-bot/AGENT_CONFIG';

interface AgentConfig {
  userId: string;
  sqsQueueUrl: string;
  botTokenParam: string;
}

async function getAgentConfig(): Promise<Record<string, AgentConfig>> {
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: AGENT_CONFIG_PARAM, WithDecryption: false }),
    );
    return JSON.parse(res.Parameter?.Value ?? '{}');
  } catch {
    console.warn(`Agent config not found at ${AGENT_CONFIG_PARAM}`);
    return {};
  }
}

function extractMentionedBotId(text: string): string {
  const match = text.match(/^<@([A-Z0-9]+)>/);
  return match?.[1] ?? '';
}

/**
 * API Gateway entry point. Validates the Slack request, routes app_mention
 * events to the appropriate agent's SQS queue, and returns 200 immediately
 * (Slack requires a response within 3 seconds).
 */
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

  console.log('request received', {
    type: body.type,
    eventType: body.event?.type,
    hasSlackSig: Boolean(event.headers?.['x-slack-signature']),
  });

  // Slack URL verification — only sent once while enabling Event Subscriptions.
  if (body.type === 'url_verification') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: body.challenge }),
    };
  }

  // Verify the request really came from Slack. Skipped (with a warning) if the
  // signing secret has not been registered in SSM yet.
  const signingSecret = await getSecret(SIGNING_SECRET_PARAM);
  if (signingSecret) {
    if (!verifySlackSignature(signingSecret, event.headers ?? {}, rawBody)) {
      console.warn('signature verification FAILED — request rejected (401)');
      return { statusCode: 401, body: 'invalid signature' };
    }
  } else {
    console.warn(
      `Signing secret ${SIGNING_SECRET_PARAM} is not set in SSM — skipping signature verification. ` +
        'Set it to secure this endpoint.',
    );
  }

  // Ignore bot messages to prevent loops.
  if (body.event?.bot_id) {
    console.info('Ignoring bot message to prevent infinite loop');
    return { statusCode: 200, body: 'ok' };
  }

  // Route app_mention to the target agent's SQS queue.
  if (body.event?.type === 'app_mention') {
    const slackEvent = body.event;
    const mentionedBotId = extractMentionedBotId(slackEvent.text);

    const agentConfig = await getAgentConfig();
    const targetAgent = Object.entries(agentConfig).find(
      ([_, a]) => a.userId === mentionedBotId,
    );

    if (targetAgent) {
      const [agentName, agent] = targetAgent;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: agent.sqsQueueUrl,
          MessageBody: JSON.stringify(slackEvent),
        }),
      );
      console.log(`Routed app_mention to ${agentName}`, { queueUrl: agent.sqsQueueUrl });
    } else {
      console.warn(`Unknown bot mentioned: ${mentionedBotId}`);
    }
  }

  return { statusCode: 200, body: 'ok' };
};
