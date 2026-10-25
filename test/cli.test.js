import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { cli, server, temporary, write } from '../support/fixtures.js';

test('every value option consumes its immediate argument without dropping prompt words', () => {
  const parsed = parseArgs(['ask', 'fix', '--root', 'some folder', '--file', 'src/a.js', '--file', 'src/b.js',
    '--dir', 'test', '--model', 'test-model', '--max-output-tokens', '200', '--max-context-chars', '1000',
    '--max-file-chars', '300', '--timeout-ms', '5000', 'please']);
  assert.equal(parsed.prompt, 'fix please');
  assert.equal(parsed.options.root, path.resolve('some folder'));
  assert.deepEqual(parsed.options.files, ['src/a.js', 'src/b.js']);
  assert.deepEqual(parsed.options.directories, ['test']);
  assert.equal(parsed.options.model, 'test-model');
  assert.equal(parsed.options.maxOutputTokens, 200);
  assert.equal(parsed.options.maxContextChars, 1000);
  assert.equal(parsed.options.maxFileChars, 300);
  assert.equal(parsed.options.timeoutMs, 5000);
});

test('parser supports equals syntax, repeated roots, literal -- and shorthand prompts', () => {
  const parsed = parseArgs(['ask', '--root=first', '--root=second', '--file=a.js', '--max-output-tokens=50', '--', '--literal', 'text']);
  assert.equal(parsed.options.root, path.resolve('second'));
  assert.deepEqual(parsed.options.files, ['a.js']);
  assert.equal(parsed.prompt, '--literal text');
  assert.equal(parseArgs(['explain', 'this']).command, 'ask');
  assert.equal(parseArgs([]).command, 'chat');
});

for (const args of [
  ['ask', '--model'], ['ask', '--root', '--no-context'], ['ask', '--file='], ['ask', '--max-file-chars', 'NaN'],
  ['ask', '--max-context-chars', '-1'], ['ask', '--timeout-ms', '0'], ['ask', '--max-output-tokens', '1.5'],
  ['ask', '--unknown'], ['ask', '--no-stream=true'], ['ask', '--force'], ['ask', '--live'],
  ['chat', '--json'], ['config', 'stray-prompt'], ['doctor', '--file', 'x'], ['setup', '--model', 'x'],
  ['ask', '--no-context', '--file', 'x'],
]) {
  test(`parser rejects invalid arguments: ${args.join(' ')}`, () => assert.throws(() => parseArgs(args)));
}

test('help, version and import do not require credentials or configuration', async (t) => {
  const home = await temporary(t);
  await write(home, 'config.toml', 'invalid config');
  const env = { OWN_CODEX_HOME: home };
  const help = await cli(['--help'], { env });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /can create folders/);
  const version = await cli(['--version'], { env });
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), '0.5.0');
});

test('config output and doctor report missing/placeholder auth truthfully', async (t) => {
  const home = await temporary(t);
  const env = { OWN_CODEX_HOME: home };
  const setup = await cli(['setup'], { env });
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /auth.json/);
  const config = await cli(['config', '--json'], { env });
  assert.equal(config.code, 0);
  assert.equal(JSON.parse(config.stdout).apiKeyConfigured, false);
  assert.doesNotMatch(config.stdout, /PASTE_YOUR/);
  const doctor = await cli(['doctor', '--live', '--json'], { env });
  assert.equal(doctor.code, 1);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.live, 'blocked');
  assert.match(report.issues.join(), /missing/);
});

test('context inspection works even with invalid API configuration', async (t) => {
  const home = await temporary(t);
  const root = await temporary(t);
  await write(home, 'config.toml', 'invalid config');
  await write(root, 'src/main.js', 'export const answer = 42;');
  const result = await cli(['context', '--root', root, '--file', 'src/main.js', '--max-context-chars', '200', '--json'], { env: { OWN_CODEX_HOME: home } });
  assert.equal(result.code, 0, result.stderr);
  const context = JSON.parse(result.stdout);
  assert.deepEqual(context.files, ['src/main.js']);
  assert.ok(context.chars <= 200);
  assert.match(context.text, /answer = 42/);
});

