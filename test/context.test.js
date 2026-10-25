import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { collectProjectContext } from '../src/context.js';
import { temporary, write } from '../support/fixtures.js';

test('collectProjectContext skips generated folders and respects the budget', async (t) => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"demo"}');
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'export const answer = 42;');
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'should not appear');

  const result = await collectProjectContext({ root, maxChars: 500, maxFileChars: 200 });
  assert.match(result.text, /package\.json/);
  assert.match(result.text, /src\/main\.js/);
  assert.doesNotMatch(result.text, /should not appear/);
  assert.ok(result.text.length <= 500);
});

test('context lists only supplied contents as included, distinguishes excerpts and omissions', async (t) => {
  const root = await temporary(t);
  await write(root, 'README.md', 'a'.repeat(1000));
  await write(root, 'src/app.js', 'answer');
  const result = await collectProjectContext({ root, maxChars: 160, maxFileChars: 80 });
  assert.ok(result.text.length <= 160);
  assert.ok(result.truncatedFiles.includes('README.md'));
  assert.equal(result.files.length + result.omittedFiles.length, 2);
  for (const file of result.files) assert.ok(result.text.includes(`FILE: ${file}\n`));
});

test('separator and escaped-character costs remain within every small budget', async (t) => {
  const root = await temporary(t);
  await write(root, 'a.js', '\\"\n'.repeat(100));
  await write(root, 'b.js', 'const a = 1;');
  for (let budget = 1; budget <= 400; budget += 1) {
    const result = await collectProjectContext({ root, maxChars: budget, maxFileChars: 200 });
    assert.ok(result.text.length <= budget, `budget ${budget}, actual ${result.text.length}`);
  }
});

test('explicit files stay in requested order and support extensionless text', async (t) => {
  const root = await temporary(t);
  await write(root, 'README.md', 'readme should not crowd out selection');
  await write(root, 'b.custom', 'selected first');
  await write(root, 'a.js', 'selected second');
  const result = await collectProjectContext({ root, files: ['b.custom', 'a.js'] });
  assert.deepEqual(result.files, ['b.custom', 'a.js']);
  assert.ok(result.text.indexOf('FILE: b.custom') < result.text.indexOf('FILE: a.js'));
  assert.ok(!result.text.includes('FILE: README.md'));
});

test('gitignore handles root rules, nested rules, glob paths and negation', async (t) => {
  const root = await temporary(t);
  await write(root, '.gitignore', 'ignored/\n*.log\n/cache.js\n**/generated*.js\n*.json\n!package.json');
  await write(root, 'ignored/app.js', 'excluded');
  await write(root, 'cache.js', 'excluded');
  await write(root, 'src/cache.js', 'included');
  await write(root, 'src/generated-a.js', 'excluded');
  await write(root, 'package.json', '{}');
  await write(root, 'other.json', 'excluded');
  await write(root, 'src/.gitignore', 'local.js');
  await write(root, 'src/local.js', 'excluded');
  const result = await collectProjectContext({ root });
  assert.ok(result.files.includes('package.json'));
  assert.ok(result.files.includes('src/cache.js'));
  for (const name of ['ignored/app.js', 'cache.js', 'src/generated-a.js', 'other.json', 'src/local.js']) {
    assert.ok(!result.discoveredFiles.includes(name), name);
  }
  assert.doesNotMatch(result.text, /excluded/);
});

test('common credential files and secret directories are not shared', async (t) => {
  const root = await temporary(t);
  for (const file of ['.env', '.env.local', 'auth.json', 'credentials.json', 'secrets.yaml', 'id_rsa', 'private.key', 'secrets/nested.js']) {
    await write(root, file, 'DO_NOT_SHARE_THIS_SECRET');
  }
  await write(root, 'src/main.js', 'safe content');
  const result = await collectProjectContext({ root });
  assert.doesNotMatch(result.text, /DO_NOT_SHARE_THIS_SECRET/);
  assert.ok(result.files.includes('src/main.js'));
  for (const file of ['auth.json', '.env.local', 'secrets/nested.js']) {
    await assert.rejects(collectProjectContext({ root, files: [file] }), /Sensitive/);
  }
});

test('binary files are skipped and large files are bounded and marked as excerpts', async (t) => {
  const root = await temporary(t);
  await write(root, 'binary.json', Buffer.from([1, 0, 3]));
  await write(root, 'huge.js', 'x'.repeat(2 * 1024 * 1024));
  const result = await collectProjectContext({ root, maxFileChars: 100 });
  assert.deepEqual(result.files, ['huge.js']);
  assert.deepEqual(result.truncatedFiles, ['huge.js']);
  assert.match(result.warnings.join(), /binary/);
  assert.ok(result.text.length < 1000);
});

test('missing roots and explicit paths fail visibly; path traversal cannot silently disappear', async (t) => {
  const root = await temporary(t);
  await write(root, 'src/file.js', 'content');
  await assert.rejects(collectProjectContext({ root: path.join(root, 'missing') }), /root/);
  await assert.rejects(collectProjectContext({ root, files: ['missing.js'] }), /does not exist/);
  await assert.rejects(collectProjectContext({ root, files: ['src'] }), /regular file/);
  await assert.rejects(collectProjectContext({ root, directories: ['src/file.js'] }), /directory/);
  await assert.rejects(collectProjectContext({ root, directories: ['..'] }), /outside/);
});

test('a valid filename beginning with two dots is inside the root', async (t) => {
  const root = await temporary(t);
  await write(root, '..notes.js', 'safe');
  assert.deepEqual((await collectProjectContext({ root, files: ['..notes.js'] })).files, ['..notes.js']);
});

test('directory junctions cannot expose files outside the project', async (t) => {
  const base = await temporary(t);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await write(root, 'safe.js', 'safe');
  await write(outside, 'private.js', 'outside-secret');
  await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await collectProjectContext({ root });
  assert.doesNotMatch(result.text, /outside-secret/);
  await assert.rejects(collectProjectContext({ root, files: ['link/private.js'] }), /outside/);
  await assert.rejects(collectProjectContext({ root, directories: ['link'] }), /outside/);
});

test('focused directories work even when an earlier sibling exhausts the scan limit', async (t) => {
  const root = await temporary(t);
  await Promise.all(Array.from({ length: 305 }, (_, i) => write(root, `crowded/${String(i).padStart(3, '0')}.js`, 'irrelevant')));
  await write(root, 'z-target/main.js', 'focused answer');
  const result = await collectProjectContext({ root, directories: ['z-target'] });
  assert.deepEqual(result.files, ['z-target/main.js']);
  assert.match(result.text, /focused answer/);
  assert.match(result.warnings.join(), /limit/);
});
