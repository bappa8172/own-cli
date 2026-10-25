import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

export const slashCommands = [
  ['/model', 'Browse/search models; /model free shows free-tagged models'],
  ['/auth', 'Manage encrypted API keys and automatic switching'],
  ['/auth add', 'Enter another key privately; optional label'],
  ['/auth status', 'Show key labels and rotation mode'],
  ['/auth use', 'Choose a primary key by label'],
  ['/auth rotate', 'Set failover, round-robin, or off'],
  ['/auth remove', 'Remove a saved key by label'],
  ['/context', 'Inspect context; all, auto, none, refresh'],
  ['/permissions', 'read-only, workspace, ask, all'],
  ['/plan', 'Inspect and plan a task without editing'],
  ['/todos', 'Show task progress'], ['/status', 'Show token/cost usage'],
  ['/session', 'Show this saved session'], ['/sessions', 'List saved sessions'],
  ['/undo', 'Undo the last recorded file-tool turn'], ['/diff', 'Show proposed file diffs'],
  ['/tools', 'Show recent tool results'], ['/config', 'Show settings without keys'],
  ['/clear', 'Clear conversation history'], ['/help', 'Show all commands'], ['/exit', 'Exit chat'],
];
export const safeTerminalText = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
function slashCandidates(line, models = []) {
  if (/^\/models?\s/.test(line)) {
    const query = line.replace(/^\/models?\s+/, '').toLowerCase();
    return [{ value: '/model free', detail: 'Only free-tagged models' }, ...models.map((model) => ({ value: '/model ' + safeTerminalText(model.id), detail: model.pricing }))]
      .filter((entry) => entry.value.slice(7).toLowerCase().includes(query));
  }
  if (!line.startsWith('/')) return [];
  return slashCommands.filter(([value]) => value.startsWith(line) && (line.includes(' ') || !value.includes(' '))).map(([value, detail]) => ({ value, detail }));
}
export function slashSuggestions(line, models = []) {
  return slashCandidates(line, models).slice(0, 6);
}
export function slashCompletions(line, models = []) {
  const values = slashCandidates(line, models).filter((entry) => entry.value.startsWith(line)).map((entry) => entry.value);
  return [values, line];
}

export function createChatInput({ input = process.stdin, output = process.stdout, getModels = () => [] } = {}) {
  const terminal = Boolean(input.isTTY && output.isTTY);
  let muted = false; let active = false; let previewVisible = false; let closed = false; let queued = false;
  const closeController = new AbortController();
  const sink = new Writable({ write(chunk, encoding, done) { if (!muted) output.write(chunk, encoding); done(); } });
  sink.isTTY = terminal;
  Object.defineProperty(sink, 'columns', { get: () => output.columns || 80 });
  const rl = readline.createInterface({ input, output: sink, terminal,
    completer: (line) => slashCompletions(line, getModels()), historySize: 100, removeHistoryDuplicates: true });
  const lines = terminal ? null : rl[Symbol.asyncIterator]();
  const clearPreview = () => {
    if (previewVisible) { output.write('\x1b7\x1b[1E\x1b[J\x1b8'); previewVisible = false; }
  };
  const draw = () => {
    queued = false;
    if (!terminal || !active || muted || closed) return;
    const matches = slashSuggestions(rl.line, getModels());
    if (!matches.length || rl.line.length + 8 >= (output.columns || 80)) { clearPreview(); return; }
    const width = Math.max(10, (output.columns || 80) - 2);
    const rows = matches.map((entry) => `  ${entry.value}  ${entry.detail}`.slice(0, width));
    output.write('\x1b7\x1b[1E\x1b[J\x1b[2m' + rows.join('\r\n') + '\x1b[0m\x1b8');
    previewVisible = true;
  };
  const keypress = () => { if (!queued) { queued = true; setImmediate(draw); } };
  const resize = () => { if (active) { clearPreview(); draw(); } };
  if (terminal) { input.on('keypress', keypress); output.on('resize', resize); }
  rl.on('line', () => { if (previewVisible) { output.write('\x1b[J'); previewVisible = false; } });
  rl.on('history', (history) => { if (muted) history.length = 0; else for (let i = history.length - 1; i >= 0; i--) if (/^\/auth(?:\s|$)/.test(history[i])) history.splice(i, 1); });
  rl.on('close', () => { closed = true; closeController.abort(); });
  return {
    rl, terminal,
    async readLine(prompt = 'you> ', { signal, secret = false } = {}) {
      if (secret && !terminal) throw new Error('API keys must be entered in an interactive terminal. For scripts use auth add --stdin-key.');
      if (!terminal) { const line = await lines.next(); return line.done ? null : line.value; }
      if (closed) return null;
      clearPreview(); active = true;
      const history = secret ? [...rl.history] : null;
      if (secret) { output.write(prompt); muted = true; }
      try { return await rl.question(secret ? '' : prompt, { signal: signal ? AbortSignal.any([signal, closeController.signal]) : closeController.signal }); }
      catch (error) { if (closed || error.code === 'ERR_USE_AFTER_CLOSE') return null; throw error; }
      finally {
        active = false; clearPreview();
        if (secret) { muted = false; rl.history = history; output.write('\n'); }
      }
    },
    close() { active = false; clearPreview(); input.removeListener('keypress', keypress); output.removeListener('resize', resize); rl.close(); sink.end(); },
  };
}
