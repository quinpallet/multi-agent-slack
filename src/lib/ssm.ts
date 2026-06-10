import { SSMClient, GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

// Module-level cache: Lambda reuses the container across invocations, so we only
// hit SSM once per cold start per parameter.
const cache = new Map<string, string>();

/**
 * Fetch a (decrypted) SecureString from SSM Parameter Store.
 * Returns '' if the parameter does not exist, so callers can treat an unset
 * optional secret as "feature disabled" rather than crashing.
 */
export async function getSecret(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = res.Parameter?.Value ?? '';
    cache.set(name, value);
    return value;
  } catch (err) {
    if (err instanceof ParameterNotFound) {
      cache.set(name, '');
      return '';
    }
    throw err;
  }
}
