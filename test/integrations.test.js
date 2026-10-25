import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { temporary, write, server } from '../support/fixtures.js';
import { connectMcpServers } from '../src/mcp/client.js';
import { serveMcp } from '../src/server/mcp.js';
import { createProjectWorktree } from '../src/runtime/worktrees.js';
import { createKnowledge } from '../src/memory/knowledge.js';
import { createWorkspace } from '../src/workspace.js';
import { extendWorkspace } from '../src/tools/extensions.js';
import { validateArguments } from '../src/tools/schema.js';
import { createRuntime } from '../src/core/runtime.js';
const exec = promisify(execFile);

test('Implement child writes stay in its Git worktree and return reviewable artifacts', async (t) => {
  const root = await temporary(t); const home = await temporary(t);
  await exec('git', ['init'], { cwd: root, windowsHide: true });
  await write(root, 'tracked.txt', 'parent original');
  await exec('git', ['add', 'tracked.txt'], { cwd: root, windowsHide: true });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], { cwd: root, windowsHide: true });
  let parent = 0; let child = 0; let receipt;
  const call = (id, name, args) => ({ text: '', usage: { input_tokens: 10, output_tokens: 2 },
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }], raw: { output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] } });
  const runtime = await createRuntime({ config: { model: 'fixture', wireApi: 'responses' },
    options: { root, env: { OWN_CODEX_HOME: home }, permissions: 'workspace', subagents: true }, responseImpl: async (request) => {
      if (request.messages[0].content.includes('isolated implement subagent')) {
        assert.ok(!request.tools.some((tool) => tool.name === 'delegate'));
        return ++child === 1 ? call('child-write', 'write_file', { path: 'child/result.txt', content: 'isolated implementation' })
          : { text: 'Created child/result.txt', usage: { input_tokens: 10, output_tokens: 2 } };
      }
      if (++parent === 1) return call('delegate', 'delegate', { role: 'implement', task: 'Create child/result.txt' });
      receipt = JSON.parse(request.messages.at(-1).output);
      return { text: 'Child ready for review.', usage: { input_tokens: 10, output_tokens: 2 } };
    } });
  try {
    const result = await runtime.run({ messages: [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'Implement in a child.' }], stream: false });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.files[0].content, 'isolated implementation');
    assert.ok(receipt.sessionId);
    assert.equal(await fs.readFile(path.join(receipt.worktree.root, 'child/result.txt'), 'utf8'), 'isolated implementation');
    await assert.rejects(fs.access(path.join(root, 'child')));
    assert.equal(result.accounting.requests, 4);
    assert.equal(runtime.session.events.filter((event) => event.type === 'subagent.started').length, 1);
  } finally { await runtime.close(); }
});

test('MCP stdio client initializes, discovers tools, and invokes a namespaced tool', async (t) => {
  const root = await temporary(t);
  const config = await write(root, 'mcp.json', JSON.stringify({ mcpServers: { fixture: { command: 'node', args: [fileURLToPath(new URL('../support/mock-mcp.mjs', import.meta.url))] } } }));
  const client = await connectMcpServers(config);
  try {
    assert.equal(client.tools.length, 1); assert.equal(client.tools[0].readOnly, true);
    assert.match(client.tools[0].name, /^mcp_fixture_echo_/);
    assert.equal((await client.call(client.tools[0].name, { text: 'hello' })).content[0].text, 'hello');
  } finally { await client.close(); }
});

for (const streaming of [false, true]) {
  test(`MCP HTTP client handles ${streaming ? 'SSE' : 'JSON'} replies and carries the session header`, async (t) => {
    const root = await temporary(t);
    const api = await server(t, (request, response) => {
      const message = request.body;
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http', version: '1' } };
      else {
        assert.equal(request.headers['mcp-session-id'], 'fixture-session');
        result = message.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
          : { content: [{ type: 'text', text: 'looked up' }] };
      }
      response.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'fixture-session' });
      const value = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      response.end(streaming ? `event: message\ndata: ${value}\n\n` : value);
    });
    const file = await write(root, 'mcp.json', JSON.stringify({ mcpServers: { http: { url: api.baseUrl } } }));
    const client = await connectMcpServers(file);
    try { assert.equal((await client.call(client.tools[0].name, {})).content[0].text, 'looked up'); }
    finally { await client.close(); }
  });
}

