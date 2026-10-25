import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { configSummary, loadConfig, maskSecret, parseToml, positiveInteger, writeSetupFiles } from '../src/config.js';
import { temporary, write } from '../support/fixtures.js';

test('parseToml reads the Codex provider shape', () => {
  const parsed = parseToml(`
    model = "free/claude-opus-4.6"
    model_provider = "apinex"

    [model_providers.apinex]
    name = "APInex"
    base_url = "https://api.apinex.bond/v1"
    wire_api = "responses"
    requires_openai_auth = true
  `);

  assert.equal(parsed.model, 'free/claude-opus-4.6');
  assert.equal(parsed.model_provider, 'apinex');
  assert.equal(parsed.model_providers.apinex.base_url, 'https://api.apinex.bond/v1');
  assert.equal(parsed.model_providers.apinex.requires_openai_auth, true);
});

test('loadConfig reads isolated config and auth without exposing the secret', async (t) => {
  const homeDir = await temporary(t);
  const codexDir = path.join(homeDir, '.own-codex');
  await fs.mkdir(codexDir);
  await fs.writeFile(path.join(codexDir, 'config.toml'), [
    'model = "test/model"',
    'model_provider = "apinex"',
    '',
    '[model_providers.apinex]',
    'base_url = "https://example.test/v1"',
    'wire_api = "responses"',
  ].join('\n'));
  await fs.writeFile(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-secret' }));

  const config = await loadConfig({ homeDir, env: {} });
  assert.equal(config.model, 'test/model');
  assert.equal(config.baseUrl, 'https://example.test/v1');
  assert.equal(config.apiKey, 'sk-test-secret');
  assert.doesNotMatch(configSummary(config), /sk-test|secret/);
});

test('TOML supports literal strings, quoted provider names, comments and BOM', () => {
  const config = parseToml(`\uFEFFmodel = 'test#model' # comment\n[model_providers."test.provider"]\nbase_url = 'https://example.test/v1#part'\nrequires_openai_auth = false\nlimit = 1_024`);
  assert.equal(config.model, 'test#model');
  assert.equal(config.model_providers['test.provider'].base_url, 'https://example.test/v1#part');
  assert.equal(config.model_providers['test.provider'].requires_openai_auth, false);
  assert.equal(config.model_providers['test.provider'].limit, 1024);
});

for (const source of ['model = "unterminated', 'broken', 'model = "a"\nmodel = "b"', '[__proto__]\npolluted = true', 'model = "a"\n[model]\nx = 1']) {
  test(`TOML rejects malformed or conflicting config: ${source.split('\n')[0]}`, () => {
    assert.throws(() => parseToml(source));
    assert.equal({}.polluted, undefined);
  });
}

test('defaults do not mix the desktop Codex model or global OpenAI key into APInex', async (t) => {
  const homeDir = await temporary(t);
  await write(homeDir, '.codex/config.toml', 'model = "unrelated-desktop-model"');
  await write(homeDir, '.codex/auth.json', '{"OPENAI_API_KEY":"unrelated-key"}');
  const config = await loadConfig({ homeDir, env: { OPENAI_API_KEY: 'global-openai-secret' } });
  assert.equal(config.model, 'free/claude-opus-4.6');
  assert.equal(config.apiKey, '');
  assert.equal(config.configExists, false);
  assert.match(config.configPath, /\.own-codex/);
});

test('explicit legacy paths remain supported with environment overrides', async (t) => {
  const homeDir = await temporary(t);
  const configPath = await write(homeDir, '.codex/config.toml', 'model = "old"');
  const authPath = await write(homeDir, '.codex/auth.json', '{"OPENAI_API_KEY":"old-key"}');
  const config = await loadConfig({ homeDir, env: {
    OWN_CODEX_CONFIG_PATH: configPath, OWN_CODEX_AUTH_PATH: authPath, APINEX_API_KEY: 'new-key',
    OWN_CODEX_MODEL: 'new', OWN_CODEX_BASE_URL: 'https://example.test/v1///',
    OWN_CODEX_MAX_OUTPUT_TOKENS: '512', OWN_CODEX_TIMEOUT_MS: '1000',
  } });
  assert.equal(config.apiKey, 'new-key');
  assert.equal(config.model, 'new');
  assert.equal(config.baseUrl, 'https://example.test/v1');
  assert.equal(config.timeoutMs, 1000);
  assert.equal(config.maxOutputTokens, 512);
});

test('provider env_key and authentication-free local providers work', async (t) => {
  const homeDir = await temporary(t);
  await write(homeDir, '.own-codex/config.toml', `model = 'local-model'\nmodel_provider = 'local'\n[model_providers.local]\nbase_url = 'http://localhost:1234/v1'\nenv_key = 'LOCAL_TOKEN'\nrequires_openai_auth = false\nwire_api = 'chat'`);
  const config = await loadConfig({ homeDir, env: { LOCAL_TOKEN: 'local-secret', APINEX_API_KEY: 'wrong-provider' } });
  assert.equal(config.apiKey, 'local-secret');
  assert.equal(config.requiresOpenAiAuth, false);
  assert.equal(config.wireApi, 'chat');
});

test('OpenAI provider selects its own environment key', async (t) => {
  const homeDir = await temporary(t);
  await write(homeDir, '.own-codex/config.toml', `model = 'test-model'\nmodel_provider = 'openai'\n[model_providers.openai]\nbase_url = 'https://example.test/v1'`);
  const config = await loadConfig({ homeDir, env: { OPENAI_API_KEY: 'correct', APINEX_API_KEY: 'wrong' } });
  assert.equal(config.apiKey, 'correct');
});

for (const [label, settings] of [
  ['unknown provider endpoint', "model_provider = 'custom'"],
  ['blank model', "model = ''"],
  ['non-string model', 'model = true'],
  ['non-string provider', 'model_provider = true'],
  ['false provider', 'model_provider = false'],
  ['empty provider', "model_provider = ''"],
  ['empty endpoint', "model_providers.apinex.base_url = ''"],
  ['missing value', 'model ='],
  ['provider scalar', 'model_providers.apinex = 5'],
  ['env key type', 'model_providers.apinex.env_key = true'],
  ['auth setting type', "model_providers.apinex.requires_openai_auth = 'false'"],
]) {
  test(`configuration rejects ${label}`, async (t) => {
    const homeDir = await temporary(t);
    await write(homeDir, '.own-codex/config.toml', settings);
    await assert.rejects(loadConfig({ homeDir, env: {} }));
  });
}

for (const url of ['invalid', 'file:///tmp/config', 'https://name:secret@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/#fragment']) {
  test(`configuration rejects invalid endpoint ${url}`, async (t) => {
    await assert.rejects(loadConfig({ homeDir: await temporary(t), env: { OWN_CODEX_BASE_URL: url } }), /base_url/);
  });
}

for (const value of ['', 'abc', '-1', '0', '1.5', 'Infinity', '2147483648']) {
  test(`positive integer options reject ${JSON.stringify(value)}`, () => {
    assert.throws(() => positiveInteger(value, 4096, '--limit'), /positive integer/);
  });
}

test('setup is idempotent, isolates Codex files, and treats placeholders as missing', async (t) => {
  const homeDir = await temporary(t);
  const existing = await write(homeDir, '.codex/config.toml', 'desktop settings');
  const first = await writeSetupFiles({ homeDir, env: {} });
  assert.equal(first.writes.length, 2);
  assert.equal(first.backups.length, 0);
  const config = await loadConfig({ homeDir, env: {} });
  assert.equal(config.apiKey, '');
  assert.equal(config.configExists, true);
  const second = await writeSetupFiles({ homeDir, env: {} });
  assert.deepEqual(second.writes, []);
  assert.equal(await fs.readFile(existing, 'utf8'), 'desktop settings');
});

test('forced setup preserves recoverable backups and honors custom paths', async (t) => {
  const homeDir = await temporary(t);
  const env = { OWN_CODEX_CONFIG_PATH: path.join(homeDir, 'nested', 'settings.toml'), OWN_CODEX_AUTH_PATH: path.join(homeDir, 'auth', 'keys.json') };
  await writeSetupFiles({ homeDir, env });
  await fs.writeFile(env.OWN_CODEX_AUTH_PATH, '{"api_key":"existing-secret"}');
  const result = await writeSetupFiles({ homeDir, env, force: true });
  assert.equal(result.backups.length, 2);
  assert.equal(await fs.readFile(result.backups[1], 'utf8'), '{"api_key":"existing-secret"}');
  assert.equal((await loadConfig({ homeDir, env })).apiKey, '');
});

test('setup rejects colliding paths', async (t) => {
  const homeDir = await temporary(t);
  const same = path.join(homeDir, 'same');
  await assert.rejects(writeSetupFiles({ homeDir, env: { OWN_CODEX_CONFIG_PATH: same, OWN_CODEX_AUTH_PATH: same } }), /different/);
});

for (const auth of ['{broken', '[]', 'null', '{"api_key": 42}']) {
  test(`malformed auth is reported without echoing its contents: ${auth}`, async (t) => {
    const homeDir = await temporary(t);
    await write(homeDir, '.own-codex/auth.json', auth);
    await assert.rejects(loadConfig({ homeDir, env: {} }));
  });
}

test('secrets are fully masked', () => {
  assert.equal(maskSecret('sk-very-long-secret'), '********');
  assert.equal(maskSecret('tiny'), '********');
  assert.equal(maskSecret(''), '(missing)');
});
