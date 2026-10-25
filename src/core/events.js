import { randomUUID } from 'node:crypto';

export function createEventStream({ listeners = [], session, secrets = [] } = {}) {
  const subscribers = new Set(listeners);
  const clean = (value) => {
    if (typeof value === 'string') return (typeof secrets === 'function' ? secrets() : secrets).filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return {
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    async emit(type, data = {}) {
      const event = { id: randomUUID(), time: new Date().toISOString(), type, data: clean(data) };
      // Token chunks are transient; model.completed durably records the assembled text.
      if (session && type !== 'token.delta') await session.append(event);
      for (const listener of subscribers) await listener(event);
      return event;
    },
  };
}
