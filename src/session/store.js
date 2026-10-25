import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function projectStore(root, env = process.env) {
  const home = env.OWN_CODEX_HOME || path.join(os.homedir(), '.own-codex');
  return path.join(home, 'projects', digest(path.resolve(root)).slice(0, 24));
}
function safeId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid session ID.');
  return id;
}
export async function readEvents(directory, { repairTail = false } = {}) {
  let data;
  try { data = await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const boundary = data.lastIndexOf('\n') + 1;
  if (boundary < data.length) {
    if (repairTail) await fs.truncate(path.join(directory, 'events.jsonl'), Buffer.byteLength(data.slice(0, boundary)));
    data = data.slice(0, boundary);
  }
  const events = [];
  let previous = '0'.repeat(64);
  for (const line of data.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('Session log contains invalid JSON.'); }
    const { hash, ...record } = event;
    if (record.previous !== previous || digest(JSON.stringify(record)) !== hash) throw new Error('Session audit chain verification failed.');
    previous = hash; events.push(event);
  }
  return events;
}

export async function listSessions(root, env = process.env) {
  root = await fs.realpath(root);
  const base = path.join(projectStore(root, env), 'sessions');
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const sessions = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^[a-zA-Z0-9-]+$/.test(item.name))) {
    const events = await readEvents(path.join(base, entry.name));
    const first = events.find((event) => event.type === 'session.started');
    if (first) sessions.push({ id: entry.name, root: first.data.root, started: first.time,
      updated: events.at(-1)?.time, turns: events.filter((event) => event.type === 'turn.completed').length,
      lastPrompt: events.findLast((event) => ['message.user', 'request.received'].includes(event.type))?.data.content?.slice(0, 160) || '' });
  }
  return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function openSession({ root, id, env = process.env } = {}) {
  root = await fs.realpath(root);
  const sessionId = id ? safeId(id) : randomUUID();
  const directory = path.join(projectStore(root, env), 'sessions', sessionId);
  if (id) await fs.access(path.join(directory, 'events.jsonl'));
  await fs.mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, 'lock.json');
  const token = randomUUID();
  async function lock() {
    try { await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      let active = true;
      try { process.kill(existing.pid, 0); } catch (problem) { if (problem.code === 'ESRCH') active = false; }
      if (active) throw new Error('Session is already open in another process. Close it before resuming.');
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    }
  }
  await lock();
  let events;
  try { events = await readEvents(directory, { repairTail: true }); }
  catch (error) { await fs.unlink(lockPath); throw error; }
  if (events[0]?.data.root !== undefined && events[0].data.root !== root) { await fs.unlink(lockPath); throw new Error('Session belongs to a different project.'); }
  let previous = events.at(-1)?.hash || '0'.repeat(64);
  let pending = Promise.resolve();
  let closed = false;
  const store = {
    id: sessionId, root, directory, events,
    append(event) {
      if (closed) return Promise.reject(new Error('Session store is closed.'));
      if (!event || typeof event.type !== 'string' || !event.type) return Promise.reject(new Error('A session event type is required.'));
      pending = pending.then(async () => {
        const record = { ...event, id: event.id || randomUUID(), time: event.time || new Date().toISOString(), sequence: events.length, previous };
        const item = { ...record, hash: digest(JSON.stringify(record)) };
        const handle = await fs.open(path.join(directory, 'events.jsonl'), 'a', 0o600);
        try { await handle.writeFile(JSON.stringify(item) + '\n'); await handle.sync(); } finally { await handle.close(); }
        previous = item.hash; events.push(item); return item;
      });
      return pending;
    },
    history() {
      const history = [];
      for (const event of events) {
      if (event.type === 'conversation.cleared') history.length = 0;
      if (event.type === 'turn.undone') history.push({ role: 'user', content: 'Undo the previous recorded changes.' }, { role: 'assistant', content: JSON.stringify(event.data) });
      if (event.type === 'turn.completed') {
        const prompt = events.find((item) => item.type === 'message.user' && item.data.turnId === event.data.turnId);
        if (prompt) history.push({ role: 'user', content: prompt.data.content }, { role: 'assistant', content: event.data.text });
      }
      }
      return history;
    },
    async artifact(content) {
      const id = digest(content);
      const folder = path.join(directory, 'artifacts');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, id + '.txt'), content, { mode: 0o600 });
      return { artifactId: id, chars: content.length };
    },
    async readArtifact(id, offset = 0, limit = 24000) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid artifact ID.');
      const text = await fs.readFile(path.join(directory, 'artifacts', id + '.txt'), 'utf8');
      return { artifactId: id, content: text.slice(offset, offset + limit), nextOffset: Math.min(offset + limit, text.length), truncated: offset + limit < text.length };
    },
    async close() {
      closed = true;
      try { await pending; } finally {
        const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (current.token === token) await fs.unlink(lockPath);
      }
    },
  };
  if (!events.length) await store.append({ type: 'session.started', time: new Date().toISOString(), data: { root } });
  return store;
}
