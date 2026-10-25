import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../workspace.js';
import { createEventStream } from './events.js';
import { openSession } from '../session/store.js';
import { createKnowledge } from '../memory/knowledge.js';
import { extendWorkspace } from '../tools/extensions.js';
import { connectMcpServers } from '../mcp/client.js';
import { createSandbox } from '../sandbox/index.js';
import { UsageLedger } from './accounting.js';
import { runAgent } from '../agent.js';
import { workspacePrompt } from '../prompt.js';
import { createProjectWorktree } from '../runtime/worktrees.js';
import { fileDiff } from './diff.js';
import { credentialSecrets, credentialPool } from '../providers/credentials.js';

export async function createRuntime({ config = {}, options, approve, onEvent, responseImpl } = {}) {
  const root = await fs.realpath(options.root);
  const env = options.env || process.env;
  const sandbox = await createSandbox({ mode: options.sandbox || 'off', root });
  let policy = [];
  if (options.policy) {
    const data = JSON.parse(await fs.readFile(options.policy, 'utf8'));
    policy = Array.isArray(data) ? data : data.rules;
    if (!Array.isArray(policy)) throw new Error('Permission policy must contain a rules array.');
  }
  let prices = {};
  if (options.prices) {
    prices = JSON.parse(await fs.readFile(options.prices, 'utf8'));
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) throw new Error('Prices must be a model-ID object with per-million input/output rates.');
    for (const price of Object.values(prices)) if (!price || !['input', 'output', ...(price.cached === undefined ? [] : ['cached'])].every((key) => typeof price[key] === 'number' && Number.isFinite(price[key]) && price[key] >= 0)) throw new Error('Invalid model price.');
  }
  const session = options.noSession ? null : await openSession({ root, id: options.resume, env });
  let mcp;
  try {
    credentialPool(config);
    const events = createEventStream({ session, secrets: () => credentialSecrets(config), listeners: onEvent ? [onEvent] : [] });
    const knowledge = await createKnowledge(root, env);
    let workspace;
    const approval = async (action) => { const { signal, ...preview } = action; await events.emit('approval.needed', { turnId: workspace.turnId, ...preview }); return approve ? approve(action) : 'deny'; };
    workspace = await createWorkspace({ root, permissions: options.permissions, policy, approve: approval, sandbox,
      onCheckpoint: (change) => events.emit('file.checkpoint', { turnId: workspace.turnId, ...change }),
      onPreview: (preview) => events.emit('file.diff', { turnId: workspace.turnId, ...preview }) });
    mcp = await connectMcpServers(options.mcp, { env, cwd: root });
    let delegateCount = 0;
    const delegate = async ({ role, task }, { signal } = {}) => {
      if (!['explore', 'plan', 'review', 'implement'].includes(role) || typeof task !== 'string' || !task.trim()) throw new Error('Delegate needs an Explore, Plan, Implement or Review role and a task.');
      if (++delegateCount > 3) throw new Error('At most three isolated child agents are allowed per parent turn.');
      const checkout = role === 'implement' ? await createProjectWorktree(root, { env }) : null;
      const childRoot = checkout?.root || root;
      const childSession = options.noSession ? null : await openSession({ root: childRoot, env });
      const childEvents = createEventStream({ session: childSession, secrets: () => credentialSecrets(config), listeners: [(event) => events.emit('subagent.event', { role, event })] });
      let child;
      try {
      child = await createWorkspace({ root: childRoot, permissions: role === 'implement' ? workspace.permissions : 'read-only', policy,
        approve: (action) => approval({ ...action, preview: `Child project root: ${childRoot}\n${action.preview}` }),
        sandbox: await createSandbox({ mode: options.sandbox || 'off', root: childRoot }),
        onCheckpoint: (change) => childEvents.emit('file.checkpoint', { turnId: child.turnId, ...change }) });
      const model = role === 'implement' ? config.model : options.lookupModel || config.model;
      await events.emit('subagent.started', { role, model, task, sessionId: childSession?.id || null, worktree: checkout });
      const result = await runAgent({ config: { ...config, model }, workspace: child, maxSteps: Math.min(options.maxSteps || 20, 8),
        messages: [{ role: 'system', content: workspacePrompt(child) + `\nYou are an isolated ${role} subagent. Return a concise evidence-backed summary with paths; do not return your transcript.`
          + (checkout ? '\nThis worktree starts from committed HEAD and does not contain uncommitted parent edits. Implement only the assigned task. Your changes remain in this isolated checkout for parent review.' : '\nAll project inspection is read-only.') }, { role: 'user', content: task }],
        stream: false, signal, events: childEvents, ledger: activeLedger, maxMs: Math.max(1, deadline - Date.now()), responseImpl });
      await events.emit('subagent.completed', { role, summary: result.text.slice(0, 8000), accounting: result.accounting });
      const implementation = [];
      const finalFiles = new Map(result.changes.filter((item) => ['created', 'updated'].includes(item.action)).map((item) => [item.path, item]));
      if (checkout) for (const change of [...finalFiles.values()].slice(-50)) {
        const file = await child.execute('read_file', { path: change.path, max_chars: 200000 });
        implementation.push({ path: change.path, content: file.content, truncated: file.truncated,
          diff: change.action === 'created' ? fileDiff(change.path, '', file.content) : undefined });
      }
      return { role, summary: result.text.slice(0, 8000), truncated: result.text.length > 8000,
        ...(checkout ? { worktree: checkout, sessionId: childSession?.id || null, changes: result.changes, files: implementation, filesTruncated: finalFiles.size > 50,
          note: 'These edits are isolated. Review artifacts and apply desired changes in the parent with its file tools; no automatic merge was performed.' } : {}) };
      } finally { await childSession?.close(); }
    };
    extendWorkspace(workspace, { session, knowledge, policy, approve: approval, mcp,
      delegate: options.subagents ? delegate : undefined, allowHosts: options.allowHosts || [] });
    workspace.todos = session?.events.findLast((event) => event.type === 'tool.completed' && event.data.name === 'todo' && event.data.result?.ok)?.data.result.items
      || session?.events.findLast((event) => event.type === 'turn.completed')?.data.todos || [];
    let activeLedger; let deadline;
    let running = false;
    let savedPlan = session?.events.findLast((event) => event.type === 'plan.saved')?.data.text || '';
    const runtime = {
      workspace, session, events, knowledge,
      resumeState: (() => {
        if (!options.resume || !session) return 'new';
        const request = session.events.findLast((event) => event.type === 'request.received');
        if (request) return session.events.some((event) => event.type === 'turn.completed' && event.data.turnId === request.data.requestId) ? 'completed'
          : session.events.some((event) => event.type === 'request.failed' && event.data.requestId === request.data.requestId) ? 'failed' : 'interrupted';
        const last = session.events.findLast((event) => event.type === 'turn.started');
        if (!last) return 'empty';
        return session.events.some((event) => event.type === 'turn.completed' && event.data.turnId === last.data.turnId) ? 'completed'
          : session.events.some((event) => event.type === 'turn.failed' && event.data.turnId === last.data.turnId) ? 'failed' : 'interrupted';
      })(),
      get history() { return session?.history() || []; },
      async run({ messages, stream = true, onDelta, onTool, signal, planOnly = options.plan, planFirst = options.planFirst } = {}) {
        if (running) throw new Error('This runtime already has an active turn. Use a separate session/worktree for parallel work.');
        running = true;
        const requestId = randomUUID();
        try {
        activeLedger = new UsageLedger({ maxTokens: options.maxTokens, maxCost: options.maxCost, prices });
        deadline = Date.now() + (options.maxMs || 600000); delegateCount = 0;
        const user = messages.findLast((message) => message.role === 'user')?.content || '';
        await events.emit('request.received', { requestId, content: user, planOnly: Boolean(planOnly), planFirst: Boolean(planFirst) });
        const rules = await knowledge.rules();
        const memory = await knowledge.search(user);
        const queryWords = new Set(user.toLowerCase().match(/[a-z0-9_-]+/g) || []);
        const skills = (await knowledge.skills()).map((skill) => ({ ...skill, score: `${skill.name} ${skill.description}`.toLowerCase().split(/\W+/).filter((word) => queryWords.has(word)).length }))
          .filter((skill) => skill.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
        const assembled = messages.map((item) => ({ ...item }));
        const ruleText = '\nProject rules (follow when consistent with the user and active permissions):\n' + rules.map((rule) => `${rule.file}:\n${rule.text}`).join('\n\n');
        if (assembled[0]?.role === 'system') assembled[0].content += ruleText;
        if (memory.length) assembled.splice(assembled.length - 1, 0, { role: 'user', content: 'Relevant saved project memory (reference):\n' + memory.map((item) => `${item.kind}: ${item.text}`).join('\n') });
        if (skills.length) assembled.splice(assembled.length - 1, 0, { role: 'user', content: 'Relevant available skills; use project_knowledge load_skill to read the instructions on demand:\n'
          + skills.map((skill) => `${skill.id}: ${skill.name} — ${skill.description}`).join('\n') });
        if (planFirst && !planOnly) {
          const previous = workspace.permissions; workspace.permissions = 'read-only';
          try {
            const plan = await runAgent({ config: { ...config, model: options.plannerModel || config.model }, messages: [...assembled,
              { role: 'user', content: 'Plan the preceding task using read-only inspection. Return concrete steps, affected files and verification. Do not edit anything.' }],
              workspace, maxSteps: Math.min(options.maxSteps || 20, 8), stream: false, signal, events, session,
              ledger: activeLedger, maxMs: Math.max(1, deadline - Date.now()), phase: 'plan', turnId: requestId, responseImpl });
            savedPlan = plan.text;
            await events.emit('plan.saved', { text: savedPlan });
          } finally { workspace.permissions = previous; }
        }
        if (savedPlan && !assembled.some((message) => message.role === 'assistant' && message.content === savedPlan)) assembled.splice(assembled.length - 1, 0, { role: 'user', content: 'Current plan:\n' + savedPlan });
        if (workspace.todos.length) assembled.splice(assembled.length - 1, 0, { role: 'user', content: 'Current todo state:\n' + JSON.stringify(workspace.todos) });
        const previous = workspace.permissions;
        if (planOnly) {
          workspace.permissions = 'read-only';
          assembled[0].content = workspacePrompt(workspace) + ruleText + '\nThis turn is planning only. Inspect files and return a plan; do not modify project files or run commands.';
        }
        try {
          const result = await runAgent({ config, messages: assembled, workspace, maxSteps: options.maxSteps || 20, stream, onDelta, onTool, signal,
            events, session, ledger: activeLedger, maxMs: Math.max(1, deadline - Date.now()), turnId: requestId, responseImpl });
          if (planOnly) { savedPlan = result.text; await events.emit('plan.saved', { text: savedPlan }); }
          return { ...result, sessionId: session?.id || null, sandbox: sandbox.mode };
        } finally { workspace.permissions = previous; }
        } catch (error) {
          error.accounting ||= activeLedger?.summary();
          await events.emit('request.failed', { requestId, error: error.message, accounting: error.accounting });
          throw error;
        } finally { running = false; }
      },
      async undo() {
        if (running) throw new Error('Wait for or cancel the active turn before undo.');
        if (!session) throw new Error('Undo requires session recording.');
        if (workspace.permissions === 'read-only') throw new Error('Undo requires workspace editing permissions.');
        const undone = new Set(session.events.filter((event) => event.type === 'turn.undone').map((event) => event.data.targetTurn));
        const last = session.events.findLast((event) => ['file.changed', 'file.checkpoint'].includes(event.type) && !undone.has(event.data.turnId));
        if (!last) return { restored: [], message: 'No recorded file changes to undo.' };
        const targetTurn = last.data.turnId;
        const checkpoints = session.events.filter((event) => event.type === 'file.checkpoint' && event.data.turnId === targetTurn).map((event) => event.data);
        const directories = session.events.filter((event) => event.type === 'file.changed' && event.data.turnId === targetTurn && event.data.action === 'directory-created').map((event) => event.data);
        const combined = [...checkpoints, ...directories].sort((a, b) => {
          const at = session.events.findIndex((event) => event.data === a); const bt = session.events.findIndex((event) => event.data === b); return at - bt;
        });
        const result = await workspace.undo(combined);
        await events.emit('turn.undone', { targetTurn, ...result });
        return result;
      },
      async close() { try { await mcp?.close(); } finally { await session?.close(); } },
    };
    return runtime;
  } catch (error) { try { await mcp?.close(); } finally { await session?.close(); } throw error; }
}
