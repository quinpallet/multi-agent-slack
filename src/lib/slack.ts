// =============================================================================
// slack.ts — Slack Web API クライアント（署名検証・メッセージ投稿・ファイル添付）
// =============================================================================
import crypto from 'crypto';

/**
 * リクエストが本物の Slack から来たことを Signing Secret で検証する。
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

  // リプレイ攻撃対策：5分より古いリクエストは署名が正しくても拒否する
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

  // タイミング攻撃対策のため通常の文字列比較ではなく timingSafeEqual を使う
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface PostMessageArgs {
  channel: string;
  text: string;
  /** 指定するとそのスレッドへの返信になる。省略時はチャンネル直下に投稿 */
  thread_ts?: string;
}

/**
 * chat.postMessage でメッセージを投稿する。
 * Slack API は HTTP 200 でも ok:false でエラーを返すため、必ず ok を確認する。
 */
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
  /** 添付メッセージに付けるコメント（task_id 付与済みの文字列を渡す） */
  initialComment?: string;
}

/**
 * files.uploadV2 相当の3ステップでファイルを添付する：
 *   1. files.getUploadURLExternal でアップロード先 URL を取得
 *   2. その URL へファイル本体を直接 POST
 *   3. files.completeUploadExternal でチャンネル・スレッドへの共有を確定
 * 注意: getUploadURLExternal は form-urlencoded しか受け付けない
 * （JSON で送ると invalid_arguments になる。検証済みの仕様）。
 */
export async function uploadFile(botToken: string, args: UploadFileArgs): Promise<void> {
  // length はファイルのバイト数。日本語等のマルチバイト文字があるため
  // 文字数ではなく Buffer.byteLength で算出する
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

  // 共有確定。thread_ts を渡すことで成果物がタスクのスレッド内に添付される
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
