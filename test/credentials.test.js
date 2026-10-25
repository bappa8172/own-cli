import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { temporary, cli, server } from '../support/fixtures.js';
import { storeCredential, loadCredentials, loadCredential, vaultStatus, removeCredential, configureCredentials } from '../src/config-vault.js';
import { loadConfig } from '../src/config.js';
import { createResponse, listModels } from '../src/client.js';
import { createRuntime } from '../src/core/runtime.js';

const messages = [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'hello' }];
function config(extra = {}) { return { model: 'fixture', apiKey: 'first-private', apiKeys: [{ label: 'first', apiKey: 'first-private' }, { label: 'second', apiKey: 'second-private' }], baseUrl: 'https://example.test/v1', ...extra }; }
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

test('encrypted named keyring preserves old login semantics, switches primary, configures rotation and removes one key', async (t) => {
  const env = { OWN_CODEX_HOME: await temporary(t), OWN_CODEX_VAULT_KEY: 'fixture-master-key-longer-than-32-characters' };
  const options = { env, platform: 'linux' };
  await storeCredential('apinex', 'first-private', options);
  await Promise.all(['backup', 'third'].map((label) => storeCredential('apinex', label + '-private', { ...options, label, add: true })));
  assert.equal((await loadCredentials('apinex', options)).keys.length, 3);
  assert.equal(await loadCredential('apinex', options), 'first-private');
  await assert.rejects(storeCredential('apinex', 'do-not-overwrite', { ...options, label: 'backup', add: true }), /already exists/);
  await configureCredentials('apinex', { active: 'backup', rotation: 'round-robin' }, options);
  assert.equal(await loadCredential('apinex', options), 'backup-private');
  const status = (await vaultStatus(options))[0];
  assert.equal(status.rotation, 'round-robin'); assert.equal(status.keys.find((key) => key.active).label, 'backup');
  assert.doesNotMatch(JSON.stringify(status), /private/);
  assert.doesNotMatch(await fs.readFile(path.join(env.OWN_CODEX_HOME, 'vault.json'), 'utf8'), /first-private|backup-private|third-private/);
  await removeCredential('apinex', { ...options, label: 'backup' });
  assert.equal((await loadCredentials('apinex', options)).keys.length, 2);
  await assert.rejects(configureCredentials('apinex', { active: 'missing' }, options), /Unknown/);
  await storeCredential('apinex', 'replaced', options);
  assert.equal((await loadCredentials('apinex', options)).keys.length, 2);
  assert.equal(await loadCredential('apinex', options), 'replaced');
});

test('legacy single encrypted record upgrades without losing its key', async (t) => {
  const env = { OWN_CODEX_HOME: await temporary(t), OWN_CODEX_VAULT_KEY: 'fixture-master-key-longer-than-32-characters' };
  const options = { env, platform: 'linux' };
  await storeCredential('apinex', 'legacy-private', options);
  const file = path.join(env.OWN_CODEX_HOME, 'vault.json'); const vault = JSON.parse(await fs.readFile(file, 'utf8'));
  vault.credentials.apinex = vault.credentials.apinex.keys[0]; delete vault.credentials.apinex.label;
  await fs.writeFile(file, JSON.stringify(vault));
  assert.equal(await loadCredential('apinex', options), 'legacy-private');
  await storeCredential('apinex', 'backup-private', { ...options, label: 'backup', add: true });
  assert.equal((await loadCredentials('apinex', options)).keys.length, 2);
});

for (const status of [401, 402, 403, 429]) test(`HTTP ${status} switches keys once and keeps the same model and request`, async () => {
  const cfg = config(); const seen = []; const changes = [];
  const fetchImpl = async (_url, request) => {
    seen.push({ key: request.headers.authorization, payload: JSON.parse(request.body) });
    return seen.length === 1 ? json({ error: 'rejected' }, status, { 'retry-after': '60' }) : json({ output_text: 'done', usage: { input_tokens: 4, output_tokens: 2 } });
  };
  const result = await createResponse({ config: cfg, messages, stream: false, fetchImpl, onCredential: (change) => { changes.push(change); } });
  assert.equal(result.text, 'done'); assert.equal(seen.length, 2);
  assert.equal(seen[0].key, 'Bearer first-private'); assert.equal(seen[1].key, 'Bearer second-private');
  assert.deepEqual(seen[0].payload, seen[1].payload);
  assert.deepEqual(changes[0], { from: 'first', to: 'second', status, reason: status === 429 ? 'rate limit' : status === 402 ? 'credit rejection' : 'authentication/access rejection' });
  await createResponse({ config: cfg, messages, stream: false, fetchImpl });
  assert.equal(seen[2].key, 'Bearer second-private');
});

test('round-robin rotates successful requests while off never retries', async () => {
  const cfg = config({ keyRotation: 'round-robin' }); const seen = [];
  const fetchImpl = async (_url, request) => { seen.push(request.headers.authorization); return json({ output_text: 'ok' }); };
  for (let i = 0; i < 3; i++) await createResponse({ config: cfg, messages, fetchImpl });
  assert.deepEqual(seen, ['Bearer first-private', 'Bearer second-private', 'Bearer first-private']);
  let attempts = 0;
  await assert.rejects(createResponse({ config: config({ keyRotation: 'off' }), messages, fetchImpl: async () => { attempts++; return json({}, 429); } }), /429/);
  assert.equal(attempts, 1);
});

test('exhausted keys fail without loops and errors redact every configured key', async () => {
  const cfg = config(); let attempts = 0;
  const request = () => createResponse({ config: cfg, messages, fetchImpl: async () => { attempts++; return json({ error: 'first-private second-private' }, 401); } });
  await assert.rejects(request(), (error) => { assert.doesNotMatch(error.message, /first-private|second-private/); return /401/.test(error.message); });
  assert.equal(attempts, 2);
  await assert.rejects(request(), /All API keys/);
  assert.equal(attempts, 2);
});

