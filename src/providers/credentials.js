import { sanitizedError } from './errors.js';

export const credentialSecrets = (config) => [...new Set([config.apiKey, ...(config.apiKeys || []).map((key) => key.apiKey)].filter(Boolean))];

export function credentialPool(config) {
  if (!config.credentialPool) config.credentialPool = { active: 0, unavailable: new Map() };
  return config.credentialPool;
}

// Only explicit HTTP rejections before a response body is accepted are retried.
// A failed/incomplete stream, timeout, network error, or tool action is never replayed.
export async function withCredentials({ config = {}, signal, onCredential }, operation) {
  const keys = config.apiKeys?.length ? config.apiKeys : [{ label: 'primary', apiKey: config.apiKey }];
  const mode = config.keyRotation || 'failover';
  const pool = credentialPool(config);
  const attempted = new Set();
  let index = pool.active % keys.length;
  const available = (number) => !attempted.has(number) && (pool.unavailable.get(keys[number].label) || 0) <= Date.now();
  if (mode !== 'off' && !available(index)) index = keys.findIndex((_key, number) => available(number));
  if (index < 0) throw new Error('All API keys are unavailable or cooling down. Use /auth to inspect or change credentials.');
  while (true) {
    if (signal?.aborted) throw sanitizedError(new Error(signal.reason?.name === 'AbortError' ? 'API request cancelled.' : signal.reason?.message || 'API request cancelled.'), credentialSecrets(config));
    attempted.add(index);
    try {
      const result = await operation({ ...config, apiKey: keys[index].apiKey });
      pool.active = mode === 'round-robin' ? (index + 1) % keys.length : index;
      return result;
    } catch (error) {
      if (signal?.aborted) throw sanitizedError(error, credentialSecrets(config));
      const rejected = [401, 402, 403, 429].includes(error.status);
      if (rejected && keys.length > 1 && mode !== 'off') pool.unavailable.set(keys[index].label, error.status === 401 || error.status === 403 ? Infinity : Date.now() + Math.max(1000, error.retryAfterMs ?? 30000));
      const next = mode === 'off' || !rejected ? -1 : keys.findIndex((_key, number) => available(number));
      if (next < 0) throw sanitizedError(error, credentialSecrets(config));
      await onCredential?.({ from: keys[index].label, to: keys[next].label, status: error.status,
        reason: error.status === 429 ? 'rate limit' : error.status === 402 ? 'credit rejection' : 'authentication/access rejection' });
      pool.active = index = next;
    }
  }
}
