import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { verifySlackSignature, postMessage, uploadFile } from '../src/lib/slack';

const SECRET = 'test-signing-secret';

function sign(secret: string, ts: string, body: string): string {
  return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
}

function headersFor(body: string, secret = SECRET, ts = String(Math.floor(Date.now() / 1000))) {
  return {
    'x-slack-request-timestamp': ts,
    'x-slack-signature': sign(secret, ts, body),
  };
}

describe('verifySlackSignature', () => {
  it('正しい署名を受理する', () => {
    const body = '{"type":"event_callback"}';
    expect(verifySlackSignature(SECRET, headersFor(body), body)).toBe(true);
  });

  it('別の secret で作られた署名を拒否する', () => {
    const body = '{"type":"event_callback"}';
    expect(verifySlackSignature(SECRET, headersFor(body, 'wrong-secret'), body)).toBe(false);
  });

  it('本文が改竄された署名を拒否する', () => {
    const body = '{"type":"event_callback"}';
    expect(verifySlackSignature(SECRET, headersFor(body), body + 'x')).toBe(false);
  });

  it('5分より古いタイムスタンプを拒否する（リプレイ防止）', () => {
    const body = '{}';
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    expect(verifySlackSignature(SECRET, headersFor(body, SECRET, oldTs), body)).toBe(false);
  });

  it('ヘッダ欠落を拒否する', () => {
    expect(verifySlackSignature(SECRET, {}, '{}')).toBe(false);
  });
});

describe('postMessage', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('chat.postMessage を Bearer トークン付きで呼ぶ', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) });
    await postMessage('xoxb-token', { channel: 'C1', text: 'hello', thread_ts: '1.2' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.headers.Authorization).toBe('Bearer xoxb-token');
    expect(JSON.parse(init.body)).toEqual({ channel: 'C1', text: 'hello', thread_ts: '1.2' });
  });

  it('ok:false なら例外を投げる', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'channel_not_found' }) });
    await expect(postMessage('t', { channel: 'C1', text: 'x' })).rejects.toThrow('channel_not_found');
  });
});

describe('uploadFile (files.uploadV2 3段階フロー)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('form-urlencoded で URL 取得 → raw POST → complete の順に呼ぶ', async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, upload_url: 'https://files.example/up', file_id: 'F123' }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ json: async () => ({ ok: true }) });

    await uploadFile('xoxb-token', {
      channel: 'C1',
      threadTs: '1.2',
      filename: 'report.md',
      content: '# レポート',
      initialComment: '完成しました [task_id:abc]',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Step1: getUploadURLExternal は JSON 不可、form-urlencoded で送る（実機で検証済みの仕様）
    const [url1, init1] = fetchMock.mock.calls[0];
    expect(url1).toBe('https://slack.com/api/files.getUploadURLExternal');
    expect(init1.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = init1.body as URLSearchParams;
    expect(form.get('filename')).toBe('report.md');
    expect(form.get('length')).toBe(String(Buffer.byteLength('# レポート', 'utf-8')));

    // Step2: 取得した upload_url へ raw POST
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url2).toBe('https://files.example/up');
    expect(init2.body).toBe('# レポート');

    // Step3: completeUploadExternal
    const [url3, init3] = fetchMock.mock.calls[2];
    expect(url3).toBe('https://slack.com/api/files.completeUploadExternal');
    const payload = JSON.parse(init3.body);
    expect(payload.files).toEqual([{ id: 'F123', title: 'report.md' }]);
    expect(payload.channel_id).toBe('C1');
    expect(payload.thread_ts).toBe('1.2');
    expect(payload.initial_comment).toContain('[task_id:abc]');
  });

  it('getUploadURLExternal が ok:false なら例外を投げる', async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'invalid_auth' }) });
    await expect(
      uploadFile('t', { channel: 'C1', filename: 'a.md', content: 'x' }),
    ).rejects.toThrow('invalid_auth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('アップロード先が HTTP エラーなら例外を投げる', async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, upload_url: 'https://files.example/up', file_id: 'F1' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(
      uploadFile('t', { channel: 'C1', filename: 'a.md', content: 'x' }),
    ).rejects.toThrow('HTTP 500');
  });
});
