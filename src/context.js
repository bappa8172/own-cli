import fs from 'node:fs/promises';
import path from 'node:path';
import { positiveInteger } from './config.js';

const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.turbo', '.venv', '.vscode', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules', 'target', 'vendor',
]);
const SOURCE_EXTENSIONS = new Set([
  '.bat', '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java',
  '.js', '.cjs', '.json', '.jsx', '.md', '.mdx', '.mjs', '.mts', '.ps1', '.py',
  '.rb', '.rs', '.scss', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);
const IMPORTANT = new Set(['AGENTS.md', 'Cargo.toml', 'Dockerfile', 'Makefile', 'README', 'README.md',
  'CLAUDE.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'tsconfig.json', '.gitignore', '.gitattributes', '.editorconfig']);
export const isHiddenSourceDirectory = (name) => ['.github', '.gitlab', '.devcontainer', '.storybook', '.well-known'].includes(name.toLowerCase());

const display = (root, target) => path.relative(root, target).split(path.sep).join('/') || '.';
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export function isSensitiveName(name) {
  return /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|vault\.json|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(name)
    || /\.(pem|key|p12|pfx)$/i.test(name);
}
const sensitive = isSensitiveName;
function candidate(name) { return !sensitive(name) && (IMPORTANT.has(name) || SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())); }
function generated(name) { return IGNORED_DIRECTORIES.has(name.toLowerCase()) || name.startsWith('.') && !isHiddenSourceDirectory(name); }

function ignoreRule(line, base) {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith('#')) return null;
  const negate = pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1);
  const directoryOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/$/, '');
  const anchored = pattern.startsWith('/') || pattern.includes('/');
  pattern = pattern.replace(/^\//, '');
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') { expression += '(?:.*/)?'; index += 1; }
      else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return { base, negate, directoryOnly, regex: new RegExp(`${anchored ? '^' : '(?:^|/)'}${expression}$`) };
}
function ignored(target, isDirectory, rules) {
  let result = false;
  for (const rule of rules) {
    const relative = display(rule.base, target);
    if (within(rule.base, target) && (!rule.directoryOnly || isDirectory) && rule.regex.test(relative)) result = !rule.negate;
  }
  return result;
}