test('cooldown expiration and manual reset make rejected keys available again', async () => {
  const cfg = config(); let attempts = 0;
  await assert.rejects(createResponse({ config: cfg, messages, fetchImpl: async () => { attempts++; return json({}, 429, { 'retry-after': '60' }); } }), /429/);
  cfg.credentialPool.unavailable.set('first', Date.now() - 1);
  const result = await createResponse({ config: cfg, messages, fetchImpl: async () => { attempts++; return json({ output_text: 'recovered' }); } });
  assert.equal(result.text, 'recovered'); assert.equal(attempts, 3);
});

test('network errors, server errors and incomplete streamed responses are never retried', async () => {
  for (const failure of ['network', 'server', 'stream']) {
    let attempts = 0; let printed = '';
    await assert.rejects(createResponse({ config: config(), messages, onDelta: (delta) => { printed += delta; }, fetchImpl: async () => {
      attempts++;
      if (failure === 'network') throw new Error('connection lost');
      if (failure === 'server') return json({}, 503);
      return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } }));
    assert.equal(attempts, 1);
    assert.equal(printed, failure === 'stream' ? 'partial' : '');
  }
});

test('model catalog failover and native provider requests use the proper key headers', async () => {
  for (const wireApi of ['anthropic', 'gemini']) {
    let count = 0;
    const header = wireApi === 'anthropic' ? 'x-api-key' : 'x-goog-api-key';
    const result = await createResponse({ config: config({ wireApi }), messages, stream: false, fetchImpl: async (_url, request) => {
      count++; assert.equal(request.headers[header], count === 1 ? 'first-private' : 'second-private');
      if (count === 1) return json({}, 401);
      return json(wireApi === 'anthropic' ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
        : { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    } });
    assert.equal(result.text, 'ok'); assert.equal(count, 2);
  }
  let count = 0;
  const models = await listModels({ config: config(), fetchImpl: async () => ++count === 1 ? json({}, 429) : json({ data: [{ id: 'free/fixture' }] }) });
  assert.equal(models[0].id, 'free/fixture'); assert.equal(count, 2);
});

test('rotation during an agent turn records rejected attempts honestly and redacts all active credentials', async (t) => {
  const root = await temporary(t); let requests = 0;
  const api = await server(t, (_request, response) => {
    requests++; response.writeHead(requests === 1 ? 429 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(requests === 1 ? { error: 'limit' } : { output_text: 'done first-private second-private', usage: { input_tokens: 10, output_tokens: 2 } }));
  });
  const runtime = await createRuntime({ config: config({ baseUrl: api.baseUrl }), options: { root, env: { OWN_CODEX_HOME: await temporary(t) } } });
  try {
    const result = await runtime.run({ messages, stream: false });
    assert.equal(result.accounting.requests, 2); assert.equal(result.accounting.usageComplete, false);
    assert.equal(result.accounting.reportedCost, null);
    const events = runtime.session.events; assert.equal(events.filter((event) => event.type === 'credential.switched').length, 1);
    assert.doesNotMatch(JSON.stringify(events), /first-private|second-private/);
  } finally { await runtime.close(); }
});

test('strict budgets stop after an unmetered rejection before trying another key', async (t) => {
  let count = 0; const root = await temporary(t);
  const api = await server(t, (_request, response) => { count++; response.writeHead(429); response.end('{}'); });
  const runtime = await createRuntime({ config: config({ baseUrl: api.baseUrl }), options: { root, maxTokens: 100, env: { OWN_CODEX_HOME: await temporary(t) } } });
  try {
    await assert.rejects(runtime.run({ messages }), (error) => { assert.equal(error.accounting.requests, 1); return /omitted token usage/.test(error.message); });
    assert.equal(count, 1);
  } finally { await runtime.close(); }
});

test('CLI supports multiple encrypted keys and slash auth never consumes pasted chat lines as keys', { skip: process.platform !== 'win32' }, async (t) => {
  const env = { OWN_CODEX_HOME: await temporary(t) }; const root = await temporary(t);
  for (const label of ['primary', 'backup']) {
    const result = await cli(['auth', 'add', '--label', label, '--stdin-key'], { env, input: label + '-private\n' });
    assert.equal(result.code, 0, result.stderr); assert.doesNotMatch(result.stdout + result.stderr, /primary-private|backup-private/);
  }
  const cfg = await loadConfig({ env }); assert.equal(cfg.apiKeys.length, 2);
  const use = await cli(['auth', 'use', 'backup'], { env }); assert.equal(use.code, 0, use.stderr);
  assert.equal((await loadConfig({ env })).apiKeys[0].label, 'backup');
  const mode = await cli(['auth', 'rotate', 'round-robin'], { env }); assert.equal(mode.code, 0, mode.stderr);
  const chat = await cli(['chat', '--root', root, '--no-context'], { env, input: '/auth status\n/auth rotate off\n/auth next\n/auth add\n/exit\n' });
  assert.equal(chat.code, 1); assert.match(chat.stdout, /round-robin|Active key/); assert.match(chat.stderr, /stdin-key/);
  const events = (await fs.readdir(path.join(env.OWN_CODEX_HOME, 'projects'))).length;
  assert.ok(events > 0);
  const overridden = await loadConfig({ env: { ...env, APINEX_API_KEY: 'environment-private' } });
  assert.equal(overridden.apiKeys.length, 3);
  assert.equal(overridden.apiKeys[0].label, '$environment');
});
