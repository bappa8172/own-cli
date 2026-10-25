import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { temporary, write } from '../support/fixtures.js';
import { openSession, readEvents, listSessions } from '../src/session/store.js';
import { createEventStream } from '../src/core/events.js';
import { UsageLedger, normalizeUsage } from '../src/core/accounting.js';
import { compactHistory, boundObservation } from '../src/core/compactor.js';
import { createPermissionEngine } from '../src/permissions/engine.js';
import { createRuntime } from '../src/core/runtime.js';
import { createSandbox } from '../src/sandbox/index.js';
import { storeCredential, loadCredential, vaultStatus, removeCredential } from '../src/config-vault.js';

const cfg = { model: 'test-model', maxOutputTokens: 100, wireApi: 'responses', apiKey: 'redact-this-key' };
const messages = [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'build' }];
const call = (id, name, args) => ({ text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], raw: { output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] }, usage: { input_tokens: 10, output_tokens: 5 } });
async function fixture(t, extra = {}) {
  const root = await temporary(t); const home = await temporary(t);
  const options = { root, env: { OWN_CODEX_HOME: home }, permissions: 'workspace', maxSteps: 10, ...extra };
  return { root, home, options };
}

test('sessions append in order, verify the audit chain, lock writers, resume history, and recover a partial tail', async (t) => {
  const { root, options } = await fixture(t);
  const session = await openSession({ root, env: options.env });
  await assert.rejects(openSession({ root, env: options.env, id: session.id }), /already open/);
  const events = createEventStream({ session, secrets: ['key-secret'] });
  await events.emit('message.user', { turnId: 't1', content: 'hello key-secret' });
  await events.emit('turn.completed', { turnId: 't1', text: 'answer' });
  assert.equal(session.history()[0].content, 'hello [redacted]');
  const pointer = await session.artifact('x'.repeat(50000));
  assert.equal((await session.readArtifact(pointer.artifactId)).truncated, true);
  await assert.rejects(session.readArtifact('../auth'), /Invalid artifact/);
  const id = session.id; const directory = session.directory;
  await session.close();
  await fs.appendFile(path.join(directory, 'events.jsonl'), '{"interrupted":');
  const resumed = await openSession({ root, env: options.env, id });
  assert.equal(resumed.history().length, 2);
  await resumed.append({ type: 'conversation.cleared', data: {}, time: new Date().toISOString() });
  assert.deepEqual(resumed.history(), []);
  await resumed.close();
  assert.equal((await listSessions(root, options.env))[0].id, id);
  const file = path.join(directory, 'events.jsonl');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('answer', 'tampered'));
  await assert.rejects(readEvents(directory), /chain verification/);
});

test('budget accounting distinguishes reported and computed dollars and fails closed without usage/rates', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 }, cost: 0.01, currency: 'USD' }),
    { input: 10, output: 5, cached: 4, total: 15, reportedCost: 0.01, available: true, breakdownComplete: true });
  const ledger = new UsageLedger({ maxTokens: 20, prices: { m: { input: 1, output: 2, cached: 0.5 } } });
  ledger.add('m', { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } });
  assert.equal(ledger.summary().reportedCost, null);
  assert.equal(ledger.before('m', [], [], 100), 5);
  assert.equal(ledger.summary().computedCost, 0.000018);
  assert.throws(() => new UsageLedger({ maxCost: 1 }).before('m', [], [], 100), /explicit input\/output prices/);
  assert.throws(() => new UsageLedger({ maxCost: 0.000001, prices: { m: { input: 10, output: 20 } } }).before('m', messages, [], 100), /exceed/);
  ledger.add('m', undefined);
  assert.throws(() => ledger.before('m', [], [], 100), /omitted token usage/);
});

