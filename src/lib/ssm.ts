// =============================================================================
// ssm.ts — SSM Parameter Store からのシークレット・設定取得
//
// Bot Token・Signing Secret・API キー・エージェント構成（AGENT_CONFIG）・
// 役割プロンプトはすべて SSM で管理し、コードや環境変数には一切持たない。
// これにより、プロンプトやエージェント構成の変更はコード修正・再デプロイなしで
// 「SSM パラメータの更新」だけで反映できる。
// =============================================================================
import { SSMClient, GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

// キャッシュ TTL：短すぎると毎起動 SSM を叩いてレイテンシ・コストが増え、
// 長すぎる（無期限だ）とプロンプト更新が Lambda 再デプロイまで反映されない。
// 60秒なら「SSM 更新後、約1分以内に全エージェントへ反映」を保証できる
const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

// モジュールレベルのキャッシュ：Lambda はコンテナを再利用するため、
// TTL 内の連続呼び出しでは SSM へのアクセスが発生しない
const cache = new Map<string, CacheEntry>();

/**
 * SSM のパラメータ（SecureString は復号して）を取得する。
 * パラメータが存在しない場合は '' を返す（任意設定のシークレット未登録を
 * 「機能無効」として扱えるようにし、例外で落とさない）。
 */
export async function getSecret(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = res.Parameter?.Value ?? '';
    cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    if (err instanceof ParameterNotFound) {
      // 「存在しない」も TTL 付きでキャッシュする（後から登録されたら拾えるように）
      cache.set(name, { value: '', expiresAt: Date.now() + CACHE_TTL_MS });
      return '';
    }
    throw err;
  }
}
