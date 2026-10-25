import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cli, temporary, write, server } from '../support/fixtures.js';
import { parseArgs } from '../src/cli.js';

const tool = (id, name, args) => ({ output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 10, output_tokens: 5 } });
async function fixture(t, handler) {
  const root = await temporary(t); const home = await temporary(t); const api = await server(t, handler);
  return { root, home, api, env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' } };
}

test('roadmap arguments support exec/-p aliases and reject invalid combinations', () => {
  assert.equal(parseArgs(['exec', 'fix', '--json']).command, 'ask');
  assert.equal(parseArgs(['-p', 'fix', '--permission-mode', 'yolo', '--max-turns', '5']).options.permissions, 'all');
  assert.equal(parseArgs(['-p', 'fix']).prompt, 'fix');
  assert.equal(parseArgs(['exec', 'fix', '--permission-mode', 'auto-edit']).options.permissions, 'workspace');
  assert.throws(() => parseArgs(['exec', 'fix', '--json', '--jsonl']), /cannot be combined/);
  assert.throws(() => parseArgs(['chat', '--resume', 'last', '--no-session']), /cannot be combined/);
  assert.throws(() => parseArgs(['chat', '--resume', 'last', '--worktree']), /existing worktree/);
  assert.throws(() => parseArgs(['exec', 'fix', '--max-cost', '-1']), /positive/);
  assert.throws(() => parseArgs(['chat', '--sandbox', 'fake']), /off or required/);
});

test('headless sessions resume history and undo restores files without any API key', async (t) => {
  let stage = 0;
  const f = await fixture(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (++stage === 1) response.end(JSON.stringify(tool('create1', 'write_file', { path: 'created/nested/a.txt', content: 'created' })));
    else {
      if (stage === 3) assert.ok(request.body.input.some((message) => message.content === 'first task'));
      response.end(JSON.stringify({ output_text: stage === 2 ? 'first answer' : 'second answer', usage: { input_tokens: 10, output_tokens: 2 } }));
    }
  });
  const first = await cli(['exec', 'first task', '--root', f.root, '--no-context', '--json'], { env: f.env });
  assert.equal(first.code, 0, first.stderr);
  const result = JSON.parse(first.stdout); assert.ok(result.sessionId); assert.equal(result.accounting.totalTokens, 27);
  const resumed = await cli(['exec', 'second task', '--root', f.root, '--no-context', '--resume', result.sessionId, '--json'], { env: f.env });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).sessionId, result.sessionId);
  const sessions = await cli(['sessions', '--root', f.root, '--json'], { env: { OWN_CODEX_HOME: f.home } });
  assert.equal(JSON.parse(sessions.stdout)[0].turns, 2);
  const undo = await cli(['undo', '--root', f.root, '--resume', result.sessionId, '--json'], { env: { OWN_CODEX_HOME: f.home } });
  assert.equal(undo.code, 0, undo.stderr);
  assert.deepEqual(JSON.parse(undo.stdout).restored, ['created/nested/a.txt']);
  await assert.rejects(fs.access(path.join(f.root, 'created')));
});

test('JSONL mode emits ordered parseable core events without raw text or notices on stdout', async (t) => {
  const f = await fixture(t, (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"output_text":"hello","usage":{"input_tokens":5,"output_tokens":1}}'); });
  const result = await cli(['exec', 'hello', '--root', f.root, '--no-context', '--jsonl'], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'request.received');
  assert.ok(events.some((event) => event.type === 'turn.started'));
  assert.ok(events.some((event) => event.type === 'token.delta' && event.data.delta === 'hello'));
  assert.equal(events.at(-1).type, 'turn.completed');
  assert.ok(events.every((event) => event.sessionId === events[0].sessionId));
});

test('plan mode hides mutation tools; explicit permission policies prevent writes', async (t) => {
  let expectPlan = true; let requests = 0;
  const f = await fixture(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); requests += 1;
    if (expectPlan) { assert.ok(!request.body.tools.some((entry) => entry.name === 'write_file')); response.end('{"output_text":"1. Inspect 2. Build 3. Test"}'); }
    else if (requests === 2) response.end(JSON.stringify(tool('denied', 'write_file', { path: 'blocked.txt', content: 'no' })));
    else { assert.match(request.body.input.at(-1).output, /policy denied/); response.end('{"output_text":"The policy denied writing."}'); }
  });
  const plan = await cli(['exec', 'plan a change', '--root', f.root, '--no-context', '--plan', '--json'], { env: f.env });
  assert.equal(plan.code, 0, plan.stderr); assert.deepEqual(JSON.parse(plan.stdout).changes, []);
  expectPlan = false;
  const policy = await write(f.home, 'policy.json', JSON.stringify({ rules: [{ tool: 'write_file', action: 'deny' }] }));
  const denied = await cli(['exec', 'write', '--root', f.root, '--no-context', '--policy', policy, '--json'], { env: f.env });
  assert.equal(denied.code, 0, denied.stderr); assert.deepEqual(JSON.parse(denied.stdout).changes, []);
  await assert.rejects(fs.access(path.join(f.root, 'blocked.txt')));
});