test('ask prints JSON fallback once, sends the selected file, and applies API overrides', async (t) => {
  const home = await temporary(t);
  const root = await temporary(t);
  await write(root, 'main.js', 'const marker = "selected-file";');
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ output_text: 'visible answer' }));
  });
  const result = await cli(['ask', 'explain', '--root', root, '--file', 'main.js', '--model', 'override-model', '--max-output-tokens', '120'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'visible answer\n');
  assert.match(result.stderr, /Context: 1 files/);
  const { body, headers, url } = api.requests[0];
  assert.equal(url, '/v1/responses');
  assert.equal(headers.authorization, 'Bearer test-key');
  assert.equal(body.model, 'override-model');
  assert.equal(body.max_output_tokens, 120);
  assert.match(body.instructions, /actual project files with tools/);
  assert.match(JSON.stringify(body.input), /selected-file/);
  assert.equal(body.input.at(-1).content, 'explain');
});

test('ask supports piped prompts and clean JSON output with actual response metadata', async (t) => {
  const home = await temporary(t);
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ output_text: 'piped answer', model: 'returned-model', usage: { total_tokens: 3 } }));
  });
  const result = await cli(['ask', '--no-context', '--json'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' }, input: 'explain my piped request\n',
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.text, 'piped answer');
  assert.equal(output.model, 'returned-model');
  assert.equal(output.usage.total_tokens, 3);
  assert.equal(output.context.chars, 0);
  assert.equal(result.stderr, '');
  assert.equal(api.requests[0].body.stream, false);
  assert.equal(api.requests[0].body.input.at(-1).content, 'explain my piped request');
});

test('ask streams output once and no-stream buffers the same answer', async (t) => {
  const home = await temporary(t);
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.output_text.delta\ndata: {"delta":"hello "}\n\n');
    response.end('event: response.completed\ndata: {"response":{"output_text":"hello world"}}\n\n');
  });
  const env = { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' };
  const streamed = await cli(['ask', 'hello', '--no-context'], { env });
  const buffered = await cli(['ask', 'hello', '--no-context', '--no-stream'], { env });
  assert.equal(streamed.code, 0, streamed.stderr);
  assert.equal(buffered.code, 0, buffered.stderr);
  assert.equal(streamed.stdout, 'hello world\n');
  assert.equal(buffered.stdout, streamed.stdout);
});

test('doctor --live sends only its probe and reports real request failures with nonzero exit', async (t) => {
  const home = await temporary(t);
  let fail = false;
  const api = await server(t, (_request, response) => {
    response.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(fail ? { error: { message: 'unavailable' } } : { output_text: 'OK' }));
  });
  const env = { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' };
  const success = await cli(['doctor', '--live', '--json'], { env });
  assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).live, 'ok');
  assert.deepEqual(api.requests[0].body.input, [{ content: 'Reply with OK only.', role: 'user' }]);
  assert.equal(api.requests[0].body.max_output_tokens, 16);
  fail = true;
  const failure = await cli(['doctor', '--live', '--json'], { env });
  assert.equal(failure.code, 1);
  assert.equal(JSON.parse(failure.stdout).live, 'failed');
  assert.match(JSON.parse(failure.stdout).issues.join(), /503/);
});

test('chat handles piped lines, request errors, clearing and EOF without losing later prompts', async (t) => {
  const home = await temporary(t);
  let index = 0;
  const api = await server(t, (_request, response) => {
    index += 1;
    response.writeHead(index === 1 ? 500 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(index === 1 ? { error: { message: 'retry me' } } : { output_text: `answer ${index}` }));
  });
  const result = await cli(['chat', '--no-context'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
    input: 'first\nsecond\n/clear\nthird\n',
  });
  assert.equal(result.code, 1); // Failed requests remain visible to scripts even if a later turn succeeds.
  assert.match(result.stderr, /retry me/);
  assert.match(result.stdout, /answer 2/);
  assert.match(result.stdout, /answer 3/);
  assert.equal(api.requests.length, 3);
  assert.deepEqual(api.requests[1].body.input, [{ role: 'user', content: 'second' }]);
  assert.deepEqual(api.requests[2].body.input, [{ role: 'user', content: 'third' }]);
  assert.doesNotMatch(result.stderr, /readline was closed/);
});

test('long chats retain repository context while evicting old conversation turns', async (t) => {
  const home = await temporary(t);
  const root = await temporary(t);
  await write(root, 'main.js', 'persistent-repository-marker');
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"output_text":"answer"}');
  });
  const result = await cli(['chat', '--root', root, '--file', 'main.js', '--no-stream'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
    input: Array.from({ length: 20 }, (_, i) => `turn-${i}\n`).join('') + '/exit\n',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests.length, 20);
  const last = api.requests.at(-1).body;
  assert.match(last.input[0].content, /persistent-repository-marker/);
  assert.ok(last.input.length <= 13);
  assert.equal(last.input[1].role, 'user');
  assert.equal(last.input.at(-1).content, 'turn-19');
  assert.ok(!last.input.some((message) => message.content === 'turn-0'));
});

