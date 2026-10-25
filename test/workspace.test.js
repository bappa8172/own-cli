import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkspace } from '../src/workspace.js';
import { temporary, write } from '../support/fixtures.js';

test('cancelled approval cannot write a file after a late approval response', async (t) => {
  const root = await temporary(t);
  let answer; let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const workspace = await createWorkspace({ root, permissions: 'ask', approve: () => {
    entered(); return new Promise((resolve) => { answer = resolve; });
  } });
  const controller = new AbortController();
  const pending = workspace.execute('write_file', { path: 'late/new.txt', content: 'blocked' }, { signal: controller.signal });
  await waiting;
  controller.abort();
  await assert.rejects(pending, /cancel|abort/i);
  answer('session');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fs.access(path.join(root, 'late')));
  assert.equal(workspace.changes.length, 0);
});

test('permission path rules evaluate normalized paths before mutations', async (t) => {
  const root = await temporary(t);
  const workspace = await createWorkspace({ root, policy: [{ tool: 'write_file', action: 'deny', pathRegex: '^blocked/' }] });
  await assert.rejects(workspace.execute('write_file', { path: './blocked/new.txt', content: 'blocked' }), /denied/);
  await assert.rejects(fs.access(path.join(root, 'blocked')));
});

test('workspace creates folders/files and returns real change receipts', async (t) => {
  const root = await temporary(t);
  const workspace = await createWorkspace({ root });
  const folder = await workspace.execute('make_directory', { path: 'amazon/assets' });
  assert.equal(folder.action, 'directory-created');
  assert.equal((await workspace.execute('make_directory', { path: 'amazon/assets' })).action, 'directory-exists');
  const change = await workspace.execute('write_file', { path: 'amazon/index.html', content: '<h1>Store</h1>' });
  assert.equal(change.action, 'created');
  assert.equal(await fs.readFile(path.join(root, 'amazon/index.html'), 'utf8'), '<h1>Store</h1>');
  assert.equal(workspace.changes.length, 2);
});

test('edits replace exact unique text and preserve originals in backups', async (t) => {
  const root = await temporary(t);
  await write(root, 'src/app.js', 'export const answer = 1;');
  const workspace = await createWorkspace({ root });
  const change = await workspace.execute('edit_file', { path: 'src/app.js', old_text: 'answer = 1', new_text: 'answer = 42' });
  assert.equal(change.action, 'updated');
  assert.match(await fs.readFile(path.join(root, 'src/app.js'), 'utf8'), /answer = 42/);
  assert.equal(await fs.readFile(path.join(root, change.backup), 'utf8'), 'export const answer = 1;');
  assert.deepEqual((await workspace.execute('list_directory', { recursive: true })).entries.map((entry) => entry.path), ['src', 'src/app.js']);
});

test('overwrite is explicit; backup content and replacement strings remain literal', async (t) => {
  const root = await temporary(t);
  await write(root, 'a.txt', 'one two');
  const workspace = await createWorkspace({ root });
  await assert.rejects(workspace.execute('write_file', { path: 'a.txt', content: 'new' }), /already exists/);
  const change = await workspace.execute('write_file', { path: 'a.txt', content: 'new', overwrite: true });
  assert.equal(await fs.readFile(path.join(root, change.backup), 'utf8'), 'one two');
  await workspace.execute('edit_file', { path: 'a.txt', old_text: 'new', new_text: '$& literal' });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), '$& literal');
});

test('missing or ambiguous edit targets do not mutate the file', async (t) => {
  const root = await temporary(t);
  await write(root, 'a.txt', 'same same');
  const workspace = await createWorkspace({ root });
  for (const old_text of ['', 'absent', 'same']) {
    await assert.rejects(workspace.execute('edit_file', { path: 'a.txt', old_text, new_text: 'changed' }));
  }
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'same same');
  assert.equal(workspace.changes.length, 0);
});

test('byte cursors reconstruct Unicode across small reads without losing characters', async (t) => {
  const root = await temporary(t);
  const original = 'हैलो 🌍 replacement � done';
  await write(root, 'unicode.txt', original);
  const workspace = await createWorkspace({ root });
  let offset = 0; let content = '';
  while (true) {
    const result = await workspace.execute('read_file', { path: 'unicode.txt', offset, max_chars: 4 });
    content += result.content;
    if (!result.truncated) break;
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  }
  assert.equal(content, original);
});

test('editing preserves an existing UTF-8 byte order mark', async (t) => {
  const root = await temporary(t);
  await write(root, 'bom.js', '\uFEFFconst value = 1;');
  const workspace = await createWorkspace({ root });
  await workspace.execute('edit_file', { path: 'bom.js', old_text: 'value = 1', new_text: 'value = 2' });
  assert.equal(await fs.readFile(path.join(root, 'bom.js'), 'utf8'), '\uFEFFconst value = 2;');
});

test('binary, malformed UTF-8 and over-limit edits fail visibly', async (t) => {
  const root = await temporary(t);
  await write(root, 'binary.bin', Buffer.from([0, 1, 2]));
  await write(root, 'bad.txt', Buffer.from([255, 254]));
  await write(root, 'large.txt', 'a'.repeat(2097153));
  const workspace = await createWorkspace({ root });
  await assert.rejects(workspace.execute('read_file', { path: 'binary.bin' }), /Binary/);
  await assert.rejects(workspace.execute('read_file', { path: 'bad.txt' }), /UTF-8/);
  await assert.rejects(workspace.execute('write_file', { path: 'binary.bin', content: 'text', overwrite: true }), /binary/);
  await assert.rejects(workspace.execute('edit_file', { path: 'large.txt', old_text: 'a', new_text: 'b' }), /2 MiB/);
  await assert.rejects(workspace.execute('write_file', { path: 'new.txt', content: 'a'.repeat(2097153) }), /2 MiB/);
});

