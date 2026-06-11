import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { claimEvent, bumpHops, bumpWriterMentions, appendHistory, findTaskIdByThread } from '../src/lib/store';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('claimEvent（重複排除）', () => {
  it('未処理イベントは true（条件付き Put 成功）', async () => {
    ddbMock.on(PutCommand).resolves({});
    expect(await claimEvent('C1:123.456:researcher')).toBe(true);

    const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.Item?.pk).toBe('event#C1:123.456:researcher');
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('処理済みイベント（条件失敗）は false', async () => {
    ddbMock.on(PutCommand).rejects(
      new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
    );
    expect(await claimEvent('C1:123.456:researcher')).toBe(false);
  });

  it('その他のエラーは再スローする', async () => {
    ddbMock.on(PutCommand).rejects(new Error('throughput exceeded'));
    await expect(claimEvent('k')).rejects.toThrow('throughput exceeded');
  });
});

describe('カウンタ（ホップ・修正回数ガードの基盤）', () => {
  it('bumpHops はインクリメント後の値を返す', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { hops: 7 } });
    expect(await bumpHops('t1')).toBe(7);

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key?.pk).toBe('task#t1');
    expect(input.UpdateExpression).toBe('ADD #a :one');
  });

  it('bumpWriterMentions は writerMentions を更新する', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { writerMentions: 4 } });
    expect(await bumpWriterMentions('t1')).toBe(4);
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeNames).toEqual({ '#a': 'writerMentions' });
  });
});

describe('appendHistory', () => {
  it('20,000字を超えるエントリは切り詰めて保存する', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { history: [] } });

    await appendHistory('t1', [{ author: 'writer', text: 'あ'.repeat(30000) }]);

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    const saved = (input.ExpressionAttributeValues?.[':e'] as any[])[0];
    expect(saved.text.length).toBeLessThan(20100);
    expect(saved.text).toContain('（長文のため省略）');
  });

  it('履歴が60件以下なら切り詰め用の2回目更新は行わない', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { history: [{ author: 'a', text: 'b' }] } });

    await appendHistory('t1', [{ author: 'user', text: 'hello' }]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it('履歴が60件を超えたら古い順に削除する', async () => {
    const long = Array.from({ length: 70 }, (_, i) => ({ author: 'a', text: `m${i}` }));
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { history: long } });

    await appendHistory('t1', [{ author: 'user', text: 'hello' }]);

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2);
    const rewritten = calls[1].args[0].input.ExpressionAttributeValues?.[':h'] as any[];
    expect(rewritten).toHaveLength(60);
    expect(rewritten[0].text).toBe('m10'); // 先頭10件が削られる
  });

  it('空配列なら何もしない', async () => {
    await appendHistory('t1', []);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe('findTaskIdByThread', () => {
  it('thread ポインタから taskId を返す', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { taskId: 'abc123' } });
    expect(await findTaskIdByThread('C1', '111.222')).toBe('abc123');
    const input = ddbMock.commandCalls(GetCommand)[0].args[0].input;
    expect(input.Key?.pk).toBe('thread#C1:111.222');
  });

  it('未登録スレッドは undefined', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await findTaskIdByThread('C1', '111.222')).toBeUndefined();
  });
});
