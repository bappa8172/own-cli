import { createResponse } from './client.js';
import { randomUUID } from 'node:crypto';
import { UsageLedger } from './core/accounting.js';
import { boundObservation } from './core/compactor.js';

function cancellable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function runAgent({
  config, messages, workspace, maxSteps = 20, stream = true, onDelta, onTool, signal,
  responseImpl = createResponse, events, session, ledger = new UsageLedger(), maxMs = 600000, phase = 'implement', turnId = randomUUID(),
} = {}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('maxSteps must be from 1 to 100.');
  if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 2147483647) throw new Error('maxMs must be a positive integer no greater than 2147483647.');
  if (!Array.isArray(messages) || !workspace?.tools || !workspace?.execute || !config?.model) throw new Error('Agent requires messages, a workspace, and a configured model.');
  const externalSignal = signal;
  const input = [...messages];
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Agent request cancelled. Previous file changes, if any, remain on disk.'));
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Agent wall-clock budget exhausted after ${maxMs} ms. Previous changes remain on disk.`)), maxMs);
  signal = controller.signal;
  workspace.turnId = turnId;
  const emit = (type, data = {}) => events?.emit(type, { turnId, phase, ...data });
  const changeStart = workspace.changes.length;
  const commandStart = workspace.commands.length;
  const contextLimit = JSON.stringify(input).length + 512000;
  let callCount = 0;
  const usedIds = new Set();
  let modelInFlight = false;
  try {
  await emit(phase === 'implement' ? 'turn.started' : 'phase.started', { model: config.model });
  if (phase === 'implement') await emit('message.user', { content: messages.findLast((message) => message.role === 'user')?.content || '' });
  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) throw signal.reason;
    if (JSON.stringify(input).length > contextLimit) {
      for (const item of input.slice(0, -4)) {
        const key = item.type === 'function_call_output' ? 'output' : item.role === 'tool' ? 'content' : null;
        if (key && item[key]?.length > 2000) {
          const pointer = session ? await session.artifact(item[key]) : {};
          item[key] = JSON.stringify({ ...pointer, excerpt: item[key].slice(0, 1000), truncated: true });
        }
      }
      await emit('context.compacted', { chars: JSON.stringify(input).length });
      if (JSON.stringify(input).length > contextLimit) throw new Error('Agent turn exceeded its context budget. Previous changes remain on disk.');
    }
    const tools = workspace.tools();
    const limit = ledger.before(config.model, input, tools, config.maxOutputTokens || 4096);
    await emit('model.started', { model: config.model, step: step + 1 });
    modelInFlight = true;
    const tokenEvents = [];
    const result = await cancellable(responseImpl({ config, messages: input, tools, stream, maxOutputTokens: limit,
      onDelta: (delta) => { onDelta?.(delta); if (events) tokenEvents.push(emit('token.delta', { delta })); },
      onCredential: async (change) => {
        modelInFlight = false;
        ledger.add(config.model, undefined);
        await emit('credential.switched', { ...change, accounting: ledger.summary() });
        ledger.before(config.model, input, tools, config.maxOutputTokens || 4096);
        modelInFlight = true;
      }, signal }), signal);
    await Promise.all(tokenEvents);
    ledger.add(result.model || config.model, result.usage);
    modelInFlight = false;
    await emit('model.completed', { model: result.model || config.model, text: result.text, usage: result.usage || null, accounting: ledger.summary() });
    ledger.after();
    const calls = result.toolCalls || [];
    if (!calls.length) {
      const completed = { ...result, steps: step + 1, accounting: ledger.summary(),
        changes: workspace.changes.slice(changeStart), commands: workspace.commands.slice(commandStart), todos: workspace.todos || [] };
      await emit(phase === 'implement' ? 'turn.completed' : 'phase.completed', { text: result.text, steps: completed.steps,
        changes: completed.changes, commands: completed.commands, accounting: completed.accounting, todos: completed.todos });
      return completed;
    }
    if (stream && result.text) { onDelta?.('\n'); await emit('token.delta', { delta: '\n' }); }
    if (step + 1 >= maxSteps) throw new Error(`Agent reached its ${maxSteps}-step limit. Previous changes remain on disk; continue with a new request.`);
    const responses = !config.wireApi || config.wireApi === 'responses';
    if (result.continuation) input.push(...result.continuation);
    else if (responses) {
      if (!Array.isArray(result.raw?.output)) throw new Error('Provider omitted function-call output items. No tools were executed.');
      input.push(...result.raw.output);
    } else input.push({ role: 'assistant', content: result.text || null,
      tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
    for (const call of calls) {
      if (signal?.aborted) throw signal.reason;
      if (++callCount > 100) throw new Error('Agent exceeded 100 tool calls. Previous changes remain on disk.');
      if (usedIds.has(call.id)) throw new Error('Provider repeated a tool-call ID. No repeated action was executed.');
      usedIds.add(call.id);
      let output;
      await emit('tool.started', { callId: call.id, name: call.name, arguments: call.arguments });
      try {
        if (typeof call.arguments !== 'string' || call.arguments.length > 2097152) throw new Error('Tool arguments exceed 2 MiB or are invalid.');
        const args = JSON.parse(call.arguments);
        const value = await cancellable(workspace.execute(call.name, args, { signal }), signal);
        const ok = call.name !== 'run_command' || value.exitCode === 0 && !value.timedOut && !value.cancelled;
        output = { ok, ...value };
      } catch (error) { output = { ok: false, error: error.message }; }
      onTool?.({ name: call.name, ...output });
      await emit('tool.completed', { callId: call.id, name: call.name, result: output });
      if (output.ok && ['created', 'updated', 'directory-created'].includes(output.action)) await emit('file.changed', output);
      const content = JSON.stringify(await boundObservation(output, session));
      input.push(responses ? { type: 'function_call_output', call_id: call.id, output: content }
        : { role: 'tool', tool_call_id: call.id, content });
    }
  }
  throw new Error('Agent stopped without a completed answer.');
  } catch (error) {
    if (modelInFlight) { ledger.add(config.model, undefined); await emit('model.failed', { error: error.message, accounting: ledger.summary() }); }
    error.accounting = ledger.summary();
    await emit(phase === 'implement' ? 'turn.failed' : 'phase.failed', { error: error.message, accounting: error.accounting });
    throw error;
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', cancel); }
}
