export function httpError(response, detail, prefix = 'API request failed') {
  const error = new Error(`${prefix} (${response.status}${response.statusText ? ' ' + response.statusText : ''}): ${detail || '(empty response)'}`);
  error.status = response.status;
  const retry = response.headers.get('retry-after');
  const delay = retry && (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now());
  if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, Math.min(delay, 86400000));
  return error;
}

export function sanitizedError(error, secrets = [], message = error.message) {
  const clean = secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(message));
  const result = new Error(clean);
  if (Number.isInteger(error.status)) result.status = error.status;
  if (Number.isFinite(error.retryAfterMs)) result.retryAfterMs = error.retryAfterMs;
  return result;
}
