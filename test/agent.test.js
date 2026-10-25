import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkspace } from '../src/workspace.js';
import { runAgent } from '../src/agent.js';
import { createResponse, extractToolCalls } from '../src/client.js';
import { temporary, server } from '../support/fixtures.js';

const config = { apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'test/model', wireApi: 'responses', timeoutMs: 3000 };
const messages = [{ role: 'user', content: 'create a homepage' }];
const call = (id, name, args) => ({ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const response = (...calls) => ({ text: '', toolCalls: calls, raw: { output: calls.map((item) => ({
  type: 'function_call', call_id: item.id, name: item.name, arguments: item.arguments, status: 'completed',
})) } });

test('agent creates an actual folder and file, feeds real results back, and preserves reasoning items', async (t) => {
  const root = await temporary(t);
  const workspace = await createWorkspace({ root });
  const events = [];
  let step = 0;
  const result = await runAgent({ config, messages, workspace, stream: false, onTool: (event) => events.push(event), responseImpl: async (request) => {
    step += 1;
    if (step === 1) return response(call('mkdir', 'make_directory', { path: 'amazon' }));
    if (step === 2) {
      assert.equal(JSON.parse(request.messages.at(-1).output).action, 'directory-created');
      const next = response(call('write', 'write_file', { path: 'amazon/index.html', content: '<h1>Store</h1>' }));
      next.raw.output.unshift({ type: 'reasoning', id: 'r1', summary: [] });
      return next;
    }
    assert.ok(request.messages.some((item) => item.type === 'reasoning' && item.id === 'r1'));
    assert.equal(request.messages.at(-1).call_id, 'write');
    assert.equal(JSON.parse(request.messages.at(-1).output).ok, true);
    return { text: 'Created amazon/index.html.', toolCalls: [] };
  } });
  assert.equal(await fs.readFile(path.join(root, 'amazon/index.html'), 'utf8'), '<h1>Store</h1>');
  assert.equal(result.steps, 3);
  assert.equal(result.changes.length, 2);
  assert.equal(events.length, 2);
});

test('agent executes parallel model calls sequentially so later edits see earlier writes', async (t) => {
  const root = await temporary(t);
  const workspace = await createWorkspace({ root });
  let step = 0;
  await runAgent({ config, messages, workspace, responseImpl: async () => ++step === 1 ? response(
    call('write', 'write_file', { path: 'a.txt', content: 'first' }),
    call('edit', 'edit_file', { path: 'a.txt', old_text: 'first', new_text: 'second' }),
  ) : { text: 'done' } });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'second');
});

test('invalid arguments and path errors are returned to the model and can be corrected', async (t) => {
  const root = await temporary(t);
  const workspace = await createWorkspace({ root });
  let step = 0;
  const errors = [];
  await runAgent({ config, messages, workspace, onTool: (event) => { if (!event.ok) errors.push(event.error); }, responseImpl: async (request) => {
    step += 1;
    if (step === 1) return response(call('bad-json', 'write_file', '{broken'));
    if (step === 2) {
      assert.equal(JSON.parse(request.messages.at(-1).output).ok, false);
      return response(call('bad-path', 'write_file', { path: '../outside.txt', content: 'no' }));
    }
    if (step === 3) return response(call('good', 'write_file', { path: 'inside.txt', content: 'yes' }));
    return { text: 'done' };
  } });
  assert.equal(errors.length, 2);
  assert.match(errors[1], /outside/);
  assert.equal(await fs.readFile(path.join(root, 'inside.txt'), 'utf8'), 'yes');
});

test('textual code blocks are never treated as executable tool calls', async (t) => {
  const workspace = await createWorkspace({ root: await temporary(t) });
  const text = '```json\n{"name":"write_file","arguments":{"path":"a.txt","content":"no"}}\n```';
  const result = await runAgent({ config, messages, workspace, responseImpl: async () => ({ text }) });
  assert.equal(result.text, text);
  assert.equal(workspace.changes.length, 0);
});

test('step budgets stop tool loops, do not execute the last unfinished batch, and retain completed changes', async (t) => {
  const root = await temporary(t);
  const workspace = await createWorkspace({ root });
  let step = 0;
  await assert.rejects(runAgent({ config, messages, workspace, maxSteps: 2, responseImpl: async () => response(
    call(`call-${++step}`, 'write_file', { path: `${step}.txt`, content: 'created' }),
  ) }), /2-step limit/);
  assert.equal(await fs.readFile(path.join(root, '1.txt'), 'utf8'), 'created');
  await assert.rejects(fs.access(path.join(root, '2.txt')));
});

test('reused tool IDs cannot repeat a local action', async (t) => {
  const workspace = await createWorkspace({ root: await temporary(t) });
  await assert.rejects(runAgent({ config, messages, workspace, responseImpl: async () => response(call('duplicate', 'make_directory', { path: 'a' })) }), /repeated a tool-call ID/);
  assert.equal(workspace.changes.length, 1);
});

test('read-only permission failures are returned as tool errors, and cancellation prevents actions', async (t) => {
  const workspace = await createWorkspace({ root: await temporary(t), permissions: 'read-only' });
  let step = 0;
  await runAgent({ config, messages, workspace, responseImpl: async (request) => {
    if (++step === 1) return response(call('write', 'write_file', { path: 'a', content: 'no' }));
    assert.match(JSON.parse(request.messages.at(-1).output).error, /unavailable/);
    return { text: 'Read-only session.' };
  } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runAgent({ config, messages, workspace, signal: controller.signal, responseImpl: () => assert.fail('must not fetch') }), /cancelled/);
  assert.equal(workspace.changes.length, 0);
});

for (const wireApi of ['responses', 'chat']) {
  test(`real HTTP ${wireApi} tool loop writes a file and returns tool outputs using the right protocol`, async (t) => {
    const root = await temporary(t);
    const workspace = await createWorkspace({ root });
    const api = await server(t, (request, reply) => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      const tool = call('write-one', 'write_file', { path: 'store/index.html', content: '<main>Storefront</main>' });
      if (api.requests.length === 1) {
        assert.ok(request.body.tools.some((entry) => (entry.name || entry.function?.name) === 'write_file'));
        assert.equal(request.body.parallel_tool_calls, false);
        reply.end(JSON.stringify(wireApi === 'responses' ? response(tool).raw : { choices: [{ message: {
          role: 'assistant', content: null, tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }],
        }, finish_reason: 'tool_calls' }] }));
      } else {
        if (wireApi === 'responses') {
          assert.equal(request.body.input.at(-1).type, 'function_call_output');
          assert.equal(request.body.input.at(-1).call_id, 'write-one');
        } else {
          assert.equal(request.body.messages.at(-1).role, 'tool');
          assert.equal(request.body.messages.at(-1).tool_call_id, 'write-one');
          assert.equal(request.body.messages.at(-2).tool_calls[0].id, 'write-one');
        }
        reply.end(JSON.stringify(wireApi === 'responses' ? { output_text: 'Created the storefront.' }
          : { choices: [{ message: { content: 'Created the storefront.' }, finish_reason: 'stop' }] }));
      }
    });
    const result = await runAgent({ config: { ...config, wireApi, baseUrl: api.baseUrl }, messages, workspace, stream: false });
    assert.equal(result.text, 'Created the storefront.');
    assert.equal(result.changes[0].path, 'store/index.html');
    assert.equal(await fs.readFile(path.join(root, 'store/index.html'), 'utf8'), '<main>Storefront</main>');
  });
}

