import readline from 'node:readline';
export async function serveMcp({ run, input = process.stdin, output = process.stdout } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const active = new Map(); const tasks = new Set(); let initialized = false;
  const send = (value) => output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const handle = async (message) => {
    const id = message.id;
    if (message.method === 'notifications/cancelled') { active.get(message.params?.requestId)?.abort(); return; }
    if (id === undefined) return;
    if (message.method === 'initialize') {
      initialized = true;
      send({ id, result: { protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'own-codex-cli', version: '0.4.0' } } }); return;
    }
    if (!initialized) { send({ id, error: { code: -32002, message: 'Initialize the server first.' } }); return; }
    if (message.method === 'ping') { send({ id, result: {} }); return; }
    if (message.method === 'tools/list') { send({ id, result: { tools: [{ name: 'agent_run', description: 'Run a coding task in this server’s configured project and permission mode.',
      inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false } }] } }); return; }
    if (message.method !== 'tools/call') { send({ id, error: { code: -32601, message: 'Method not found.' } }); return; }
    if (message.params?.name !== 'agent_run' || typeof message.params.arguments?.prompt !== 'string' || !message.params.arguments.prompt.trim()
      || Object.keys(message.params.arguments).some((key) => key !== 'prompt')) { send({ id, error: { code: -32602, message: 'agent_run requires a prompt string.' } }); return; }
    if (active.size) { send({ id, error: { code: -32000, message: 'This project already has an active task. Use another server/worktree for parallel tasks.' } }); return; }
    const controller = new AbortController(); active.set(id, controller);
    try { const result = await run(message.params.arguments.prompt, controller.signal); send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false } }); }
    catch (error) { send({ id, result: { content: [{ type: 'text', text: error.message }], isError: true } }); }
    finally { active.delete(id); }
  };
  for await (const line of lines) {
    let message;
    try { if (line.length > 2097152) throw new Error(); message = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Parse error.' } }); continue; }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { send({ id: message?.id ?? null, error: { code: -32600, message: 'Invalid request.' } }); continue; }
    const task = handle(message).catch((error) => send({ id: message.id ?? null, error: { code: -32603, message: error.message } }));
    tasks.add(task); task.finally(() => tasks.delete(task));
  }
  await Promise.all(tasks);
}
