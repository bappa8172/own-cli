import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export async function temporary(t, prefix = 'own-test-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

export async function write(root, name, contents) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return file;
}

export function cli(args, { env = {}, input = '', cwd, entrypoint = fileURLToPath(new URL('../src/cli.js', import.meta.url)) } = {}) {
  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OWN_CODEX_|APINEX_API_KEY$|OPENAI_API_KEY$)/i.test(name)));
    const child = spawn(process.execPath, [entrypoint, ...args], {
      env: { ...cleanEnv, ...env }, cwd, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI did not exit: ${args.join(' ')}`)); }, 15000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}

export async function server(t, handler) {
  const requests = [];
  const instance = http.createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const record = { url: request.url, headers: request.headers, body: data ? JSON.parse(data) : null };
    requests.push(record);
    try { await handler(record, response); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return { requests, baseUrl: `http://127.0.0.1:${instance.address().port}/v1` };
}
