import { createPermissionEngine } from '../permissions/engine.js';
import { validateArguments } from './schema.js';
const s = { type: 'string' };
function tool(name, description, properties, required = []) { return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }; }
export function extendWorkspace(workspace, { session, knowledge, policy, approve, mcp, delegate, allowHosts = [] } = {}) {
  const originalTools = workspace.tools.bind(workspace); const execute = workspace.execute.bind(workspace);
  const engine = createPermissionEngine({ rules: policy || [], approve });
  workspace.todos = [];
  const extensions = [
    tool('todo', 'Maintain task steps. Supply items to replace the plan, or omit items to inspect it.',
      { items: { type: 'array', items: { type: 'object', properties: { text: s, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['text', 'status'], additionalProperties: false } } }),
    tool('glob', 'Find project paths using * and ** wildcard patterns.', { pattern: s }, ['pattern']),
    tool('project_knowledge', 'Search/remember/forget project memory, read rules, list skills, or load a skill on demand.',
      { action: { type: 'string', enum: ['search', 'remember', 'forget', 'rules', 'skills', 'load_skill'] }, text: s, id: s, kind: s }, ['action']),
    ...(session ? [tool('read_artifact', 'Read a large prior tool result by its artifact ID.', { id: s, offset: { type: 'integer', minimum: 0 } }, ['id'])] : []),
    ...(allowHosts.length ? [tool('web_fetch', 'Fetch text from explicitly allowed HTTP(S) hosts. No redirects; no browser execution.', { url: s }, ['url'])] : []),
    ...(delegate ? [tool('delegate', 'Run an isolated Explore/Plan/Review child (read-only), or Implement child in a fresh Git worktree. Returns a summary and implementation artifacts, never a transcript. Child edits are not applied to the parent checkout.',
      { role: { type: 'string', enum: ['explore', 'plan', 'review', 'implement'] }, task: s }, ['role', 'task'])] : []),
  ];
  const readonly = (name, args) => !['remember', 'forget'].includes(args.action) && !(name === 'delegate' && args.role === 'implement');
  workspace.tools = () => [...originalTools(), ...extensions, ...(mcp?.tools || []).filter((entry) => workspace.permissions !== 'read-only' || entry.readOnly)]
    .map(({ readOnly, ...entry }) => entry);
  workspace.execute = async (name, args, options = {}) => {
    const definition = extensions.find((entry) => entry.name === name) || mcp?.tools.find((entry) => entry.name === name);
    if (!definition) return execute(name, args, options);
    validateArguments(definition.parameters, args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    for (const key of definition.parameters.required || []) if (args[key] === undefined) throw new Error(`Missing tool argument: ${key}`);
    if (extensions.includes(definition)) for (const key of Object.keys(args)) {
      const type = definition.parameters.properties[key]?.type;
      if (!type || (type === 'array' ? !Array.isArray(args[key]) : type === 'integer' ? !Number.isSafeInteger(args[key]) : typeof args[key] !== type)) throw new Error(`Invalid argument: ${key}`);
    }
    if (options.signal?.aborted) throw new Error('Operation cancelled.');
    await engine.check({ mode: workspace.permissions, name, args, signal: options.signal, readOnly: extensions.includes(definition) ? readonly(name, args) : definition.readOnly,
      preview: JSON.stringify(args, null, 2) });
    if (options.signal?.aborted) throw new Error('Operation cancelled.');
    if (name === 'todo') {
      if (args.items) {
        if (args.items.length > 100 || args.items.some((item) => !item || typeof item.text !== 'string' || item.text.length > 1000
          || !['pending', 'in_progress', 'completed'].includes(item.status))) throw new Error('Invalid todo items.');
        workspace.todos = args.items;
      }
      return { items: workspace.todos };
    }
    if (name === 'glob') {
      if (args.pattern.length > 1000) throw new Error('Glob pattern is too long.');
      const escaped = args.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
      const regex = new RegExp('^' + escaped + '$');
      const listing = await execute('list_directory', { recursive: true }, options);
      return { matches: listing.entries.filter((item) => regex.test(item.path)), truncated: listing.truncated };
    }
    if (name === 'project_knowledge') {
      if (args.action === 'rules') return { rules: await knowledge.rules() };
      if (args.action === 'skills') return { skills: (await knowledge.skills()).map(({ file, ...skill }) => skill) };
      if (args.action === 'load_skill') return knowledge.loadSkill(args.id);
      if (args.action === 'remember') return knowledge.remember(args.text, args.kind);
      if (args.action === 'forget') return knowledge.forget(args.id);
      if (args.action === 'search') return { matches: await knowledge.search(args.text || '') };
      throw new Error('Unknown knowledge action.');
    }
    if (name === 'read_artifact') {
      if ((args.offset ?? 0) < 0) throw new Error('Artifact offset cannot be negative.');
      return session.readArtifact(args.id, args.offset || 0);
    }
    if (name === 'web_fetch') {
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowHosts.includes(url.host)) throw new Error('URL host is not in --allow-host.');
      const response = await fetch(url, { redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
      if (!/text\/|application\/(json|xml)/i.test(response.headers.get('content-type') || '')) throw new Error('URL did not return a text content type.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let truncated = false;
      try { while (true) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); if (text.length > 100000) { truncated = true; break; } } }
      finally { await reader.cancel(); }
      return { url: url.href, text: text.slice(0, 100000), truncated };
    }
    if (name === 'delegate') return delegate(args, options);
    return mcp.call(name, args, options);
  };
  return workspace;
}
