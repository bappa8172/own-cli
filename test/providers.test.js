import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createResponse, listModels } from '../src/client.js';
import { runAgent } from '../src/agent.js';
import { createWorkspace } from '../src/workspace.js';
import { temporary, server } from '../support/fixtures.js';

const base = { apiKey: 'provider-test-key', model: 'test-model', baseUrl: 'https://example.test/v1', maxOutputTokens: 100, timeoutMs: 1000 };
const messages = [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'hello' }];
const tools = [{ name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }];
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

for (const wireApi of ['anthropic', 'gemini', 'ollama']) {
  test(`${wireApi} adapter calls tools, creates files, and sends native continuation results`, async (t) => {
    const root = await temporary(t); const workspace = await createWorkspace({ root });
    const args = { path: 'native.txt', content: 'native verified' };
    const api = await server(t, (request, reply) => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      if (api.requests.length === 1) {
        if (wireApi === 'anthropic') {
          assert.equal(request.url, '/v1/messages'); assert.equal(request.headers['x-api-key'], base.apiKey);
          assert.equal(request.body.tools[0].input_schema.type, 'object');
          reply.end(JSON.stringify({ content: [{ type: 'tool_use', id: 'native1', name: 'write_file', input: args }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }));
        } else if (wireApi === 'gemini') {
          assert.equal(request.url, '/v1/models/test-model:generateContent'); assert.equal(request.headers['x-goog-api-key'], base.apiKey);
          assert.equal(request.body.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object');
          reply.end(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'write_file', args }, thoughtSignature: 'preserved-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
        } else {
          assert.equal(request.url, '/v1/api/chat'); assert.equal(request.body.options.num_predict, 100);
          reply.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: args } }] }, done: true, prompt_eval_count: 10, eval_count: 5 }));
        }
      } else {
        if (wireApi === 'anthropic') {
          assert.equal(request.body.messages.at(-1).content[0].type, 'tool_result');
          assert.equal(request.body.messages.at(-1).content[0].tool_use_id, 'native1');
          reply.end(JSON.stringify({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }));
        } else if (wireApi === 'gemini') {
          assert.equal(request.body.contents.at(-1).parts[0].functionResponse.name, 'write_file');
          assert.equal(request.body.contents.at(-2).parts[0].thoughtSignature, 'preserved-signature');
          reply.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }));
        } else {
          assert.equal(request.body.messages.at(-1).role, 'tool');
          assert.equal(request.body.messages.at(-1).tool_name, 'write_file');
          assert.deepEqual(request.body.messages.at(-2).tool_calls[0].function.arguments, args);
          reply.end(JSON.stringify({ message: { role: 'assistant', content: 'done' }, done: true }));
        }
      }
    });
    const result = await runAgent({ config: { ...base, wireApi, baseUrl: api.baseUrl }, messages, workspace, stream: false });
    assert.equal(result.text, 'done');
    assert.equal(await fs.readFile(path.join(root, 'native.txt'), 'utf8'), 'native verified');
    assert.equal(api.requests.length, 2);
  });
}

test('Anthropic streaming preserves partial JSON and thinking signatures without printing reasoning', async () => {
  const deltas = [];
  const chunks = [
    { type: 'message_start', message: { model: 'actual', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'write_file', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a",' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"content":"ok"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ];
  const result = await createResponse({ config: { ...base, wireApi: 'anthropic' }, messages, tools, onDelta: (delta) => deltas.push(delta),
    fetchImpl: async () => new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(result.model, 'actual'); assert.equal(result.usage.output_tokens, 8);
  assert.equal(result.toolCalls[0].arguments, '{"path":"a","content":"ok"}');
  assert.equal(result.continuation[0].nativeContent[0].signature, 'signature');
  assert.deepEqual(deltas, []);
});

test('Gemini streaming prints only answer text and counts thinking usage', async () => {
  const deltas = [];
  const chunks = [{ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'hel' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 15 } }];
  const result = await createResponse({ config: { ...base, wireApi: 'gemini' }, messages, onDelta: (delta) => deltas.push(delta), fetchImpl: async () => new Response(
    chunks.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(result.text, 'hello'); assert.deepEqual(deltas, ['hel', 'lo']); assert.equal(result.usage.output_tokens, 5);
});

test('Ollama NDJSON streaming and JSON fallback preserve response text exactly once', async () => {
  const deltas = [];
  const result = await createResponse({ config: { ...base, wireApi: 'ollama' }, messages, onDelta: (delta) => deltas.push(delta), fetchImpl: async () => new Response(
    '{"message":{"content":"hello "},"done":false}\n{"message":{"content":"local"},"done":true,"prompt_eval_count":5,"eval_count":2}\n', { headers: { 'content-type': 'application/x-ndjson' } }) });
  assert.equal(result.text, 'hello local'); assert.deepEqual(deltas, ['hello ', 'local']);
  assert.equal(result.usage.input_tokens, 5);
});

for (const wireApi of ['anthropic', 'gemini', 'ollama']) {
  test(`${wireApi} rejects provider errors, incomplete streams, and redacts echoed credentials`, async () => {
    await assert.rejects(createResponse({ config: { ...base, wireApi }, messages, fetchImpl: async () => new Response('invalid provider-test-key', { status: 401 }) }), (error) => {
      assert.match(error.message, /401/); assert.doesNotMatch(error.message, /provider-test-key/); return true;
    });
    await assert.rejects(createResponse({ config: { ...base, wireApi }, messages, fetchImpl: async () => new Response('', { headers: { 'content-type': wireApi === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' } }) }), /before completion/);
    await assert.rejects(createResponse({ config: { ...base, wireApi }, messages, timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) }), /timed out/);
  });
}

test('native catalogs use provider authentication and native model names', async () => {
  for (const wireApi of ['anthropic', 'gemini', 'ollama']) {
    const models = await listModels({ config: { ...base, wireApi }, fetchImpl: async (url, options) => {
      if (wireApi === 'anthropic') assert.equal(options.headers['x-api-key'], base.apiKey);
      if (wireApi === 'gemini') assert.equal(options.headers['x-goog-api-key'], base.apiKey);
      if (wireApi === 'ollama') assert.match(url, /\/api\/tags$/);
      return json(wireApi === 'anthropic' ? { data: [{ id: 'claude-model' }] } : { models: [{ name: wireApi === 'gemini' ? 'models/gemini-model' : 'local-model' }] });
    } });
    assert.equal(models[0].id, wireApi === 'anthropic' ? 'claude-model' : wireApi === 'gemini' ? 'gemini-model' : 'local-model');
  }
});