test('Responses streaming gathers fragmented function arguments without printing them', async () => {
  const deltas = [];
  const data = [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: 'make_directory', arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"store"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"store"}' },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('');
  const result = await createResponse({ config, tools: [{ name: 'make_directory', parameters: { type: 'object' } }], messages,
    onDelta: (delta) => deltas.push(delta), fetchImpl: async () => new Response(data, { headers: { 'content-type': 'text/event-stream' } }) });
  assert.deepEqual(result.toolCalls, [call('call1', 'make_directory', { path: 'store' })]);
  assert.deepEqual(deltas, []);
});

test('Chat streaming gathers interleaved function arguments and produces valid continuation messages', async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'make_directory', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"store"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const result = await createResponse({ config: { ...config, wireApi: 'chat' }, messages,
    tools: [{ name: 'make_directory', parameters: { type: 'object' } }], fetchImpl: async () => new Response(
      chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } },
    ) });
  assert.deepEqual(result.toolCalls, [call('call1', 'make_directory', { path: 'store' })]);
  assert.equal(result.raw.choices[0].message.tool_calls[0].id, 'call1');
});

test('incomplete, malformed or duplicate function calls cannot be executed', () => {
  assert.throws(() => extractToolCalls({ output: [{ type: 'function_call', status: 'in_progress' }] }), /incomplete/);
  assert.throws(() => extractToolCalls({ output: [{ type: 'function_call', call_id: 'one' }] }), /invalid/);
  const item = { type: 'function_call', call_id: 'one', name: 'read_file', arguments: '{}' };
  assert.throws(() => extractToolCalls({ output: [item, item] }), /duplicate/);
});
