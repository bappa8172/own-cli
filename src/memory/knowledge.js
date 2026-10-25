import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { projectStore } from '../session/store.js';

const words = (text) => String(text).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
function embedding(text, hashes = new Map()) {
  const vector = new Float64Array(128);
  for (const word of words(text)) { let hash = hashes.get(word); if (!hash) { hash = createHash('sha256').update(word).digest(); hashes.set(word, hash); } vector[hash[0] % 128] += hash[1] & 1 ? 1 : -1; }
  const norm = Math.hypot(...vector) || 1;
  return [...vector].map((value) => value / norm);
}
export function retrieveMemory(items, query, limit = 5) {
  const allTerms = words(query); const terms = [...new Set([...allTerms.slice(0, 64), ...allTerms.slice(-64)])];
  const hashes = new Map(); const queryVector = embedding(terms.join(' '), hashes);
  const documents = items.map((item) => { const tokens = words(item.text); const counts = new Map(); for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1); return { item, tokens, counts }; });
  const length = documents.reduce((sum, document) => sum + document.tokens.length, 0) / (items.length || 1);
  const frequencies = new Map(terms.map((term) => [term, documents.filter((document) => document.counts.has(term)).length]));
  return documents.map(({ item, tokens, counts }) => {
    const vector = embedding(item.text, hashes);
    let bm25 = 0;
    for (const term of new Set(terms)) {
      const frequency = counts.get(term) || 0;
      const count = frequencies.get(term);
      const idf = Math.log(1 + (items.length - count + 0.5) / (count + 0.5));
      bm25 += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * tokens.length / (length || 1)));
    }
    const similarity = vector.reduce((sum, value, index) => sum + value * queryVector[index], 0);
    return { ...item, score: bm25 + Math.max(0, similarity) * 0.2 };
  }).filter((item) => !terms.length || item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function createKnowledge(root, env = process.env) {
  const base = projectStore(root, env); const memoryFile = path.join(base, 'memory.json');
  const read = async () => { try { return JSON.parse(await fs.readFile(memoryFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const save = async (items) => { await fs.mkdir(base, { recursive: true }); const temp = memoryFile + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(temp, JSON.stringify(items, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, memoryFile); }
    finally { await fs.rm(temp, { force: true }); } };
  return {
    async rules() {
      const rules = [];
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const file = path.join(root, name);
        try {
          const stat = await fs.lstat(file);
          if (stat.isSymbolicLink() || stat.size > 64000) continue;
          rules.push({ file: name, text: await fs.readFile(file, 'utf8') });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return rules;
    },
    async search(query, limit) { return retrieveMemory(await read(), query, limit); },
    async remember(text, kind = 'decision') {
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('Memory must contain 1–8000 characters.');
      if (!['decision', 'preference', 'failure', 'note'].includes(kind)) throw new Error('Invalid memory kind.');
      const items = await read(); if (items.length >= 1000) throw new Error('Project memory has reached 1000 entries. Remove old entries first.');
      const item = { id: randomUUID(), kind, text: text.trim(), time: new Date().toISOString() };
      items.push(item); await save(items); return item;
    },
    async forget(id) { const items = await read(); const next = items.filter((item) => item.id !== id); if (next.length === items.length) throw new Error('Memory ID was not found.'); await save(next); return { removed: id }; },
    async skills() {
      const skills = [];
      const folders = [path.join(root, '.agents', 'skills'), path.join(root, '.own-cli', 'skills'), path.join(env.OWN_CODEX_HOME || path.join(os.homedir(), '.own-codex'), 'skills')];
      for (const folder of folders) {
        let entries;
        try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const entry of entries.slice(0, 100)) if (entry.isDirectory() && !entry.isSymbolicLink()) {
          const file = path.join(folder, entry.name, 'SKILL.md');
          try {
            const stat = await fs.lstat(file); if (stat.isSymbolicLink() || stat.size > 64000) continue;
            const text = await fs.readFile(file, 'utf8'); const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            const name = front?.[1].match(/^name:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') || entry.name;
            const description = front?.[1].match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') || '';
            skills.push({ id: createHash('sha256').update(file).digest('hex').slice(0, 16), name, description, file });
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      return skills;
    },
    async loadSkill(id) {
      const skill = (await this.skills()).find((item) => item.id === id || item.name === id);
      if (!skill) throw new Error('Skill was not found. List skills first.');
      return { name: skill.name, file: skill.file, text: await fs.readFile(skill.file, 'utf8') };
    },
  };
}
