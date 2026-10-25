import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { digest } from '../session/store.js';

export async function connectMcpServers(file, { env = process.env, cwd = process.cwd(), signal, timeoutMs = 20000 } = {}) {
  if (!file) return { tools: [], async call() { throw new Error('No MCP servers are connected.'); }, async close() {} };
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  const servers = config.mcpServers || config.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('MCP config must contain an mcpServers object.');
  const connections = []; const registry = new Map(); let counter = 0;
  try {
    for (const [serverName, settings] of Object.entries(servers)) {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Invalid MCP server settings: ${serverName}`);
      if (connections.length >= 8) throw new Error('At most eight MCP servers can be connected.');
      let request; let notify; let close; let sessionId;
      if (settings.url) {
        const endpoint = new URL(settings.url);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid MCP HTTP URL.');
        const send = async (message, callSignal) => {
          const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
          if (sessionId) headers['Mcp-Session-Id'] = sessionId;
          if (settings.env_key) { if (!env[settings.env_key]) throw new Error(`Missing environment variable for MCP server ${serverName}.`); headers.authorization = `Bearer ${env[settings.env_key]}`; }
          const combined = [signal, callSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean);
          const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'error', signal: AbortSignal.any(combined) });
          sessionId ||= response.headers.get('Mcp-Session-Id');
          if (!response.ok) throw new Error(`MCP server ${serverName} returned HTTP ${response.status}.`);
          if (message.id === undefined) { await response.body?.cancel(); return; }
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let size = 0;
          try {
            const sse = response.headers.get('content-type')?.includes('text/event-stream');
            while (true) {
              const part = await reader.read(); buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done }); size += part.value?.length || 0;
              if (size > 4194304) throw new Error('MCP response exceeded 4 MiB.');
              if (sse) {
                let boundary;
                buffer = buffer.replace(/\r\n/g, '\n');
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                  const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
                  const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
                  if (data) { const value = JSON.parse(data); if (value.id === message.id) return value; }
                }
              }
              if (part.done) break;
            }
            if (!sse) return JSON.parse(buffer);
            throw new Error('MCP stream ended without the matching response.');
          } finally { await reader.cancel(); }
        };
        request = async (method, params, options = {}) => send({ jsonrpc: '2.0', id: ++counter, method, params }, options.signal);
        notify = (method) => send({ jsonrpc: '2.0', method });
        close = async () => {};
      } else {
        if (typeof settings.command !== 'string' || !Array.isArray(settings.args || []) || (settings.args || []).some((arg) => typeof arg !== 'string')) throw new Error('MCP stdio server needs a command and string args.');
        if (settings.passEnv && (!Array.isArray(settings.passEnv) || settings.passEnv.some((key) => typeof key !== 'string'))) throw new Error('MCP passEnv must be an array of environment names.');
        const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) && !/^OWN_CODEX_/i.test(key) && key.toLowerCase() !== 'psmodulepath'));
        for (const name of settings.passEnv || []) if (env[name] !== undefined) childEnv[name] = env[name];
        let executable = settings.command === 'node' ? process.execPath : settings.command; let args = settings.args || [];
        if (process.platform === 'win32' && ['npm', 'npx'].includes(settings.command)) {
          const entrypoint = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${settings.command}-cli.js`);
          await fs.access(entrypoint); executable = process.execPath; args = [entrypoint, ...args];
        }
        if (settings.cwd !== undefined && typeof settings.cwd !== 'string') throw new Error('MCP cwd must be a path string.');
        const directory = settings.cwd ? path.resolve(path.dirname(path.resolve(file)), settings.cwd) : cwd;
        const child = spawn(executable, args, { cwd: directory, env: childEnv, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        const waiting = new Map();
        const rejectAll = (error) => { for (const item of waiting.values()) item.reject(error); waiting.clear(); };
        child.on('error', (error) => rejectAll(new Error(`MCP server ${serverName}: ${error.code || 'startup failed'}`)));
        child.on('exit', () => rejectAll(new Error(`MCP server ${serverName} exited.`)));
        child.stderr.resume(); child.stdin.on('error', (error) => rejectAll(error));
        const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on('line', (line) => {
          try {
            if (line.length > 4194304) throw new Error('MCP response exceeded 4 MiB.');
            const value = JSON.parse(line);
            if (waiting.has(value.id)) { waiting.get(value.id).resolve(value); waiting.delete(value.id); }
            else if (value.id !== undefined && value.method) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Client requests are not supported.' } }) + '\n');
          } catch (error) { rejectAll(error); child.kill(); }
        });
        request = (method, params, options = {}) => new Promise((resolve, reject) => {
          if (signal?.aborted || options.signal?.aborted) { reject(new Error('MCP request cancelled.')); return; }
          const id = ++counter;
          const cancel = () => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Cancelled by client' } }) + '\n'); finish(new Error('MCP request cancelled.')); };
          const timer = setTimeout(() => finish(new Error('MCP request timed out.')), timeoutMs);
          const finish = (error, value) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); options.signal?.removeEventListener('abort', cancel); waiting.delete(id); error ? reject(error) : resolve(value); };
          waiting.set(id, { resolve: (value) => finish(null, value), reject: (error) => finish(error) });
          signal?.addEventListener('abort', cancel, { once: true }); options.signal?.addEventListener('abort', cancel, { once: true });
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
        notify = async (method) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); };
        close = async () => {
          lines.close(); rejectAll(new Error('MCP connection closed.')); child.stdin.end();
          if (child.exitCode !== null || !child.pid) return;
          if (process.platform === 'win32') await new Promise((resolve) => {
            const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
            const finish = () => { clearTimeout(timer); resolve(); };
            killer.on('error', () => { child.kill(); finish(); }); killer.on('close', finish);
          });
          else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
        };
      }
      const connection = { request, close }; connections.push(connection);
      const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'own-codex-cli', version: '0.4.0' } });
      if (initialized.error) throw new Error(initialized.error.message || 'MCP initialization failed.');
      await notify('notifications/initialized');
      let cursor; const cursors = new Set();
      do {
        const reply = await request('tools/list', cursor ? { cursor } : {});
        if (reply.error || !Array.isArray(reply.result?.tools)) throw new Error(`Invalid tool list from MCP server ${serverName}.`);
        for (const tool of reply.result.tools) {
          if (registry.size >= 64) throw new Error('MCP tool limit exceeded (64).');
          const name = `mcp_${serverName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 12)}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}_${digest(serverName + ':' + tool.name).slice(0, 8)}`;
          registry.set(name, { connection, original: tool.name, name, description: String(tool.description || tool.name).slice(0, 4000), parameters: tool.inputSchema || { type: 'object', properties: {} }, readOnly: tool.annotations?.readOnlyHint === true });
        }
        cursor = reply.result.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('MCP server repeated its pagination cursor.');
        cursors.add(cursor);
      } while (cursor);
    }
    return { tools: [...registry.values()].map(({ connection, original, ...tool }) => tool).sort((a, b) => a.name.localeCompare(b.name)),
      async call(name, args, options) {
        const tool = registry.get(name); if (!tool) throw new Error('Unknown MCP tool.');
        const reply = await tool.connection.request('tools/call', { name: tool.original, arguments: args }, options);
        if (reply.error) throw new Error(reply.error.message || 'MCP tool failed.');
        if (reply.result?.isError) throw new Error(JSON.stringify(reply.result.content));
        return { content: reply.result?.content || [] };
      }, async close() { for (const connection of connections) await connection.close(); } };
  } catch (error) { for (const connection of connections) await connection.close(); throw error; }
}
