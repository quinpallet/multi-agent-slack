import crypto from 'crypto';

/**
 * Verify that a request genuinely came from Slack using the signing secret.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signingSecret: string,
  headers: Record<string, string | undefined>,
  rawBody: string,
): boolean {
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes to mitigate replay attacks.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface PostMessageArgs {
  channel: string;
  text: string;
  thread_ts?: string;
}

/** Post a message to Slack via chat.postMessage. */
export async function postMessage(botToken: string, args: PostMessageArgs): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(args),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error}`);
  }
}

export interface UploadFileArgs {
  channel: string;
  threadTs?: string;
  filename: string;
  content: string;
  initialComment?: string;
}

/**
 * Upload a file via the files.uploadV2 flow
 * (getUploadURLExternal -> raw POST -> completeUploadExternal).
 * Note: getUploadURLExternal only accepts form-urlencoded args, not JSON.
 */
export async function uploadFile(botToken: string, args: UploadFileArgs): Promise<void> {
  const form = new URLSearchParams({
    filename: args.filename,
    length: String(Buffer.byteLength(args.content, 'utf-8')),
  });
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${botToken}`,
    },
    body: form,
  });
  const urlData = (await urlRes.json()) as {
    ok: boolean;
    error?: string;
    upload_url?: string;
    file_id?: string;
  };
  if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
    throw new Error(`Slack files.getUploadURLExternal failed: ${urlData.error}`);
  }

  const upRes = await fetch(urlData.upload_url, { method: 'POST', body: args.content });
  if (!upRes.ok) {
    throw new Error(`Slack file upload failed: HTTP ${upRes.status}`);
  }

  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title: args.filename }],
      channel_id: args.channel,
      thread_ts: args.threadTs,
      initial_comment: args.initialComment,
    }),
  });
  const completeData = (await completeRes.json()) as { ok: boolean; error?: string };
  if (!completeData.ok) {
    throw new Error(`Slack files.completeUploadExternal failed: ${completeData.error}`);
  }
}