test('dollar budgets without prices fail before any model request and required sandbox fails before recording', async (t) => {
  const f = await fixture(t, () => assert.fail('No API request should happen'));
  const budget = await cli(['exec', 'task', '--root', f.root, '--no-context', '--max-cost', '0.01', '--json'], { env: f.env });
  assert.equal(budget.code, 1); assert.match(JSON.parse(budget.stderr).error, /requires explicit/);
  if (process.platform === 'win32') {
    const sandbox = await cli(['exec', 'task', '--root', f.root, '--no-context', '--sandbox', 'required', '--json'], { env: f.env });
    assert.equal(sandbox.code, 1); assert.match(JSON.parse(sandbox.stderr).error, /unavailable on win32/);
  }
  assert.equal(f.api.requests.length, 0);
});

test('no-session mode leaves no audit/session directory behind', async (t) => {
  const f = await fixture(t, (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"output_text":"done"}'); });
  const result = await cli(['exec', 'hello', '--root', f.root, '--no-context', '--no-session', '--json'], { env: f.env });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).sessionId, null);
  await assert.rejects(fs.access(path.join(f.home, 'projects')));
});

test('MCP serve command uses the shared runtime and emits only protocol messages', async (t) => {
  const f = await fixture(t, (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"output_text":"server answer"}'); });
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_run', arguments: { prompt: 'server task' } } },
  ].map((message) => JSON.stringify(message) + '\n').join('');
  const result = await cli(['serve', '--root', f.root, '--no-context', '--read-only'], { env: f.env, input });
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies[1].result.tools[0].name, 'agent_run');
  assert.equal(JSON.parse(replies[2].result.content[0].text).text, 'server answer');
});

test('isolated subagents use the lookup model, read-only tools, and return a summary to the parent', async (t) => {
  const f = await fixture(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.body.model === 'lookup-model') {
      assert.ok(!request.body.tools.some((entry) => entry.name === 'write_file' || entry.name === 'delegate'));
      response.end('{"output_text":"Child evidence summary."}');
    } else if (request.body.input.at(-1).type !== 'function_call_output') response.end(JSON.stringify(tool('child', 'delegate', { role: 'explore', task: 'Inspect project layout.' })));
    else { assert.match(request.body.input.at(-1).output, /Child evidence summary/); response.end('{"output_text":"Parent answer."}'); }
  });
  const result = await cli(['exec', 'explore', '--root', f.root, '--no-context', '--subagents', '--lookup-model', 'lookup-model', '--json'], { env: f.env });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).text, 'Parent answer.');
  assert.equal(f.api.requests.length, 3);
});

test('credential login accepts stdin without echoing the key and config uses the encrypted vault', { skip: process.platform !== 'win32' }, async (t) => {
  const home = await temporary(t); const env = { OWN_CODEX_HOME: home };
  const login = await cli(['auth', 'login', '--stdin-key'], { env, input: 'fixture-private-key\n' });
  assert.equal(login.code, 0, login.stderr); assert.doesNotMatch(login.stdout + login.stderr, /fixture-private-key/);
  const config = await cli(['config', '--json'], { env });
  assert.equal(config.code, 0, config.stderr); assert.equal(JSON.parse(config.stdout).credentialSource, 'encrypted-vault');
  assert.equal(JSON.parse(config.stdout).apiKeyConfigured, true);
  const logout = await cli(['auth', 'logout'], { env });
  assert.equal(logout.code, 0, logout.stderr);
});