test('chat commands and empty EOF finish locally without credentials', async (t) => {
  const home = await temporary(t);
  const result = await cli(['chat', '--no-context'], { env: { OWN_CODEX_HOME: home }, input: '/help\n/context\n/config\n/unknown\n/exit\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\/clear/);
  assert.match(result.stdout, /"chars": 0/);
  assert.match(result.stderr, /Unknown chat command/);
  const eof = await cli(['chat', '--no-context'], { env: { OWN_CODEX_HOME: home } });
  assert.equal(eof.code, 0, eof.stderr);
});

test('CLI errors have nonzero status, JSON diagnostics and no secret leakage', async (t) => {
  const home = await temporary(t);
  const api = await server(t, (_request, response) => { response.writeHead(401); response.end('invalid secret-test-key'); });
  const result = await cli(['ask', 'hello', '--json', '--no-context'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'secret-test-key' },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /401/);
  assert.doesNotMatch(result.stderr, /secret-test-key/);
  const missing = await cli(['ask', '--no-context'], { env: { OWN_CODEX_HOME: home } });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /requires a prompt/);
});

test('setup force preserves old files and normal setup does not overwrite them', async (t) => {
  const home = await temporary(t);
  const env = { OWN_CODEX_HOME: home };
  await cli(['setup'], { env });
  await fs.writeFile(path.join(home, 'auth.json'), '{"api_key":"saved-key"}');
  const normal = await cli(['setup'], { env });
  assert.equal(normal.code, 0);
  assert.match(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), /saved-key/);
  const forced = await cli(['setup', '--force'], { env });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /Backups/);
  const backup = (await fs.readdir(home)).find((name) => name.startsWith('auth.json.') && name.endsWith('.bak'));
  assert.match(await fs.readFile(path.join(home, backup), 'utf8'), /saved-key/);
});

test('interrupting an ask cancels the active response body and exits promptly', async (t) => {
  const home = await temporary(t);
  const loader = await write(home, 'interrupt.mjs', `
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      setTimeout(() => process.emit('SIGINT'), 20);
      return response;
    };
  `);
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
  });
  const result = await cli(['ask', 'hello', '--no-context'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key', NODE_OPTIONS: `--import=${pathToFileURL(loader).href}` },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cancelled/);
});

test('normal output identifies a different model reported by the provider', async (t) => {
  const home = await temporary(t);
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"output_text":"answer","model":"provider-model"}');
  });
  const result = await cli(['ask', 'hello', '--no-context'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'answer\n');
  assert.match(result.stderr, /model reported by provider: provider-model/);
});

test('linked installations run the CLI through a directory junction', async (t) => {
  const root = await temporary(t);
  const linked = path.join(root, 'linked-package');
  await fs.symlink(fileURLToPath(new URL('../', import.meta.url)), linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await cli(['--version'], { entrypoint: path.join(linked, 'src', 'cli.js') });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.5.0');
});

test('models arguments support free filtering and JSON; chat uses its slash filter', () => {
  const parsed = parseArgs(['models', '--free', '--json', '--timeout-ms', '500']);
  assert.equal(parsed.command, 'models');
  assert.equal(parsed.options.free, true);
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.timeoutMs, 500);
  assert.throws(() => parseArgs(['chat', '--free']), /only valid for models/);
});

test('models --free --json returns only free models without making generation requests', async (t) => {
  const home = await temporary(t);
  const api = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'free/a' }, { id: 'paid', is_free: false }, { id: 'unknown' }] }));
  });
  const result = await cli(['models', '--free', '--json'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.total, 3);
  assert.equal(output.freeCount, 1);
  assert.deepEqual(output.models, [{ id: 'free/a', pricing: 'free' }]);
  assert.equal(api.requests[0].url, '/v1/models');
  assert.equal(api.requests[0].body, null);
  assert.equal(api.requests.length, 1);
});

