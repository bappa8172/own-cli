export { fileDiff } from '../core/diff.js';
export function markdownWriter(write, enabled = true) {
  let buffer = ''; let code = false;
  const line = (text) => {
    if (/^```/.test(text)) { code = !code; return '\x1b[2m' + text + '\x1b[0m'; }
    if (code) return text;
    return text.replace(/^(#{1,6}) (.*)$/, '\x1b[1m$2\x1b[0m')
      .replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[0m').replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[0m');
  };
  return {
    delta(text) {
      if (!enabled) { write(text); return; }
      buffer += text;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) { write(line(buffer.slice(0, boundary)) + '\n'); buffer = buffer.slice(boundary + 1); }
    },
    flush() { if (buffer) write(line(buffer)); buffer = ''; },
  };
}