test('MCP stdio server speaks only JSON-RPC and runs a tool through its shared callback', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = ''; output.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
  const pending = serveMcp({ input, output, run: async (prompt) => ({ text: 'answered ' + prompt }) });
  input.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_run', arguments: { prompt: 'test' } } },
  ].map((message) => JSON.stringify(message) + '\n').join(''));
  await pending;
  const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.equal(replies[1].result.tools[0].name, 'agent_run');
  assert.equal(JSON.parse(replies[2].result.content[0].text).text, 'answered test');
});

test('MCP server reports malformed requests and propagates cancellation to an active task', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = ''; output.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
  const pending = serveMcp({ input, output, run: async (_prompt, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) });
  input.end('{bad}\n' + [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_run', arguments: { prompt: 'wait' } } },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } },
  ].map((message) => JSON.stringify(message) + '\n').join(''));
  await pending;
  const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies.at(-1).result.isError, true);
  assert.match(replies.at(-1).result.content[0].text, /cancelled/);
});

test('project memory retrieves decisions and skills load only from discovered markdown files', async (t) => {
  const root = await temporary(t); const home = await temporary(t);
  await write(root, 'AGENTS.md', 'Use project conventions.');
  await write(root, '.agents/skills/react/SKILL.md', '---\nname: react\ndescription: Build React components\n---\nUse accessible components.');
  const knowledge = await createKnowledge(root, { OWN_CODEX_HOME: home });
  const memory = await knowledge.remember('Use React for frontend components.', 'decision');
  await knowledge.remember('Prefer Python for offline analysis.', 'preference');
  assert.equal((await knowledge.search('React components'))[0].id, memory.id);
  assert.equal((await knowledge.rules())[0].file, 'AGENTS.md');
  const skills = await knowledge.skills(); assert.equal(skills[0].name, 'react');
  assert.match((await knowledge.loadSkill(skills[0].id)).text, /accessible components/);
  await assert.rejects(knowledge.loadSkill('../../auth.json'), /not found/);
  await knowledge.forget(memory.id);
  assert.ok(!(await knowledge.search('React')).some((item) => item.id === memory.id));
});

test('extensions provide todo/glob and validate schemas before memory writes', async (t) => {
  const root = await temporary(t); const home = await temporary(t);
  await write(root, 'src/app.js', 'app'); await write(root, 'other.txt', 'text');
  const knowledge = await createKnowledge(root, { OWN_CODEX_HOME: home });
  const workspace = extendWorkspace(await createWorkspace({ root }), { knowledge });
  await workspace.execute('todo', { items: [{ text: 'Build', status: 'in_progress' }] });
  assert.equal(workspace.todos[0].status, 'in_progress');
  assert.deepEqual((await workspace.execute('glob', { pattern: '**/*.js' })).matches.map((item) => item.path), ['src/app.js']);
  await assert.rejects(workspace.execute('todo', { items: [{ text: 'bad', status: 'unknown' }] }), /enum/);
  workspace.permissions = 'read-only';
  await assert.rejects(workspace.execute('project_knowledge', { action: 'remember', text: 'blocked' }), /Read-only/);
});

test('JSON schema dispatcher handles local references, enums, nested arrays and unknown properties', () => {
  const schema = { type: 'object', properties: { values: { type: 'array', items: { $ref: '#/$defs/item' } } }, required: ['values'], additionalProperties: false,
    $defs: { item: { type: 'object', properties: { status: { enum: ['ok'] } }, required: ['status'], additionalProperties: false } } };
  validateArguments(schema, { values: [{ status: 'ok' }] });
  assert.throws(() => validateArguments(schema, { values: [{ status: 'bad' }] }), /enum/);
  assert.throws(() => validateArguments(schema, { values: [], unknown: true }), /Unknown/);
});

test('Git worktrees isolate committed files and do not copy uncommitted working-tree edits', async (t) => {
  const root = await temporary(t); const home = await temporary(t);
  await exec('git', ['init'], { cwd: root, windowsHide: true });
  await write(root, 'tracked.txt', 'committed');
  await exec('git', ['add', 'tracked.txt'], { cwd: root, windowsHide: true });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], { cwd: root, windowsHide: true });
  await write(root, 'tracked.txt', 'uncommitted');
  const worktree = await createProjectWorktree(root, { name: 'test-worktree', env: { OWN_CODEX_HOME: home } });
  assert.equal(await fs.readFile(path.join(worktree.root, 'tracked.txt'), 'utf8'), 'committed');
  assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'uncommitted');
  assert.equal(worktree.branch, 'own-cli/test-worktree');
  await assert.rejects(createProjectWorktree(root, { name: '../bad', env: { OWN_CODEX_HOME: home } }), /name must/);
});