test('/model lists all models, /model free filters, and switching affects the next request only', async (t) => {
  const home = await temporary(t);
  await write(home, 'config.toml', 'model = "original-model"');
  const before = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
  const api = await server(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url === '/v1/models'
      ? { data: [{ id: 'free/switched' }, { id: 'paid', is_free: false }, { id: 'unknown' }] }
      : { output_text: 'switched answer' }));
  });
  const result = await cli(['chat', '--no-context'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
    input: '/help\n/model\n/model free\n/model free/switched\n/config\nexplain\n/exit\n',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\/model \[free\|<id>\]/);
  assert.match(result.stdout, /\[FREE\] free\/switched/);
  assert.match(result.stdout, /\[PAID\] paid/);
  assert.match(result.stdout, /\[PRICE UNKNOWN\] unknown/);
  assert.equal((result.stdout.match(/\[PAID\] paid/g) || []).length, 1);
  assert.match(result.stdout, /Current model set to free\/switched \(this session only\)/);
  assert.match(result.stdout, /model: free\/switched/);
  assert.match(result.stdout, /switched answer/);
  assert.equal(api.requests.length, 3);
  assert.equal(api.requests[2].body.model, 'free/switched');
  assert.deepEqual(api.requests[2].body.input, [{ role: 'user', content: 'explain' }]);
  assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), before);
});

test('an unknown model is rejected without changing the selected model or corrupting chat', async (t) => {
  const home = await temporary(t);
  const api = await server(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url === '/v1/models' ? { data: [{ id: 'free/valid' }] } : { output_text: 'answer' }));
  });
  const result = await cli(['chat', '--no-context'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
    input: '/model nonexistent\nhello\n/exit\n',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Model not found/);
  assert.doesNotMatch(result.stdout, /Current model set/);
  assert.match(result.stdout, /answer/);
  assert.equal(api.requests[1].body.model, 'free/claude-opus-4.6');
});

test('catalog errors recover in chat and /models aliases /model', async (t) => {
  const home = await temporary(t);
  let count = 0;
  const api = await server(t, (_request, response) => {
    count += 1;
    response.writeHead(count === 1 ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(count === 1 ? { error: { message: 'try again' } } : { data: [{ id: 'free/recovered' }] }));
  });
  const result = await cli(['chat', '--no-context'], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
    input: '/model\n/models free\n/exit\n',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /503/);
  assert.match(result.stdout, /\[FREE\] free\/recovered/);
  assert.equal(api.requests.length, 2);
});

test('invalid model command syntax stays local and the top-level command reports missing auth', async (t) => {
  const home = await temporary(t);
  const result = await cli(['chat', '--no-context'], {
    env: { OWN_CODEX_HOME: home }, input: '/model too many arguments\n/exit\n',
  });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Usage: \/model/);
  const missing = await cli(['models', '--json'], { env: { OWN_CODEX_HOME: home } });
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.stderr).error, /Missing API key/);
});

test('agent arguments enable command permissions and reject contradictory modes', () => {
  const parsed = parseArgs(['chat', '--allow-run', '--all-context', '--max-steps', '30']);
  assert.equal(parsed.options.permissions, 'all');
  assert.equal(parsed.options.allContext, true);
  assert.equal(parsed.options.maxSteps, 30);
  assert.equal(parseArgs(['ask', 'hi', '--read-only']).options.permissions, 'read-only');
  assert.throws(() => parseArgs(['chat', '--permissions', 'unknown']), /must be/);
  assert.throws(() => parseArgs(['chat', '--read-only', '--allow-run']), /cannot be combined/);
  assert.throws(() => parseArgs(['chat', '--no-context', '--all-context']), /cannot be combined/);
  assert.throws(() => parseArgs(['chat', '--max-steps', '101']), /cannot exceed/);
  assert.throws(() => parseArgs(['config', '--permissions', 'all']), /not supported/);
});

