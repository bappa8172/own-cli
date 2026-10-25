import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export async function createSandbox({ mode = 'off', root, platform = process.platform, executable } = {}) {
  if (!['off', 'required'].includes(mode)) throw new Error('--sandbox must be off or required.');
  if (mode === 'off') return { mode, available: false, async prepare(command) { return command; } };
  if (platform !== 'linux') throw new Error(`Required OS sandbox is unavailable on ${platform}. No agent actions were started. Use a supported Linux bubblewrap host or explicitly select --sandbox off.`);
  let binary = executable;
  if (!binary) for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(folder, 'bwrap');
    try { await fs.access(candidate, 1); binary = candidate; break; } catch { /* try the next directory */ }
  }
  if (!binary) throw new Error('Required OS sandbox needs bubblewrap (bwrap). No agent actions were started.');
  const mounts = [];
  for (const directory of ['/usr', '/bin', '/sbin', '/lib', '/lib64']) {
    try { await fs.access(directory); mounts.push('--ro-bind', directory, directory); } catch { /* optional system path */ }
  }
  const sandbox = { mode, available: true, async prepare({ executable: command, args, cwd }) {
    return { executable: binary, args: ['--die-with-parent', '--new-session', '--unshare-all', ...mounts,
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', root, root, '--chdir', cwd, '--', command, ...args] };
  } };
  const probe = await sandbox.prepare({ executable: '/bin/true', args: [], cwd: root });
  try { await promisify(execFile)(probe.executable, probe.args, { timeout: 5000, env: { PATH: process.env.PATH || '/usr/bin:/bin' }, windowsHide: true }); }
  catch { throw new Error('Required bubblewrap sandbox could not initialize. No agent actions were started. Check namespace/mount permissions.'); }
  return sandbox;
}