test('compaction retains recent turns verbatim and large observations can be paged from disk', async (t) => {
  const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn-${index}` }));
  const compacted = compactHistory(history, { maxChars: 2000, recentTurns: 2 });
  assert.deepEqual(compacted.recent, history.slice(-4));
  assert.match(compacted.summary, /Earlier conversation excerpts/);
  const { root, options } = await fixture(t);
  const session = await openSession({ root, env: options.env });
  const output = await boundObservation({ ok: true, content: 'large'.repeat(10000) }, session, 100);
  assert.equal(output.truncated, true);
  assert.ok(output.artifactId);
  assert.match((await session.readArtifact(output.artifactId)).content, /large/);
  await session.close();
});

test('permission rules deny before execution and session approvals are scoped to the target', async () => {
  let approvals = 0;
  const policy = createPermissionEngine({ rules: [{ tool: 'run_command', action: 'deny', commandRegex: 'forbidden' }], approve: async ({ preview }) => { assert.ok(preview); approvals += 1; return 'session'; } });
  await assert.rejects(policy.check({ mode: 'all', name: 'run_command', args: { command: 'forbidden', args: [] }, preview: 'exact' }), /denied/);
  for (let count = 0; count < 2; count += 1) await policy.check({ mode: 'ask', name: 'write_file', args: { path: 'a.js' }, preview: 'diff' });
  await policy.check({ mode: 'ask', name: 'write_file', args: { path: 'b.js' }, preview: 'diff' });
  assert.equal(approvals, 2);
  await assert.rejects(createPermissionEngine().check({ mode: 'ask', name: 'write_file', args: {}, preview: 'diff' }), /Approval required/);
});

test('runtime resumes a completed edit, restores its backup on undo, and refuses to overwrite later manual changes', async (t) => {
  const { root, options } = await fixture(t);
  await write(root, 'a.txt', 'original');
  let step = 0;
  let runtime = await createRuntime({ config: cfg, options, responseImpl: async () => ++step === 1 ? call('edit1', 'edit_file', { path: 'a.txt', old_text: 'original', new_text: 'updated' }) : { text: 'done', usage: { input_tokens: 10, output_tokens: 2 } } });
  const result = await runtime.run({ messages, stream: false });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'updated');
  const id = result.sessionId;
  await runtime.close();
  runtime = await createRuntime({ config: cfg, options: { ...options, resume: id } });
  assert.equal(runtime.history.length, 2);
  await fs.writeFile(path.join(root, 'a.txt'), 'manual change');
  await assert.rejects(runtime.undo(), /Undo conflict/);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'manual change');
  await fs.writeFile(path.join(root, 'a.txt'), 'updated');
  assert.deepEqual((await runtime.undo()).restored, ['a.txt']);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'original');
  assert.deepEqual((await runtime.undo()).restored, []);
  await runtime.close();
});

test('undo handles multiple writes to one file and removes a newly created file', async (t) => {
  const { root, options } = await fixture(t);
  let step = 0;
  const runtime = await createRuntime({ config: cfg, options, responseImpl: async () => {
    if (++step === 1) return call('create', 'write_file', { path: 'new.txt', content: 'one' });
    if (step === 2) return call('edit', 'edit_file', { path: 'new.txt', old_text: 'one', new_text: 'two' });
    return { text: 'done' };
  } });
  await runtime.run({ messages, stream: false });
  await runtime.undo();
  await assert.rejects(fs.access(path.join(root, 'new.txt')));
  await runtime.close();
});

test('plan-first uses the planner model with read-only tools, then implements with the main model', async (t) => {
  const { options } = await fixture(t, { planFirst: true, plannerModel: 'planner' });
  const seen = [];
  const runtime = await createRuntime({ config: cfg, options, responseImpl: async (request) => {
    seen.push(request.config.model);
    if (request.config.model === 'planner') { assert.ok(!request.tools.some((tool) => tool.name === 'write_file')); return { text: '1. Inspect\n2. Edit\n3. Verify' }; }
    assert.ok(request.tools.some((tool) => tool.name === 'write_file'));
    assert.match(JSON.stringify(request.messages), /Current plan/);
    return { text: 'implemented' };
  } });
  await runtime.run({ messages, stream: false });
  assert.deepEqual(seen, ['planner', 'test-model']);
  await runtime.close();
});

test('plan-only mode prevents model-requested mutations even when the session normally permits them', async (t) => {
  const { root, options } = await fixture(t, { plan: true, permissions: 'all' });
  let step = 0;
  const runtime = await createRuntime({ config: cfg, options, responseImpl: async (request) => {
    assert.ok(!request.tools.some((tool) => tool.name === 'run_command'));
    if (++step === 1) return call('bad', 'write_file', { path: 'blocked', content: 'no' });
    assert.match(request.messages.at(-1).output, /unavailable|Read-only/);
    return { text: 'Plan only.' };
  } });
  await runtime.run({ messages, stream: false });
  await assert.rejects(fs.access(path.join(root, 'blocked')));
  assert.equal(runtime.workspace.permissions, 'all');
  await runtime.close();
});

test('wall-clock budgets interrupt a provider that ignores cancellation', async (t) => {
  const { options } = await fixture(t, { maxMs: 20 });
  const runtime = await createRuntime({ config: cfg, options, responseImpl: async () => new Promise(() => {}) });
  await assert.rejects(runtime.run({ messages }), /wall-clock budget/);
  assert.ok(runtime.session.events.some((event) => event.type === 'turn.failed'));
  assert.equal(runtime.session.events.at(-1).type, 'request.failed');
  await runtime.close();
});

test('provider-reported budget overrun stops tool execution and persists failed request state', async (t) => {
  const { root, options } = await fixture(t, { maxTokens: 10 });
  let runtime = await createRuntime({ config: cfg, options, responseImpl: async () => call('over', 'write_file', { path: 'blocked.txt', content: 'blocked' }) });
  await assert.rejects(runtime.run({ messages, stream: false }), (error) => {
    assert.match(error.message, /exceeded the turn budget/);
    assert.equal(error.accounting.totalTokens, 15);
    assert.equal(error.accounting.reportedCost, null);
    return true;
  });
  await assert.rejects(fs.access(path.join(root, 'blocked.txt')));
  const id = runtime.session.id;
  await runtime.close();
  runtime = await createRuntime({ config: cfg, options: { ...options, resume: id } });
  assert.equal(runtime.resumeState, 'failed');
  assert.deepEqual(runtime.history, []);
  await runtime.close();
});

test('deadline expiration before the first model call retains its budget stop reason', async (t) => {
  const { options } = await fixture(t, { maxMs: 5 });
  let calls = 0;
  const runtime = await createRuntime({ config: cfg, options,
    onEvent: async (event) => { if (event.type === 'turn.started') await new Promise((resolve) => setTimeout(resolve, 30)); },
    responseImpl: async () => { calls += 1; return { text: 'should not run' }; } });
  try {
    await assert.rejects(runtime.run({ messages, stream: false }), /wall-clock budget/);
    assert.equal(calls, 0);
  } finally { await runtime.close(); }
});

test('failed provider attempts leave accounting explicitly incomplete', async (t) => {
  const { options } = await fixture(t);
  const runtime = await createRuntime({ config: cfg, options, responseImpl: async () => { throw new Error('fixture connection lost'); } });
  await assert.rejects(runtime.run({ messages, stream: false }), (error) => {
    assert.equal(error.accounting.requests, 1);
    assert.equal(error.accounting.usageComplete, false);
    assert.equal(error.accounting.breakdownComplete, false);
    assert.equal(error.accounting.computedCost, null);
    assert.equal(error.accounting.reportedCost, null);
    return /connection lost/.test(error.message);
  });
  assert.equal(runtime.session.events.at(-1).type, 'request.failed');
  await runtime.close();
});

test('required sandbox fails closed on unsupported hosts before a session is created', async () => {
  await assert.rejects(createSandbox({ mode: 'required', root: '.', platform: 'win32' }), /unavailable/);
  assert.equal((await createSandbox({ mode: 'off', root: '.' })).mode, 'off');
});

test('AES vault never stores plaintext and rejects the wrong unlock key', async (t) => {
  const home = await temporary(t); const env = { OWN_CODEX_HOME: home, OWN_CODEX_VAULT_KEY: 'master-key-with-at-least-32-characters' };
  await storeCredential('test', 'test-secret', { env, platform: 'linux' });
  assert.doesNotMatch(await fs.readFile(path.join(home, 'vault.json'), 'utf8'), /test-secret|master-key/);
  assert.equal(await loadCredential('test', { env, platform: 'linux' }), 'test-secret');
  await assert.rejects(loadCredential('test', { env: { ...env, OWN_CODEX_VAULT_KEY: 'wrong-key' }, platform: 'linux' }), /authentication failed/);
  assert.equal((await vaultStatus({ env }))[0].method, 'aes-256-gcm');
  await removeCredential('test', { env });
  assert.equal(await loadCredential('test', { env, platform: 'linux' }), '');
});

test('Windows DPAPI vault round-trips under the current account', { skip: process.platform !== 'win32' }, async (t) => {
  const env = { OWN_CODEX_HOME: await temporary(t) };
  const result = await storeCredential('test', 'windows-secret-λ', { env });
  assert.equal(result.method, 'windows-dpapi');
  assert.equal(await loadCredential('test', { env }), 'windows-secret-λ');
  assert.doesNotMatch(await fs.readFile(result.path, 'utf8'), /windows-secret/);
});
