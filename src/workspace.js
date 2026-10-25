import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isSensitiveName, isHiddenSourceDirectory } from './context.js';
import { digest } from './session/store.js';
import { createPermissionEngine } from './permissions/engine.js';
import { fileDiff } from './core/diff.js';
import { validateArguments } from './tools/schema.js';

const string = { type: 'string' };
const integer = { type: 'integer', minimum: 1 };
const definitions = [
  ['list_directory', 'List files and folders inside the project. Use recursive=true to discover the project tree.',
    { path: string, recursive: { type: 'boolean' } }, []],
  ['read_file', 'Read current UTF-8 file contents. offset is a byte offset; follow nextOffset for remaining content.',
    { path: string, offset: { type: 'integer', minimum: 0 }, max_chars: integer }, ['path']],
  ['search_files', 'Find literal text in project text files; returns matching paths, line numbers and excerpts.',
    { query: string, path: string, max_results: integer }, ['query']],
  ['make_directory', 'Create a project directory, including missing parent folders.', { path: string }, ['path']],
  ['write_file', 'Create a UTF-8 project file and its parent folders. To replace an existing file, set overwrite=true; existing content is backed up.',
    { path: string, content: string, overwrite: { type: 'boolean' } }, ['path', 'content']],
  ['edit_file', 'Replace one exact, unique old_text occurrence in an existing file. Read the file first. Existing content is backed up.',
    { path: string, old_text: string, new_text: string }, ['path', 'old_text', 'new_text']],
  ['run_command', 'Run an executable with separate arguments in a project directory, for tests/builds. No implicit shell. Commands require all permissions.',
    { command: string, args: { type: 'array', items: string }, cwd: string, timeout_ms: integer }, ['command', 'args']],
].map(([name, description, properties, required]) => ({ name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } }));