async function walk(root, limits, warnings) {
  const files = [];
  const queue = [{ directory: root, rules: [] }];
  let visited = 0;
  let directories = 0;
  while (queue.length && files.length < limits.maxFiles && visited < limits.maxEntries && directories < limits.maxDirectories) {
    const { directory, rules: parentRules } = queue.shift();
    directories += 1;
    let rules = parentRules;
    try {
      const ignore = await fs.readFile(path.join(directory, '.gitignore'), 'utf8');
      rules = [...rules, ...ignore.split(/\r?\n/).map((line) => ignoreRule(line, directory)).filter(Boolean)];
    } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Cannot read .gitignore in ${display(root, directory)}.`); }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { warnings.push(`Cannot scan ${display(root, directory)} (${error.code}).`); continue; }
    entries.sort((a, b) => (IMPORTANT.has(b.name) - IMPORTANT.has(a.name)) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > limits.maxEntries) break;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (ignored(target, entry.isDirectory(), rules)) continue;
      if (entry.isDirectory() && !generated(entry.name)) queue.push({ directory: target, rules });
      else if (entry.isFile() && (limits.allText ? !sensitive(entry.name) : candidate(entry.name))) files.push(target);
      if (files.length >= limits.maxFiles) break;
    }
  }
  if (queue.length || files.length >= limits.maxFiles || visited >= limits.maxEntries || directories >= limits.maxDirectories) {
    warnings.push('Project scan reached its limit; use --file or --dir to focus the context.');
  }
  return files;
}

async function excerpt(filePath, limit) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    // Bound I/O as well as the final prompt; never read an entire huge file.
    const buffer = Buffer.alloc(Math.min(stat.size, Math.max(4096, limit * 4)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.includes(0)) return null;
    const text = data.toString('utf8');
    const truncated = bytesRead < stat.size || text.length > limit;
    const marker = '\n… [file excerpt; remaining content omitted]';
    const content = truncated && limit > marker.length ? text.slice(0, limit - marker.length) + marker : text.slice(0, limit);
    return { content, truncated, sizeBytes: stat.size };
  } finally { await handle.close(); }
}

export async function collectProjectContext({
  root = process.cwd(), files = [], directories = [], maxChars = 24000, maxFileChars = 6000, includeTree = true, fullProject = false,
} = {}) {
  positiveInteger(maxChars, 24000, 'maxChars');
  positiveInteger(maxFileChars, 6000, 'maxFileChars');
  let projectRoot;
  try {
    projectRoot = await fs.realpath(path.resolve(root));
    if (!(await fs.stat(projectRoot)).isDirectory()) throw new Error('not a directory');
  } catch { throw new Error(`Project root is not a readable directory: ${path.resolve(root)}`); }
  const warnings = [];
  const limits = fullProject ? { maxFiles: 5000, maxEntries: 100000, maxDirectories: 10000, allText: true }
    : { maxFiles: 300, maxEntries: 10000, maxDirectories: 1000 };
  const allFiles = await walk(projectRoot, limits, warnings);
  let selected;
  if (files.length || directories.length) {
    selected = [];
    for (const [targets, kind] of [[files, 'file'], [directories, 'directory']]) {
      for (const target of targets) {
        const absolute = path.resolve(projectRoot, target);
        let real;
        try { real = await fs.realpath(absolute); }
        catch { throw new Error(`Context ${kind} does not exist: ${target}`); }
        if (!within(projectRoot, absolute) || !within(projectRoot, real)) throw new Error(`Context path is outside the project root: ${target}`);
        const stat = await fs.stat(real);
        if (kind === 'file' && !stat.isFile()) throw new Error(`--file requires a regular file: ${target}`);
        if (kind === 'directory' && !stat.isDirectory()) throw new Error(`--dir requires a directory: ${target}`);
        if (kind === 'file') {
          if (display(projectRoot, real).split('/').some(sensitive)) throw new Error(`Sensitive files cannot be included: ${target}`);
          selected.push(real);
        } else {
          // Scan focused directories independently so large sibling folders cannot crowd them out.
          const focused = await walk(real, limits, warnings);
          selected.push(...focused);
        }
      }
    }
  } else {
    selected = allFiles.sort((a, b) => {
      const score = (file) => (IMPORTANT.has(path.basename(file)) ? -100 : 0) + display(projectRoot, file).split('/').length;
      return score(a) - score(b) || a.localeCompare(b);
    });
  }
  selected = [...new Set(selected)];
  const blocks = [];
  const included = [];
  const truncatedFiles = [];
  let used = 0;
  function add(block) {
    const cost = block.length + (blocks.length ? 2 : 0);
    if (used + cost > maxChars) return false;
    blocks.push(block); used += cost; return true;
  }
  if (includeTree && allFiles.length) {
    const heading = 'DISCOVERED FILES (listing only; contents may be omitted)\n';
    const budget = Math.floor(maxChars * 0.25);
    const paths = [];
    let size = heading.length;
    for (const file of allFiles.slice(0, 120)) {
      const name = display(projectRoot, file);
      if (size + name.length + 1 > budget) break;
      paths.push(name); size += name.length + 1;
    }
    if (paths.length) add(heading + paths.join('\n'));
  }
  for (const file of selected) {
    const relative = display(projectRoot, file);
    const heading = `FILE: ${relative}\n`;
    const remaining = maxChars - used - (blocks.length ? 2 : 0) - heading.length;
    if (remaining <= 8) break;
    try {
      const real = await fs.realpath(file);
      if (!within(projectRoot, real)) { warnings.push(`Skipped path outside root: ${relative}`); continue; }
      if (display(projectRoot, real).split('/').some(sensitive)) continue;
      const result = await excerpt(real, Math.min(maxFileChars, remaining));
      if (!result) { warnings.push(`Skipped binary file: ${relative}`); continue; }
      // JSON quoting makes snapshot boundaries unambiguous, including literal Markdown/XML in source.
      let content = result.content;
      let block = heading + JSON.stringify(content);
      if (block.length > remaining + heading.length) {
        // Escaped characters count toward the same strict global budget.
        let low = 0; let high = content.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (JSON.stringify(content.slice(0, middle)).length <= remaining) low = middle;
          else high = middle - 1;
        }
        content = content.slice(0, low);
        block = heading + JSON.stringify(content);
      }
      if (!add(block)) break;
      included.push(relative);
      if (result.truncated || content.length < result.content.length) truncatedFiles.push(relative);
    } catch (error) {
      if (files.some((target) => path.resolve(projectRoot, target) === file)) throw new Error(`Cannot read context file ${relative}: ${error.code || error.message}`);
      warnings.push(`Cannot read ${relative} (${error.code || 'read failed'}).`);
    }
  }
  const omittedFiles = selected.map((file) => display(projectRoot, file)).filter((name) => !included.includes(name));
  return {
    root: projectRoot, files: included, discoveredFiles: allFiles.map((file) => display(projectRoot, file)),
    truncatedFiles, omittedFiles, warnings: [...new Set(warnings)].slice(0, 20), text: blocks.join('\n\n'),
  };
}
