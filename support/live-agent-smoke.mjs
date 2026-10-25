// Explicit live check: sends a tiny tool task to the configured provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createWorkspace } from '../src/workspace.js';
import { workspacePrompt } from '../src/prompt.js';
import { runAgent } from '../src/agent.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'own-agent-live-'));
try {
  const config = await loadConfig();
  config.model = process.argv[2] || config.model;
  config.maxOutputTokens = 1200;
  config.timeoutMs = 60000;
  const workspace = await createWorkspace({ root, permissions: 'all' });
  const result = await runAgent({
    config, workspace, maxSteps: 12, stream: false,
    messages: [{ role: 'system', content: workspacePrompt(workspace) }, { role: 'user', content:
      'Perform this small tool integration check now: create folder demo; create demo/hello.txt containing exactly "agent verified" without a newline; '
      + 'read it using read_file; then run node with args ["-e", "const fs=require(\'fs\'); if(fs.readFileSync(\'demo/hello.txt\',\'utf8\')!==\'agent verified\') process.exit(1); console.log(\'check passed\')"]. '
      + 'Use actual tools for each operation. After the command succeeds, reply with a one-sentence summary.' }],
    onTool: (event) => console.log(JSON.stringify({ tool: event.name, ok: event.ok, path: event.path, action: event.action, exitCode: event.exitCode, error: event.error })),
  });
  assert.equal(await fs.readFile(path.join(root, 'demo/hello.txt'), 'utf8'), 'agent verified');
  assert.ok(result.commands.some((command) => command.exitCode === 0 && command.stdout.includes('check passed')));
  console.log(JSON.stringify({ ok: true, model: config.model, steps: result.steps, changes: result.changes, commandExitCodes: result.commands.map((command) => command.exitCode), answer: result.text }, null, 2));
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('own-agent-live-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
