// Local-only terminal demonstration: fake credentials, local HTTP, disposable state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { storeCredential } from '../src/config-vault.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'own-preview-smoke-'));
const root = path.join(directory, 'project'); await fs.mkdir(root);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OWN_CODEX_|APINEX_API_KEY$|OPENAI_API_KEY$)/i.test(key)));
const env = { ...cleanEnv, OWN_CODEX_HOME: path.join(directory, 'private-state'), OWN_CODEX_MODEL: 'free/preview', OWN_CODEX_VAULT_KEY: 'temporary-preview-master-key-at-least-32-characters' };
await storeCredential('apinex', 'fixture-primary-private', { env, label: 'primary' });
await storeCredential('apinex', 'fixture-backup-private', { env, label: 'backup', add: true });
let rejected = false;
const server = http.createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain */ }
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'free/preview' }, { id: 'free/second' }, { id: 'paid/fixture', is_free: false }] }));
  if (request.headers.authorization === 'Bearer fixture-primary-private' && !rejected) { rejected = true; response.writeHead(429); return response.end('{"error":"local fixture quota rejection"}'); }
  const timer = setTimeout(() => response.end(JSON.stringify({ output_text: 'Preview smoke passed. This was a local fixture, with no external API request.', usage: { input_tokens: 12, output_tokens: 8 } })), 1200);
  response.on('close', () => clearTimeout(timer));
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  env.OWN_CODEX_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  console.error('LOCAL FIXTURE: try /model, /auth, then hi. First model request exercises key failover. /exit cleans up.');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'chat', '--root', root, '--no-context', '--no-session'], { env, stdio: 'inherit', windowsHide: true });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code || 0)); });
} finally {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
