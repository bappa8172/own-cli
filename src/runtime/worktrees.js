import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { projectStore } from '../session/store.js';
const exec = promisify(execFile);
export async function createProjectWorktree(root, { name = randomUUID(), env = process.env } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(name)) throw new Error('Worktree name must contain only letters, digits, and hyphens (1–64 characters).');
  let repository;
  try { repository = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root, windowsHide: true })).stdout.trim(); }
  catch { throw new Error('--worktree requires an existing Git repository with a committed HEAD.'); }
  await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repository, windowsHide: true });
  const directory = path.join(projectStore(repository, env), 'worktrees', name);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await exec('git', ['worktree', 'add', '-b', `own-cli/${name}`, directory, 'HEAD'], { cwd: repository, windowsHide: true });
  return { root: directory, repository, branch: `own-cli/${name}`, base: 'HEAD', name };
}
