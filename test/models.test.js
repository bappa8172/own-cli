import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels } from '../src/client.js';
import { normalizeModels, formatModels } from '../src/models.js';
import { server } from '../support/fixtures.js';

const config = { baseUrl: 'https://example.test/v1', apiKey: 'catalog-secret', model: 'test-model', timeoutMs: 1000 };
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test('free models come first; unknown prices are not called paid or free', () => {
  const models = normalizeModels([
    { id: 'expensive', pricing: { prompt: '0.01', completion: '0.02' } },
    { id: 'free/claude' }, { id: 'vendor/model:free' }, { id: 'no-pricing' },
    { id: 'zero-priced', pricing: { prompt: '0', completion: '0' } },
    { id: 'flagged', is_free: true }, { id: 'other-flag', free: true },
    { id: 'input-output', pricing: { input: 0, output: 0 } },
    { id: 'top-level-prices', input_price: '0', output_price: '0' },
  ]);
  assert.equal(models.filter((model) => model.pricing === 'free').length, 7);
  assert.equal(models.at(-1).id, 'no-pricing');
  assert.equal(models.at(-1).pricing, 'unknown');
});

test('free labels never override explicit charges and incomplete pricing is unknown', () => {
  const models = normalizeModels([
    { id: 'free/charged', pricing: { prompt: 0, completion: 1 } },
    { id: 'free/request-fee', pricing: { prompt: 0, completion: 0, request: '0.1' } },
    { id: 'free/explicit-false', is_free: false },
    { id: 'missing-output', pricing: { prompt: 0 } },
    { id: 'nulls', pricing: { prompt: null, completion: null } },
    { id: 'blanks', pricing: { prompt: '', completion: '' } },
    { id: 'bad-prices', pricing: { prompt: 'n/a', completion: '-1' } },
  ]);
  assert.equal(models.filter((model) => model.pricing === 'free').length, 0);
  assert.equal(models.filter((model) => model.pricing === 'paid').length, 3);
  assert.equal(models.filter((model) => model.pricing === 'unknown').length, 4);
});

test('catalog deduplicates entries and retains conflicting paid information', () => {
  const models = normalizeModels(['free/a', 'free/a', { id: 'free/a', is_free: false }, 'free/a',
    { id: 'flagged' }, { id: 'flagged', free: true }]);
  assert.deepEqual(models, [{ id: 'flagged', pricing: 'free' }, { id: 'free/a', pricing: 'paid' }]);
});

for (const entry of [null, 10, {}, { id: '' }, { id: 'line\nbreak' }, { id: '\u001b[31mred' }]) {
  test(`catalog rejects invalid IDs: ${JSON.stringify(entry)}`, () => assert.throws(() => normalizeModels([entry]), /invalid model ID/));
}

test('formatted catalog marks current model and clearly filters free models', () => {
  const models = normalizeModels(['free/a', 'unknown', { id: 'paid', free: false }]);
  const all = formatModels(models, { currentModel: 'free/a' });
  assert.match(all, /\* \[FREE\] free\/a/);
  assert.match(all, /\[PRICE UNKNOWN\] unknown/);
  assert.match(all, /\[PAID\] paid/);
  const free = formatModels(models, { currentModel: 'free/a', freeOnly: true });
  assert.doesNotMatch(free, /\[PAID\]|\[PRICE UNKNOWN\]/);
  assert.match(free, /quotas or subscriptions/);
  assert.match(formatModels([], { freeOnly: true }), /No free models/);
  assert.match(formatModels([]), /returned no models/);
});

test('listing uses GET /models with auth and no generation payload', async () => {
  const models = await listModels({ config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.test/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.authorization, 'Bearer catalog-secret');
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    return json({ data: [{ id: 'free/a' }] });
  } });
  assert.deepEqual(models, [{ id: 'free/a', pricing: 'free' }]);
});

for (const endpoint of ['/responses', '/chat/completions', '/models', '///']) {
  test(`model URL accepts configured endpoint suffix ${endpoint}`, async () => {
    await listModels({ config: { ...config, baseUrl: 'https://example.test/v1' + endpoint }, fetchImpl: async (url) => {
      assert.equal(url, 'https://example.test/v1/models'); return json({ models: ['a'] });
    } });
  });
}

test('listing follows provider pagination and deduplicates pages', async () => {
  const urls = [];
  const models = await listModels({ config, fetchImpl: async (url) => {
    urls.push(url);
    return urls.length === 1 ? json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })
      : json({ data: [{ id: 'a' }, { id: 'free/b' }], has_more: false });
  } });
  assert.deepEqual(urls, ['https://example.test/v1/models', 'https://example.test/v1/models?after=a']);
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'free/b');
});

test('public local catalogs omit Authorization and accept a root array', async () => {
  const models = await listModels({ config: { ...config, apiKey: '', requiresOpenAiAuth: false }, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.authorization, undefined); return json(['a']);
  } });
  assert.equal(models[0].id, 'a');
});

for (const [label, response, pattern] of [
  ['HTTP error', () => new Response('invalid catalog-secret', { status: 401 }), /401.*\[redacted\]/],
  ['provider error', () => json({ error: { message: 'not supported' } }), /not supported/],
  ['invalid JSON', () => new Response('<html>not models</html>'), /invalid JSON/],
  ['missing array', () => json({ something: [] }), /data or models array/],
  ['invalid cursor', () => json({ data: [], has_more: true }), /cursor/],
  ['repeating cursor', () => json({ data: [{ id: 'a' }], has_more: true }), /cursor/],
  ['too many models', () => json({ data: Array(10001).fill('a') }), /10000/],
]) {
  test(`listing handles ${label}`, async () => {
    await assert.rejects(listModels({ config, fetchImpl: async () => response() }), pattern);
  });
}

test('listing timeout covers stalled HTTP body reads', async (t) => {
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders();
  });
  await assert.rejects(listModels({ config: { ...config, baseUrl: api.baseUrl }, timeoutMs: 150 }), /timed out after 150 ms/);
});

test('listing supports cancellation and never fetches with missing auth', async () => {
  const controller = new AbortController();
  const pending = listModels({ config, signal: controller.signal, fetchImpl: async () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(listModels({ config, signal: controller.signal, fetchImpl: () => assert.fail('should not fetch') }), /cancelled/);
  await assert.rejects(listModels({ config: { ...config, apiKey: '' }, fetchImpl: () => assert.fail('should not fetch') }), /Missing API key/);
});