for (const target of ['../outside.txt', '.git/config', '.own-codex/auth.json', '.own-cli-backups/saved.txt', '.env', '.npmrc', 'secrets/value.js', 'file:stream']) {
  test(`file tools reject out-of-scope or credential paths: ${target}`, async (t) => {
    const workspace = await createWorkspace({ root: await temporary(t) });
    await assert.rejects(workspace.execute('write_file', { path: target, content: 'no' }), /outside|Protected/);
    assert.equal(workspace.changes.length, 0);
  });
}

test('file tools cannot traverse internal or external directory junctions', async (t) => {
  const base = await temporary(t);
  const root = path.join(base, 'root');
  await write(root, 'inside/a.js', 'inside');
  await write(base, 'outside/a.js', 'outside');
  for (const [name, destination] of [['internal-link', path.join(root, 'inside')], ['external-link', path.join(base, 'outside')]]) {
    await fs.symlink(destination, path.join(root, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const workspace = await createWorkspace({ root });
  for (const name of ['internal-link', 'external-link']) {
    await assert.rejects(workspace.execute('read_file', { path: `${name}/a.js` }), /links and junctions/);
    await assert.rejects(workspace.execute('write_file', { path: `${name}/new.js`, content: 'no' }), /links and junctions/);
  }
});

test('read-only and workspace permissions cannot be bypassed by calling unavailable tools', async (t) => {
  const root = await temporary(t);
  const workspace = await createWorkspace({ root, permissions: 'read-only' });
  assert.deepEqual(workspace.tools().map((tool) => tool.name), ['list_directory', 'read_file', 'search_files']);
  await assert.rejects(workspace.execute('write_file', { path: 'a', content: 'no' }), /unavailable/);
  workspace.permissions = 'workspace';
  assert.ok(workspace.tools().some((tool) => tool.name === 'write_file'));
  assert.ok(!workspace.tools().some((tool) => tool.name === 'run_command'));
  await assert.rejects(workspace.execute('run_command', { command: 'node', args: ['--version'] }), /unavailable/);
  workspace.permissions = 'all';
  assert.ok(workspace.tools().some((tool) => tool.name === 'run_command'));
});

test('tool schemas are enforced before local operations', async (t) => {
  const workspace = await createWorkspace({ root: await temporary(t) });
  for (const args of [null, [], {}, { path: 'a', content: 4 }, { path: 'a', content: 'x', unknown: true }]) {
    await assert.rejects(workspace.execute('write_file', args));
  }
  await assert.rejects(workspace.execute('read_file', { path: 'a', offset: -1 }), /offset/);
  await assert.rejects(workspace.execute('read_file', { path: 'a', max_chars: 1 }), /max_chars/);
  await assert.rejects(workspace.execute('missing_tool', {}), /unavailable/);
});

test('literal search returns file paths and line numbers and excludes generated files', async (t) => {
  const root = await temporary(t);
  await write(root, 'src/a.js', 'first\nconst needle = "a.b";\nlast');
  await write(root, 'src/b.js', 'axb');
  await write(root, 'node_modules/ignored.js', 'a.b');
  const workspace = await createWorkspace({ root });
  const result = await workspace.execute('search_files', { query: 'a.b' });
  assert.deepEqual(result.matches, [{ path: 'src/a.js', line: 2, text: 'const needle = "a.b";' }]);
  assert.equal(result.truncated, false);
});

test('commands run inside the selected folder and report both successful and failed exit codes', async (t) => {
  const root = await temporary(t);
  await write(root, 'nested/valid.js', 'console.log("verified");');
  const workspace = await createWorkspace({ root, permissions: 'all' });
  const success = await workspace.execute('run_command', { command: 'node', args: ['valid.js'], cwd: 'nested' });
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout.trim(), 'verified');
  const failure = await workspace.execute('run_command', { command: 'node', args: ['-e', 'console.error("failure"); process.exit(7)'] });
  assert.equal(failure.exitCode, 7);
  assert.match(failure.stderr, /failure/);
  assert.equal(workspace.commands.length, 2);
});

test('npm test works on Windows without passing model text through a shell', async (t) => {
  const root = await temporary(t);
  await write(root, 'package.json', JSON.stringify({ scripts: { test: 'node -e "console.log(42)"' } }));
  const workspace = await createWorkspace({ root, permissions: 'all' });
  const result = await workspace.execute('run_command', { command: 'npm', args: ['test'] });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /42/);
});

test('command output is bounded and hangs are terminated', async (t) => {
  const workspace = await createWorkspace({ root: await temporary(t), permissions: 'all' });
  const output = await workspace.execute('run_command', { command: 'node', args: ['-e', 'console.log("x".repeat(50000))'] });
  assert.equal(output.exitCode, 0);
  assert.equal(output.truncated, true);
  assert.ok(output.stdout.length + output.stderr.length <= 24000);
  const hung = await workspace.execute('run_command', { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeout_ms: 150 });
  assert.equal(hung.timedOut, true);
  assert.notEqual(hung.exitCode, 0);
});

test('command cancellation stops a running process; cancelled file actions do nothing', async (t) => {
  const workspace = await createWorkspace({ root: await temporary(t), permissions: 'all' });
  const controller = new AbortController();
  const pending = workspace.execute('run_command', { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 150);
  const result = await pending;
  clearTimeout(timer);
  assert.equal(result.cancelled, true);
  await assert.rejects(workspace.execute('write_file', { path: 'a', content: 'no' }, { signal: controller.signal }), /cancelled/);
  assert.equal(workspace.changes.length, 0);
});
