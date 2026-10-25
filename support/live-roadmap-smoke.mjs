// Explicit, small live check of the event/session/runtime path. No user project files are sent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createRuntime } from '../src/core/runtime.js';
import { workspacePrompt } from '../src/prompt.js';
import { readEvents } from '../src/session/store.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'own-roadmap-live-'));
const root = path.join(fixture, 'project');
const home = path.join(fixture, 'state');
await fs.mkdir(root); await fs.mkdir(home);
let runtime;
try {
  const config = await loadConfig(); config.model = process.argv[2] || config.model;
  config.maxOutputTokens = 1400; config.timeoutMs = 60000;
  const options = { root, env: { ...process.env, OWN_CODEX_HOME: home }, permissions: 'all', maxSteps: 12, maxMs: 180000 };
  runtime = await createRuntime({ config, options, onEvent: (event) => {
    if (event.type === 'tool.completed') console.log(JSON.stringify({ type: event.type, name: event.data.name, ok: event.data.result.ok, path: event.data.result.path, exitCode: event.data.result.exitCode }));
  } });
  const result = await runtime.run({ stream: false, messages: [{ role: 'system', content: workspacePrompt(runtime.workspace) }, { role: 'user', content:
    'Integration check: create demo/hello.txt with exactly "runtime verified" and no newline. Use write_file, read_file to confirm it, and run_command with command "node" and args '
    + '["-e", "const fs=require(\'fs\'); if(fs.readFileSync(\'demo/hello.txt\',\'utf8\')!==\'runtime verified\') process.exit(1); console.log(\'check passed\')"]. '
    + 'Do not use other commands or edit any other files. Then give one sentence confirming the actual result.' }] });
  assert.equal(await fs.readFile(path.join(root, 'demo/hello.txt'), 'utf8'), 'runtime verified');
  assert.ok(result.commands.some((command) => command.exitCode === 0 && command.stdout.includes('check passed')));
  const sessionId = result.sessionId; const sessionDirectory = runtime.session.directory;
  await runtime.close(); runtime = undefined;
  const events = await readEvents(sessionDirectory); assert.ok(events.some((event) => event.type === 'file.checkpoint'));
  runtime = await createRuntime({ config, options: { ...options, resume: sessionId } });
  assert.equal(runtime.history.length, 2);
  const undo = await runtime.undo(); assert.ok(undo.restored.includes('demo/hello.txt'));
  await assert.rejects(fs.access(path.join(root, 'demo')));
  console.log(JSON.stringify({ ok: true, model: config.model, steps: result.steps, sessionResume: 'passed', auditVerification: 'passed', undo: 'passed',
    accounting: result.accounting, commandExitCodes: result.commands.map((command) => command.exitCode), answer: result.text }, null, 2));
} finally {
  await runtime?.close();
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith('own-roadmap-live-'));
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