const writeTools = new Set(['make_directory', 'write_file', 'edit_file']);
const protectedNames = new Set(['.git', '.codex', '.own-codex', '.own-cli', '.own-cli-backups', '.ssh', '.aws', '.azure', '.gnupg']);
const skippedDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', '__pycache__']);
function ordinaryPath(value) {
  if (process.platform !== 'win32' || !value.startsWith('\\\\?\\')) return value;
  return value.startsWith('\\\\?\\UNC\\') ? '\\\\' + value.slice(8) : value.slice(4);
}
function within(root, target) {
  const relative = path.relative(ordinaryPath(root), ordinaryPath(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
const display = (root, target) => path.relative(ordinaryPath(root), ordinaryPath(target)).split(path.sep).join('/') || '.';
function checkAbort(signal) { if (signal?.aborted) throw new Error('Operation cancelled.'); }
function number(value, fallback, max, name, min = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export async function createWorkspace({ root = process.cwd(), permissions = 'workspace', policy, approve, onCheckpoint, onPreview, sandbox } = {}) {
  const projectRoot = await fs.realpath(path.resolve(root));
  if (!(await fs.stat(projectRoot)).isDirectory()) throw new Error('Workspace root must be a directory.');
  const session = randomUUID();
  let backupNumber = 0;
  const workspace = { root: projectRoot, permissions, changes: [], commands: [] };
  const permissionEngine = createPermissionEngine({ rules: policy || [], approve });

  async function resolve(target = '.') {
    if (typeof target !== 'string' || !target.trim() || target.includes('\0')) throw new Error('A non-empty project path is required.');
    const absolute = path.resolve(projectRoot, target);
    if (!within(projectRoot, absolute)) throw new Error(`Path is outside the project root: ${target}`);
    const parts = path.relative(projectRoot, absolute).split(path.sep).filter(Boolean);
    if (parts.some((part) => isSensitiveName(part) || protectedNames.has(part.toLowerCase()) || part.includes(':'))) {
      throw new Error(`Protected path cannot be accessed: ${target}`);
    }
    let cursor = projectRoot;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions cannot be followed: ${target}`);
        if (!within(projectRoot, await fs.realpath(cursor))) throw new Error(`Path is outside the project root: ${target}`);
      } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    return absolute;
  }

  async function tree(target, recursive, signal) {
    const queue = [target];
    const entries = [];
    let visited = 0;
    while (queue.length && visited < 10000 && entries.length < 2000) {
      checkAbort(signal);
      const directory = queue.shift();
      const children = await fs.readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (++visited > 10000 || entries.length >= 2000) break;
        if (child.isSymbolicLink() || isSensitiveName(child.name) || protectedNames.has(child.name.toLowerCase())) continue;
        if (child.isDirectory() && (skippedDirectories.has(child.name.toLowerCase()) || child.name.startsWith('.') && !isHiddenSourceDirectory(child.name))) continue;
        const absolute = path.join(directory, child.name);
        if (!child.isDirectory() && !child.isFile()) continue;
        entries.push({ path: display(projectRoot, absolute), type: child.isDirectory() ? 'directory' : 'file' });
        if (recursive && child.isDirectory()) queue.push(absolute);
      }
      if (!recursive) break;
    }
    return { entries, truncated: Boolean(queue.length || visited >= 10000 || entries.length >= 2000) };
  }

  async function read(target, offset, maxChars) {
    const handle = await fs.open(await resolve(target), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('read_file requires a regular file.');
      if (offset > stat.size) throw new Error('offset is past the end of the file.');
      const buffer = Buffer.alloc(Math.min(stat.size - offset, maxChars));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) throw new Error('Binary files cannot be read as text.');
      let content;
      // Decode complete UTF-8 characters and retain a byte cursor for the next call.
      let consumed = bytesRead;
      for (let trim = 0; trim <= 3; trim += 1) {
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead - trim));
          consumed = bytesRead - trim;
          break;
        } catch {
          if (offset + bytesRead === stat.size || trim === 3) throw new Error('File content is not valid UTF-8 text.');
        }
      }
      return { path: display(projectRoot, await resolve(target)), content, sizeBytes: stat.size,
        nextOffset: offset + consumed, truncated: offset + consumed < stat.size };
    } finally { await handle.close(); }
  }

  async function writeText(target, content, overwrite, expected, signal) {
    checkAbort(signal);
    let absolute = await resolve(target);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2097152) throw new Error('File content must be a string no larger than 2 MiB.');
    let original = null;
    let stat;
    try {
      stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error('Target is not a regular file.');
      if (!overwrite) throw new Error('File already exists. Read it first, then use edit_file or set overwrite=true.');
      if (stat.size > 2097152) throw new Error('Existing file exceeds the 2 MiB edit limit.');
      original = await fs.readFile(absolute);
      if (original.includes(0)) throw new Error('Existing binary files cannot be overwritten with text.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (expected !== undefined && (original === null || original.toString('utf8') !== expected)) {
      throw new Error('File changed during editing. Read it again before retrying.');
    }
    checkAbort(signal);
    const createdParent = await fs.mkdir(path.dirname(absolute), { recursive: true });
    const createdDirectories = [];
    if (createdParent) {
      let cursor = ordinaryPath(createdParent); createdDirectories.push(display(projectRoot, cursor));
      for (const part of path.relative(cursor, path.dirname(absolute)).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); createdDirectories.push(display(projectRoot, cursor));
      }
    }
    absolute = await resolve(target);
    let backup = null;
    if (original !== null) {
      backup = path.join(projectRoot, '.own-cli-backups', session, `${display(projectRoot, absolute)}.${++backupNumber}.bak`);
      // The backup root is checked independently because file tools cannot access it.
      const backupRoot = path.join(projectRoot, '.own-cli-backups');
      try { if ((await fs.lstat(backupRoot)).isSymbolicLink()) throw new Error('Backup directory cannot be a link.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.writeFile(backup, original, { flag: 'wx', mode: 0o600 });
    }
    const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
    const checkpoint = { path: display(projectRoot, absolute), action: original === null ? 'created' : 'updated',
      beforeHash: original === null ? null : digest(original), afterHash: digest(content),
      mode: stat ? stat.mode & 0o777 : 0o644, backup: backup ? display(projectRoot, backup) : null, createdDirectories };
    await onCheckpoint?.(checkpoint);
    try {
      checkAbort(signal);
      await fs.writeFile(temporary, content, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o644 });
      await resolve(target);
      checkAbort(signal);
      if (original === null) {
        // Exclusive creation avoids replacing a file that appeared after the first check.
        await fs.copyFile(temporary, absolute, 1);
      } else {
        if (!(await fs.readFile(absolute)).equals(original)) throw new Error('File changed during editing. Read it again before retrying.');
        await fs.rename(temporary, absolute);
      }
    } finally { await fs.rm(temporary, { force: true }); }
    const change = { ...checkpoint, bytes: Buffer.byteLength(content) };
    workspace.changes.push(change);
    return change;
  }

  async function run(args, signal) {
    const cwd = await resolve(args.cwd || '.');
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Command cwd must be a directory.');
    const timeout = number(args.timeout_ms, 60000, 300000, 'timeout_ms');
    let executable = args.command;
    let argv = [...args.args];
    if (executable === 'node') executable = process.execPath;
    if (process.platform === 'win32' && ['npm', 'npx'].includes(args.command)) {
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${args.command}-cli.js`);
      await fs.access(npmCli);
      executable = process.execPath; argv = [npmCli, ...argv];
    }
    if (sandbox) ({ executable, args: argv } = await sandbox.prepare({ executable, args: argv, cwd }));
    checkAbort(signal);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) && !/^OWN_CODEX_/i.test(key)));
    return new Promise((resolveRun, reject) => {
      const child = spawn(executable, argv, { cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let truncated = false; let timedOut = false; let cancelled = false;
      const terminate = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
      };
      const cancel = () => { cancelled = true; terminate(); };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const capture = (kind, chunk) => {
        const value = chunk.toString();
        const room = Math.max(0, 24000 - stdout.length - stderr.length);
        if (value.length > room) truncated = true;
        if (kind === 'stdout') stdout += value.slice(0, room); else stderr += value.slice(0, room);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => capture('stdout', chunk));
      child.stderr.on('data', (chunk) => capture('stderr', chunk));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      child.on('error', (error) => { cleanup(); reject(new Error(`Could not run ${args.command}: ${error.code || error.message}`)); });
      child.on('close', (exitCode, exitSignal) => {
        cleanup();
        const result = { command: args.command, args: args.args, cwd: display(projectRoot, cwd), exitCode,
          signal: exitSignal, stdout, stderr, truncated, timedOut, cancelled };
        workspace.commands.push(result);
        resolveRun(result);
      });
    });
  }

  workspace.tools = () => definitions.filter((tool) =>
    tool.name === 'run_command' ? ['all', 'ask'].includes(workspace.permissions) : !writeTools.has(tool.name) || workspace.permissions !== 'read-only');
  workspace.preview = async (name, args) => {
    if (['write_file', 'edit_file'].includes(name)) {
      const target = await resolve(args.path);
      let before = '';
      try { if ((await fs.stat(target)).size > 2097152) throw new Error('File exceeds the 2 MiB edit limit.'); before = await fs.readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const after = name === 'write_file' ? args.content : before.replace(args.old_text, () => args.new_text);
      return fileDiff(display(projectRoot, target), before, after);
    }
    return name === 'run_command' ? `cwd: ${await resolve(args.cwd || '.')}\nexecutable: ${JSON.stringify(args.command)}\narguments: ${JSON.stringify(args.args)}`
      : JSON.stringify(args, null, 2);
  };
  workspace.undo = async (changes) => {
    const reverse = [...changes].reverse().filter((change) => ['created', 'updated', 'directory-created'].includes(change.action));
    const state = new Map(); const prepared = [];
    for (const change of reverse) {
      const target = await resolve(change.path);
      if (target === projectRoot) throw new Error('Undo cannot remove the project root.');
      if (change.action === 'directory-created') { prepared.push({ change, target }); continue; }
      if (!change.afterHash) throw new Error('This change predates verified undo support. Restore its backup manually.');
      let current = state.get(target);
      if (current === undefined) { try { current = digest(await fs.readFile(target)); } catch (error) { if (error.code !== 'ENOENT') throw error; current = null; } }
      if (current === change.beforeHash) continue; // A pre-write checkpoint may not have reached the mutation.
      if (current !== change.afterHash) throw new Error(`Undo conflict: ${change.path} changed after the agent edit. Nothing was restored.`);
      let original;
      if (change.action === 'updated') {
        const backup = path.resolve(projectRoot, change.backup || '');
        if (!within(path.join(projectRoot, '.own-cli-backups'), backup)) throw new Error('Invalid checkpoint backup path.');
        // Reject links in every backup component before reading it.
        let cursor = projectRoot;
        for (const part of path.relative(projectRoot, backup).split(path.sep)) {
          cursor = path.join(cursor, part);
          if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Checkpoint backup cannot be a link.');
        }
        original = await fs.readFile(backup);
        if (digest(original) !== change.beforeHash) throw new Error('Checkpoint backup hash does not match.');
      }
      state.set(target, change.beforeHash);
      prepared.push({ change, target, original });
    }
    const restored = [];
    const createdDirectories = new Set(prepared.flatMap(({ change }) => change.createdDirectories || []));
    for (const directory of createdDirectories) if (await resolve(directory) === projectRoot) throw new Error('Undo cannot remove the project root.');
    for (const { change, target, original } of prepared) {
      await resolve(change.path);
      if (change.action === 'directory-created') {
        try { await fs.rmdir(target); restored.push(change.path); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
      } else if (change.action === 'created') { await fs.unlink(target); restored.push(change.path); }
      else {
        const temp = target + '.' + randomUUID() + '.undo';
        try { await fs.writeFile(temp, original, { flag: 'wx', mode: change.mode || 0o644 }); await fs.rename(temp, target); }
        finally { await fs.rm(temp, { force: true }); }
        restored.push(change.path);
      }
    }
    for (const directory of [...createdDirectories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      try { await fs.rmdir(await resolve(directory)); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
    }
    return { restored };
  };
  workspace.execute = async (name, args, { signal } = {}) => {
    checkAbort(signal);
    const definition = workspace.tools().find((tool) => tool.name === name);
    if (!definition) throw new Error(`Tool is unavailable with ${workspace.permissions} permissions: ${name}`);
    validateArguments(definition.parameters, args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
    for (const key of Object.keys(args)) if (!Object.hasOwn(definition.parameters.properties, key)) throw new Error(`Unknown argument: ${key}`);
    for (const key of definition.parameters.required) if (args[key] === undefined) throw new Error(`Missing argument: ${key}`);
    for (const [key, value] of Object.entries(args)) {
      const type = definition.parameters.properties[key].type;
      if (type === 'array' ? !Array.isArray(value) || value.some((part) => typeof part !== 'string')
        : type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== type) throw new Error(`Invalid type for ${key}.`);
    }
    const preview = await workspace.preview(name, args);
    if (['write_file', 'edit_file'].includes(name)) await onPreview?.({ path: args.path, diff: preview });
    const policyArgs = { ...args, ...(args.path ? { path: display(projectRoot, await resolve(args.path)) } : {}), ...(args.cwd ? { cwd: display(projectRoot, await resolve(args.cwd)) } : {}) };
    await permissionEngine.check({ mode: workspace.permissions, name, args: policyArgs, signal,
      readOnly: ['read_file', 'list_directory', 'search_files'].includes(name), preview });
    checkAbort(signal);
    if (name === 'list_directory') return tree(await resolve(args.path || '.'), args.recursive || false, signal);
    if (name === 'read_file') return read(args.path, number(args.offset, 0, Number.MAX_SAFE_INTEGER, 'offset', 0), number(args.max_chars, 24000, 200000, 'max_chars', 4));
    if (name === 'make_directory') {
      const target = await resolve(args.path);
      const created = await fs.mkdir(target, { recursive: true });
      const createdDirectories = [];
      if (created) {
        let cursor = ordinaryPath(created); createdDirectories.push(display(projectRoot, cursor));
        for (const part of path.relative(cursor, target).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); createdDirectories.push(display(projectRoot, cursor)); }
      }
      const change = { path: display(projectRoot, target), action: created ? 'directory-created' : 'directory-exists', createdDirectories };
      if (created) workspace.changes.push(change);
      return change;
    }
    if (name === 'write_file') return writeText(args.path, args.content, args.overwrite || false, undefined, signal);
    if (name === 'edit_file') {
      const original = await read(args.path, 0, 2097152);
      if (original.truncated) throw new Error('File exceeds the 2 MiB edit limit.');
      if (!args.old_text || !original.content.includes(args.old_text)) throw new Error('old_text must be non-empty and match the current file exactly.');
      if (original.content.indexOf(args.old_text) !== original.content.lastIndexOf(args.old_text)) throw new Error('old_text is ambiguous. Include more surrounding text.');
      return writeText(args.path, original.content.replace(args.old_text, () => args.new_text), true, original.content, signal);
    }
    if (name === 'search_files') {
      if (!args.query) throw new Error('query cannot be empty.');
      const target = await resolve(args.path || '.');
      const stat = await fs.stat(target);
      const listing = stat.isDirectory() ? await tree(target, true, signal)
        : { entries: [{ path: display(projectRoot, target), type: 'file' }], truncated: false };
      const matches = [];
      const limit = number(args.max_results, 50, 200, 'max_results');
      let truncated = listing.truncated;
      for (const item of listing.entries.filter((entry) => entry.type === 'file').slice(0, 1000)) {
        checkAbort(signal);
        let file;
        try { file = await read(item.path, 0, 1048576); } catch { continue; }
        if (file.truncated) truncated = true;
        for (const [index, line] of file.content.split(/\r?\n/).entries()) {
          if (line.includes(args.query)) matches.push({ path: item.path, line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= limit) return { matches, truncated: true };
        }
      }
      return { matches, truncated: truncated || listing.entries.filter((entry) => entry.type === 'file').length > 1000 };
    }
    if (name === 'run_command') return run(args, signal);
    throw new Error(`Unknown tool: ${name}`);
  };
  if (!['read-only', 'workspace', 'all', 'ask'].includes(permissions)) throw new Error('Unknown workspace permissions.');
  return workspace;
}
