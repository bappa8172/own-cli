import test from 'node:test';
import assert from 'node:assert/strict';

import { createResponse, extractResponseText, extractStreamDelta } from '../src/client.js';
import { server } from '../support/fixtures.js';

const config = { apiKey: 'sk-test', baseUrl: 'https://example.test/v1', model: 'test/model', timeoutMs: 2000 };
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const sse = (data) => new Response(data, { headers: { 'content-type': 'text/event-stream' } });
const request = (options = {}) => createResponse({ config, messages: [{ role: 'user', content: 'hello' }], ...options });

test('extractResponseText supports Responses-style output', () => {
  assert.equal(extractResponseText({ output_text: 'hello' }), 'hello');
  assert.equal(extractResponseText({ output: [{ content: [{ text: 'world' }] }] }), 'world');
});

test('extractStreamDelta supports Responses and Chat Completions events', () => {
  assert.equal(extractStreamDelta({ delta: 'a' }), 'a');
  assert.equal(extractStreamDelta({ output_text: { delta: 'b' } }), 'b');
  assert.equal(extractStreamDelta({ choices: [{ delta: { content: 'c' } }] }), 'c');
});

test('createResponse sends the Responses payload and reads JSON output', async () => {
  let request;
  const result = await createResponse({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/v1',
      maxOutputTokens: 99,
      model: 'test/model',
    },
    fetchImpl: async (url, options) => {
      request = { body: JSON.parse(options.body), headers: options.headers, url };
      return new Response(JSON.stringify({ output_text: 'done' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    },
    maxOutputTokens: 12,
    messages: [
      { content: 'Be concise.', role: 'system' },
      { content: 'Say done.', role: 'user' },
    ],
    stream: false,
  });

  assert.equal(result.text, 'done');
  assert.equal(request.url, 'https://example.test/v1/responses');
  assert.equal(request.body.model, 'test/model');
  assert.equal(request.body.max_output_tokens, 12);
  assert.equal(request.body.input[0].content, 'Say done.');
  assert.equal(request.headers.authorization, 'Bearer sk-test');
});

test('createResponse streams Responses deltas', async () => {
  const deltas = [];
  const result = await createResponse({
    config: {
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/v1',
      maxOutputTokens: 99,
      model: 'test/model',
    },
    fetchImpl: async () => new Response(
      'event: response.output_text.delta\ndata: {"delta":"hel"}\n\n'
        + 'event: response.output_text.delta\ndata: {"delta":"lo"}\n\n'
        + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' }, status: 200 },
    ),
    messages: [{ content: 'Say hello.', role: 'user' }],
    onDelta: (delta) => deltas.push(delta),
    stream: true,
  });

  assert.equal(result.text, 'hello');
  assert.deepEqual(deltas, ['hel', 'lo']);
});

test('createResponse reports a request timeout clearly', async () => {
  await assert.rejects(
    createResponse({
      config: {
        apiKey: 'sk-test',
        baseUrl: 'https://example.test/v1',
        model: 'test/model',
      },
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
      messages: [{ content: 'wait', role: 'user' }],
      stream: false,
      timeoutMs: 5,
    }),
    /timed out after 5 ms/,
  );
});

test('JSON fallback is printed when streaming was requested', async () => {
  const deltas = [];
  const result = await request({ fetchImpl: async () => json({ output_text: 'visible answer', usage: { total_tokens: 10 }, model: 'actual-model' }), onDelta: (value) => deltas.push(value) });
  assert.equal(result.text, 'visible answer');
  assert.deepEqual(deltas, ['visible answer']);
  assert.equal(result.model, 'actual-model');
  assert.equal(result.usage.total_tokens, 10);
});

test('nonstreaming never invokes the streaming callback', async () => {
  await request({ stream: false, fetchImpl: async () => json({ output_text: 'answer' }), onDelta: () => assert.fail('unexpected callback') });
});

test('text extraction ignores reasoning and function calls but includes refusals', () => {
  assert.equal(extractResponseText({ output: [
    { type: 'reasoning', text: 'hidden reasoning' },
    { type: 'function_call', text: 'not an answer' },
    { type: 'message', content: [{ type: 'output_text', text: 'shown' }, { type: 'refusal', refusal: ' refusal' }] },
  ] }), 'shown refusal');
  assert.equal(extractResponseText({ choices: [{ message: { content: [{ type: 'text', text: 'chat answer' }] } }] }), 'chat answer');
  assert.equal(extractStreamDelta({ type: 'response.reasoning.delta', delta: 'hidden' }), '');
  assert.equal(extractStreamDelta({ type: 'response.output_text.done', text: 'duplicate' }), '');
  assert.equal(extractResponseText({ output: [{ content: [{ text: { invalid: 'object' } }] }] }), '');
  assert.equal(extractResponseText({ choices: [{ message: { refusal: { invalid: 'object' } } }] }), '');
});

test('stream handles every UTF-8 byte split and split CRLF separators', async () => {
  const encoded = new TextEncoder().encode(': keepalive\r\nevent: response.output_text.delta\r\ndata: {"delta":"हैलो 🌍"}\r\n\r\nevent: response.completed\r\ndata: {"response":{"output_text":"हैलो 🌍","model":"actual"}}\r\n\r\n');
  const deltas = [];
  const result = await request({
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' } }),
    onDelta: (value) => deltas.push(value),
  });
  assert.equal(result.text, 'हैलो 🌍');
  assert.deepEqual(deltas, ['हैलो 🌍']);
  assert.equal(result.model, 'actual');
});

test('completed-only events produce an answer, without requiring the peer to close', async () => {
  let cancelled = false;
  const result = await request({ fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"response":{"output_text":"finished"}}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(result.text, 'finished');
  assert.equal(cancelled, true);
});

test('completed snapshots append missing suffix without duplicating deltas', async () => {
  const deltas = [];
  const result = await request({ fetchImpl: async () => sse('data: {"type":"response.output_text.delta","delta":"hel"}\n\ndata: {"type":"response.output_text.done","text":"hello"}\n\ndata: {"type":"response.completed","response":{"output_text":"hello"}}'), onDelta: (value) => deltas.push(value) });
  assert.equal(result.text, 'hello');
  assert.deepEqual(deltas, ['hel', 'lo']);
});

test('multiline SSE data and LF-only separators work', async () => {
  const result = await request({ fetchImpl: async () => sse('event: response.completed\ndata: {"response":\ndata: {"output_text":"multiline"}}\n\n') });
  assert.equal(result.text, 'multiline');
});

for (const [label, data, pattern] of [
  ['provider error', 'data: {"type":"error","error":{"message":"upstream failed"}}\n\n', /upstream failed/],
  ['failed response', 'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"bad model"}}}\n\n', /bad model/],
  ['incomplete response', 'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n', /max_output_tokens/],
  ['broken JSON', 'data: {broken}\n\n', /Malformed JSON/],
  ['primitive event', 'data: null\n\n', /Invalid event/],
  ['missing terminal event', 'data: {"delta":"partial"}\n\n', /ended before completion/],
  ['empty completed answer', 'data: {"type":"response.completed","response":{"output":[]}}\n\n', /no answer text/],
  ['conflicting final text', 'data: {"delta":"wrong"}\n\ndata: {"type":"response.completed","response":{"output_text":"right"}}\n\n', /differs/],
  ['oversized event', `data: ${'x'.repeat(1048577)}`, /exceeded 1 MiB/],
  ['oversized terminated event', `data: ${'x'.repeat(1048577)}\n\n`, /exceeded 1 MiB/],
]) {
  test(`stream rejects ${label}`, async () => {
    await assert.rejects(request({ fetchImpl: async () => sse(data) }), pattern);
  });
}

for (const [label, response, pattern] of [
  ['empty output', () => json({ output: [] }), /no answer text/],
  ['error in HTTP 200', () => json({ error: { message: 'provider error' } }), /provider error/],
  ['incomplete output', () => json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), /max_output_tokens/],
  ['invalid JSON', () => new Response('<html>login</html>'), /invalid JSON/],
  ['HTTP error', () => new Response('unauthorized', { status: 401 }), /401.*unauthorized/],
]) {
  test(`JSON handling rejects ${label}`, async () => {
    await assert.rejects(request({ fetchImpl: async () => response() }), pattern);
  });
}

test('errors redact credentials even when the provider echoes them', async () => {
  await assert.rejects(request({ fetchImpl: async () => new Response('bad token sk-test', { status: 403 }) }), (error) => {
    assert.doesNotMatch(error.message, /sk-test/);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test('Responses endpoint is not appended twice and combines all instruction messages', async () => {
  await request({ config: { ...config, baseUrl: config.baseUrl + '/responses' },
    messages: [{ role: 'system', content: 'one' }, { role: 'developer', content: 'two' }, { role: 'user', content: 'three' }],
    fetchImpl: async (url, options) => {
      assert.equal(url, config.baseUrl + '/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.instructions, 'one\ntwo');
      assert.deepEqual(body.input, [{ role: 'user', content: 'three' }]);
      assert.equal(options.redirect, 'error');
      return json({ output_text: 'answer' });
    },
  });
});

test('chat wire API uses its own endpoint and payload', async () => {
  const result = await request({ config: { ...config, wireApi: 'chat' }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.test/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.input, undefined);
    return json({ choices: [{ message: { content: 'chat' }, finish_reason: 'stop' }] });
  } });
  assert.equal(result.text, 'chat');
});

test('chat streaming handles finish events without duplicating text', async () => {
  const result = await request({ config: { ...config, wireApi: 'chat' }, fetchImpl: async () => sse('data: {"choices":[{"delta":{"content":"chat"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') });
  assert.equal(result.text, 'chat');
});

test('truncated chat output is not reported as complete', async () => {
  await assert.rejects(request({ fetchImpl: async () => json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }) }), /incomplete.*length/);
});

test('auth-free providers omit Authorization; missing required auth prevents fetch', async () => {
  await request({ config: { ...config, apiKey: '', requiresOpenAiAuth: false }, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.authorization, undefined); return json({ output_text: 'local' });
  } });
  await assert.rejects(request({ config: { ...config, apiKey: '' }, fetchImpl: async () => assert.fail('should not fetch') }), /Missing API key/);
});

for (const change of [{ wireApi: 'unknown' }, { baseUrl: 'file:///etc' }, { baseUrl: 'https://name:secret@example.test' }, { baseUrl: 'https://example.test/v1/responses', wireApi: 'chat' }, { model: '' }]) {
  test(`invalid request config fails before fetch: ${JSON.stringify(change)}`, async () => {
    await assert.rejects(request({ config: { ...config, ...change }, fetchImpl: async () => assert.fail('should not fetch') }));
  });
}

test('timeout covers a stalled response body after HTTP headers arrive', async (t) => {
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
  });
  await assert.rejects(request({ config: { ...config, baseUrl: api.baseUrl }, timeoutMs: 150 }), /timed out after 150 ms/);
});

test('timeout covers a stalled stream after partial output', async (t) => {
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"delta":"partial"}\n\n');
  });
  const deltas = [];
  await assert.rejects(request({ config: { ...config, baseUrl: api.baseUrl }, timeoutMs: 150, onDelta: (delta) => deltas.push(delta) }), /timed out/);
  assert.deepEqual(deltas, ['partial']);
});

test('caller cancellation stops an in-flight request and already cancelled requests never fetch', async () => {
  const controller = new AbortController();
  const pending = request({ signal: controller.signal, fetchImpl: async () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(request({ signal: controller.signal, fetchImpl: () => assert.fail('should not fetch') }), /cancelled/);
});
