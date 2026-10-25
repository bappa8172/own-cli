import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createChatInput, slashSuggestions, slashCompletions } from '../src/tui/input.js';
import { createActivity } from '../src/tui/activity.js';
import { pickModel } from '../src/cli.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function terminal(t) {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  output.isTTY = true; output.columns = 120;
  const ui = createChatInput({ input, output, getModels: () => [{ id: 'free/fixture', pricing: 'free' }, { id: 'paid/fixture', pricing: 'paid' }] });
  t.after(() => { ui.close(); input.destroy(); output.destroy(); });
  return { ui, input, output, text: () => text };
}

test('slash preview filters commands/models and Tab completes their full names', () => {
  const models = [{ id: 'free/fixture', pricing: 'free' }, { id: 'paid/fixture', pricing: 'paid' }];
  assert.ok(slashSuggestions('/').some((entry) => entry.value === '/model'));
  assert.deepEqual(slashCompletions('/mod', models), [['/model'], '/mod']);
  assert.ok(slashSuggestions('/model free/', models).every((entry) => entry.value.includes('free/')));
  assert.ok(slashSuggestions('/auth r').some((entry) => entry.value === '/auth rotate'));
  assert.deepEqual(slashSuggestions('ordinary text'), []);
});

test('interactive input draws live suggestions and handles Tab without losing the submitted prompt', async (t) => {
  const { ui, input, text } = terminal(t);
  const pending = ui.readLine('you> ');
  input.write('/mod'); await tick();
  assert.match(text(), /Browse\/search models/);
  input.write('\t'); await tick();
  assert.equal(ui.rl.line, '/model');
  input.write(' free/'); await tick();
  assert.match(text(), /free\/fixture/);
  input.write('fixture\r');
  assert.equal(await pending, '/model free/fixture');
});

test('private key entry never echoes its bytes or retains them in readline history', async (t) => {
  const { ui, input, text } = terminal(t);
  let pending = ui.readLine('you> '); input.write('previous\r'); await pending;
  pending = ui.readLine('API key (hidden): ', { secret: true });
  input.write('super-private-key'); await tick();
  assert.doesNotMatch(text(), /super-private-key/);
  input.write('\r'); assert.equal(await pending, 'super-private-key');
  assert.doesNotMatch(JSON.stringify(ui.rl.history), /super-private-key/);
  assert.ok(ui.rl.history.includes('previous'));
  pending = ui.readLine('you> '); input.write('/auth add backup\r'); await pending;
  assert.ok(!ui.rl.history.some((line) => line.startsWith('/auth')));
  pending = ui.readLine('you> '); input.write('/status\r'); assert.equal(await pending, '/status');
  assert.match(text(), /\/status/);
});

test('cancelled secret prompts clear private history and leave the next prompt usable', async (t) => {
  const { ui, input, text } = terminal(t); const controller = new AbortController();
  const pending = ui.readLine('API key: ', { secret: true, signal: controller.signal });
  input.write('cancelled-private-key'); await tick(); controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.doesNotMatch(text() + JSON.stringify(ui.rl.history), /cancelled-private-key/);
  const next = ui.readLine('you> '); input.write('/exit\r');
  assert.equal(await next, '/exit');
});

test('EOF closes a pending interactive prompt instead of hanging', async (t) => {
  const { ui, input } = terminal(t);
  const pending = ui.readLine(); input.end();
  assert.equal(await pending, null);
});

test('piped chat keeps all buffered lines and rejects private key entry', async (t) => {
  const input = new PassThrough(); const output = new PassThrough(); const ui = createChatInput({ input, output });
  t.after(() => ui.close());
  await assert.rejects(ui.readLine('key', { secret: true }), /stdin-key/);
  input.end('first\nsecond\n');
  assert.equal(await ui.readLine(), 'first'); await tick(); assert.equal(await ui.readLine(), 'second'); assert.equal(await ui.readLine(), null);
});

test('activity reports processing/tool stages and clears before streamed text or approval', () => {
  let text = ''; const output = { isTTY: true, columns: 140, write: (chunk) => { text += chunk; } };
  const activity = createActivity({ output });
  activity.event({ type: 'model.started', data: { model: 'free/fixture', step: 2 } });
  assert.match(text, /Thinking \/ processing.*free\/fixture.*round 2/);
  activity.event({ type: 'token.delta', data: { delta: 'hello' } });
  assert.ok(text.endsWith('\r\x1b[2K'));
  activity.event({ type: 'tool.started', data: { name: 'write_file' } });
  assert.match(text, /Running write_file/);
  activity.event({ type: 'approval.needed', data: {} });
  assert.ok(text.endsWith('\r\x1b[2K'));
  const before = text; createActivity({ output, enabled: false }).start('hidden'); assert.equal(text, before);
});

test('model picker searches, filters free models, pages and returns the selected real model ID', async (t) => {
  const { ui, input } = terminal(t);
  let screen = '';
  const models = Array.from({ length: 25 }, (_, index) => ({ id: `free/model-${index}`, pricing: 'free' }));
  models.push({ id: 'paid/model', pricing: 'paid' });
  const pending = pickModel(models, { config: { model: 'free/model-0' }, input: ui, freeOnly: false, print: (line) => { screen += line + '\n'; } });
  assert.match(screen, /20\. \[FREE\] free\/model-19/);
  input.write(':next\r'); await tick(); assert.match(screen, /26\. \[PAID\] paid\/model/);
  input.write(':free\r'); await tick();
  input.write('model-24\r'); await tick(); assert.match(screen, /Models: 1 matches/);
  input.write('1\r'); assert.equal(await pending, 'free/model-24');
});