for (const wireApi of ['responses', 'chat']) {
  test(`ask creates real project files using ${wireApi} tool calls and reports changes in JSON`, async (t) => {
    const root = await temporary(t);
    const home = await temporary(t);
    await write(home, 'config.toml', `model = 'test-model'\nmodel_providers.apinex.wire_api = '${wireApi}'`);
    const api = await server(t, (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (api.requests.length === 1) {
        const args = JSON.stringify({ path: 'amazon-clone/index.html', content: '<h1>Shopping home</h1>' });
        response.end(JSON.stringify(wireApi === 'responses' ? { output: [{ type: 'function_call', call_id: 'write1', name: 'write_file', arguments: args }] }
          : { choices: [{ message: { tool_calls: [{ id: 'write1', type: 'function', function: { name: 'write_file', arguments: args } }] }, finish_reason: 'tool_calls' }] }));
      } else {
        const output = wireApi === 'responses' ? request.body.input.at(-1).output : request.body.messages.at(-1).content;
        assert.equal(JSON.parse(output).ok, true);
        response.end(JSON.stringify(wireApi === 'responses' ? { output_text: 'Created amazon-clone/index.html.' }
          : { choices: [{ message: { content: 'Created amazon-clone/index.html.' }, finish_reason: 'stop' }] }));
      }
    });
    const result = await cli(['ask', 'create homepage', '--root', root, '--json', '--no-context'], {
      env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
    });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.steps, 2);
    assert.equal(output.changes[0].path, 'amazon-clone/index.html');
    assert.equal(output.changes[0].action, 'created');
    assert.equal(await fs.readFile(path.join(root, 'amazon-clone/index.html'), 'utf8'), '<h1>Shopping home</h1>');
    assert.equal(result.stderr, '');
  });
}

test('chat permission changes control exposed tools and newly created files refresh later context', async (t) => {
  const root = await temporary(t);
  const home = await temporary(t);
  const api = await server(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const last = request.body.input.at(-1);
    if (api.requests.length === 1) {
      assert.ok(request.body.tools.some((tool) => tool.name === 'run_command'));
      response.end(JSON.stringify({ output: [{ type: 'function_call', call_id: 'write1', name: 'write_file',
        arguments: JSON.stringify({ path: 'created.js', content: 'const refreshedMarker = 42;' }) }] }));
    } else if (last.type === 'function_call_output') response.end('{"output_text":"Created the file."}');
    else {
      assert.ok(!request.body.tools.some((tool) => tool.name === 'write_file'));
      assert.match(JSON.stringify(request.body.input), /refreshedMarker/);
      assert.match(request.body.instructions, /This session is read-only/);
      response.end('{"output_text":"Inspected updated context."}');
    }
  });
  const result = await cli(['chat', '--root', root], {
    env: { OWN_CODEX_HOME: home, OWN_CODEX_BASE_URL: api.baseUrl, APINEX_API_KEY: 'test-key' },
    input: '/permissions all\ncreate file\n/permissions read-only\ninspect it\n/exit\n',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\[write_file\] created.js — created/);
  assert.match(result.stdout, /Permissions set to all/);
  assert.match(result.stdout, /Inspected updated context/);
  assert.equal(api.requests.length, 3);
});

test('/context all loads beyond default excerpts, refreshes, and can switch back to none/auto', async (t) => {
  const root = await temporary(t);
  const home = await temporary(t);
  await write(root, 'large.js', 'a'.repeat(9000) + 'end-marker');
  await write(root, 'custom.extension', 'custom-text-marker');
  const result = await cli(['chat', '--root', root], {
    env: { OWN_CODEX_HOME: home }, input: '/context all\n/context\n/context refresh\n/context none\n/context auto\n/permissions\n/exit\n',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Context mode: all. 2 files loaded; 0 omitted, 0 excerpted/);
  assert.match(result.stdout, /"mode": "all"/);
  assert.match(result.stdout, /Context mode: none. 0 files loaded/);
  assert.match(result.stdout, /Context mode: auto. 1 files loaded/);
  assert.match(result.stdout, /Permissions: workspace/);
});

test('full-project context honors explicit budgets and scans more than the default candidate limit', async (t) => {
  const root = await temporary(t);
  const home = await temporary(t);
  await Promise.all(Array.from({ length: 310 }, (_, i) => write(root, `src/${String(i).padStart(3, '0')}.custom`, `text ${i}`)));
  await write(root, '.npmrc', 'auth-token=never-shared');
  const result = await cli(['context', '--root', root, '--all-context', '--json'], { env: { OWN_CODEX_HOME: home } });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.files.length, 310);
  assert.equal(output.omittedFiles.length, 0);
  assert.equal(output.truncatedFiles.length, 0);
  assert.doesNotMatch(output.text, /never-shared/);
  const bounded = await cli(['context', '--root', root, '--all-context', '--max-context-chars', '100', '--json'], { env: { OWN_CODEX_HOME: home } });
  assert.equal(bounded.code, 0, bounded.stderr);
  assert.ok(JSON.parse(bounded.stdout).chars <= 100);
  assert.ok(JSON.parse(bounded.stdout).omittedFiles.length > 0);
});
