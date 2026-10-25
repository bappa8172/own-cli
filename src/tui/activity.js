import { safeTerminalText } from './input.js';

export function createActivity({ output = process.stderr, enabled = output.isTTY, intervalMs = 100 } = {}) {
  let timer; let started; let label = ''; let frame = 0;
  const frames = ['|', '/', '-', '\\'];
  const paint = () => {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const text = `${frames[frame++ % frames.length]} ${safeTerminalText(label)} · ${seconds}s · Ctrl+C cancels`;
    output.write('\r\x1b[2K\x1b[2m' + text.slice(0, Math.max(10, (output.columns || 100) - 1)) + '\x1b[0m');
  };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; output.write('\r\x1b[2K'); } };
  const start = (text) => {
    if (!enabled) return;
    stop(); label = text; started = Date.now(); paint(); timer = setInterval(paint, intervalMs); timer.unref?.();
  };
  return { start, stop,
    event(event) {
      if (event.type === 'model.started') start(`Thinking / processing · ${event.data.model} · round ${event.data.step}`);
      else if (event.type === 'tool.started') start(`Running ${event.data.name}`);
      else if (['token.delta', 'model.completed', 'tool.completed', 'approval.needed', 'credential.switched', 'turn.completed', 'turn.failed', 'request.failed', 'plan.saved'].includes(event.type)) stop();
    },
  };
}
