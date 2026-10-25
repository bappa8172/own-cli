// Extractive compaction preserves recent turns verbatim and labels older excerpts honestly.
export function compactHistory(messages, { maxChars = 48000, recentTurns = 4 } = {}) {
  let recent = messages.slice(-recentTurns * 2);
  while (recent[0]?.role === 'assistant') recent.shift();
  const removed = messages.slice(0, messages.length - recent.length);
  const excerpts = removed.map((message) => `${message.role}: ${String(message.content || '').slice(0, 400)}`).join('\n');
  let summary = excerpts ? `Earlier conversation excerpts (not a complete transcript):\n${excerpts.slice(-Math.floor(maxChars * 0.25))}` : '';
  while (recent.length > 2 && summary.length + JSON.stringify(recent).length > maxChars) recent.splice(0, 2);
  if (summary.length + JSON.stringify(recent).length > maxChars) summary = '';
  if (JSON.stringify(recent).length > maxChars) throw new Error('Latest conversation turn exceeds the context budget.');
  return { summary, recent, compacted: removed.length };
}

export async function boundObservation(output, session, maxChars = 24000) {
  const text = JSON.stringify(output);
  if (text.length <= maxChars) return output;
  const pointer = session ? await session.artifact(text) : {};
  return { ok: output.ok, ...pointer, excerpt: text.slice(0, maxChars), truncated: true,
    note: session ? 'Full result is available through read_artifact.' : 'Full result exceeded the per-observation limit.' };
}
