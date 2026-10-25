import { createHash } from 'node:crypto';
import { abortable } from '../core/async.js';

export function permissionMode(value) {
  return ({ 'auto-edit': 'workspace', yolo: 'all', readonly: 'read-only', ask: 'ask' })[value] || value;
}
export function createPermissionEngine({ rules = [], approve } = {}) {
  const sessionAllows = new Set();
  for (const rule of rules) {
    if (!['allow', 'deny', 'ask'].includes(rule.action) || typeof rule.tool !== 'string') throw new Error('Invalid permission rule.');
    if (rule.commandRegex) new RegExp(rule.commandRegex);
    if (rule.pathRegex) new RegExp(rule.pathRegex);
  }
  return {
    async check({ mode, name, args, preview, readOnly = false, signal }) {
      if (signal?.aborted) throw new Error('Operation cancelled.');
      mode = permissionMode(mode);
      if (mode === 'read-only' && !readOnly) throw new Error(`Read-only permissions deny ${name}.`);
      if (name === 'run_command' && !['all', 'ask'].includes(mode)) throw new Error('Command execution requires all or ask permissions.');
      let action = mode === 'ask' && !readOnly ? 'ask' : 'allow';
      const command = JSON.stringify([args.command, ...(args.args || [])]);
      for (const rule of rules) if ((rule.tool === '*' || rule.tool === name)
        && (!rule.commandRegex || new RegExp(rule.commandRegex).test(command))
        && (!rule.pathRegex || new RegExp(rule.pathRegex).test(args.path || args.cwd || '.'))) {
        action = rule.action;
        if (action === 'deny') break;
      }
      if (action === 'deny') throw new Error(`Permission policy denied ${name}.`);
      const key = name + ':' + (name === 'run_command'
        ? createHash('sha256').update(JSON.stringify(args)).digest('hex') : args.path || name);
      if (action === 'ask' && !sessionAllows.has(key)) {
        if (!approve) throw new Error(`Approval required for ${name}; no interactive approval handler is available.`);
        const approval = approve({ name, args, preview, signal });
        const answer = signal ? await abortable(approval, signal) : await approval;
        if (!['once', 'session'].includes(answer)) throw new Error(`User denied ${name}.`);
        if (answer === 'session') sessionAllows.add(key);
      }
    },
  };
}
