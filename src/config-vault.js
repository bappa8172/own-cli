import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, randomUUID } from 'node:crypto';

function filePath({ env = process.env, homeDir = os.homedir() } = {}) {
  return path.join(env.OWN_CODEX_HOME || path.join(homeDir, '.own-codex'), 'vault.json');
}
function providerName(provider) {
  if (typeof provider !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(provider) || ['__proto__', 'constructor', 'prototype'].includes(provider)) throw new Error('Invalid credential provider name.');
  return provider;
}
async function readVault(options) {
  try {
    const value = JSON.parse(await fs.readFile(filePath(options), 'utf8'));
    if (!value || value.version !== 1 || !value.credentials || typeof value.credentials !== 'object' || Array.isArray(value.credentials)) throw new Error('Invalid encrypted vault.');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, credentials: {} }; throw error; }
}
async function saveVault(value, options) {
  const file = filePath(options); const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function dpapi(value, decrypt) {
  const operation = decrypt
    ? '$v=[Console]::In.ReadToEnd() | ConvertFrom-Json; $s=ConvertTo-SecureString $v.value; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }'
    : '$v=[Console]::In.ReadToEnd() | ConvertFrom-Json; $s=ConvertTo-SecureString $v.value -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $s))';
  const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + operation;
  return new Promise((resolve, reject) => {
    // PowerShell 7's inherited module path can prevent Windows PowerShell 5.1 from loading its security module.
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Windows credential encryption timed out.')); }, 15000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; if (output.length > 100000) child.kill(); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Windows credential encryption could not start.')); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 && output ? resolve(output) : reject(new Error('Windows credential decryption/encryption failed for this account.')); });
    child.stdin.end(JSON.stringify({ value }));
  });
}
function labelName(label) {
  if (typeof label !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}$/.test(label) || ['__proto__', 'constructor', 'prototype'].includes(label)) throw new Error('Key label must use 1–40 letters, digits, dots, underscores or hyphens.');
  return label;
}
function keyRing(record) {
  if (!record) return { keys: [], active: 'default', rotation: 'failover' };
  if (Array.isArray(record.keys)) return record;
  return { keys: [{ ...record, label: 'default' }], active: 'default', rotation: 'failover' };
}
let pending = Promise.resolve();
function updateVault(options, change) {
  const operation = pending.catch(() => {}).then(async () => {
    if (options.signal?.aborted) throw new Error('Credential update cancelled.');
    const file = filePath(options); await fs.mkdir(path.dirname(file), { recursive: true });
    let lock;
    try { lock = await fs.open(file + '.lock', 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Credential vault is being updated by another process. Retry after it finishes; a crashed process may leave vault.json.lock.'); throw error; }
    try { const vault = await readVault(options); const result = change(vault); await saveVault(vault, options); return result; }
    finally { await lock.close(); await fs.unlink(file + '.lock'); }
  });
  pending = operation; return operation;
}
export async function storeCredential(provider, secret, options = {}) {
  providerName(provider); const label = labelName(options.label || 'default');
  if (typeof secret !== 'string' || !secret.trim() || secret.length > 64000 || /[\r\n]/.test(secret.trim())) throw new Error('Credential must be a non-empty single line.');
  const env = options.env || process.env;
  let record;
  if ((options.platform || process.platform) === 'win32') record = { method: 'windows-dpapi', encrypted: await dpapi(secret.trim(), false) };
  else {
    if (!env.OWN_CODEX_VAULT_KEY || env.OWN_CODEX_VAULT_KEY.length < 32) throw new Error('Encrypted credentials require OWN_CODEX_VAULT_KEY with at least 32 characters on this platform. No plaintext vault fallback is used.');
    const salt = randomBytes(16); const key = scryptSync(env.OWN_CODEX_VAULT_KEY, salt, 32); const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(secret.trim(), 'utf8'), cipher.final()]);
    record = { method: 'aes-256-gcm', encrypted: encrypted.toString('base64'), salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  return updateVault(options, (vault) => {
    const ring = keyRing(vault.credentials[provider]);
    const index = ring.keys.findIndex((key) => key.label === label);
    if (options.add && index >= 0) throw new Error('A key with that label already exists. Use another label or auth login to replace it.');
    if (index < 0 && ring.keys.length >= 32) throw new Error('At most 32 keys are supported per provider.');
    if (index >= 0) ring.keys[index] = { ...record, label }; else ring.keys.push({ ...record, label });
    if (!ring.keys.some((key) => key.label === ring.active) || !options.add) ring.active = label;
    vault.credentials[provider] = ring;
    return { provider, label, method: record.method, path: filePath(options) };
  });
}
async function decryptCredential(record, options) {
  if (record.method === 'windows-dpapi') {
    if ((options.platform || process.platform) !== 'win32') throw new Error('This credential is encrypted for a Windows account.');
    return dpapi(record.encrypted, true);
  }
  const env = options.env || process.env;
  if (record.method !== 'aes-256-gcm' || !env.OWN_CODEX_VAULT_KEY) throw new Error('Encrypted credential cannot be unlocked without OWN_CODEX_VAULT_KEY.');
  try {
    const key = scryptSync(env.OWN_CODEX_VAULT_KEY, Buffer.from(record.salt, 'base64'), 32);
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64')); cipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(record.encrypted, 'base64')), cipher.final()]).toString('utf8');
  } catch { throw new Error('Encrypted credential authentication failed.'); }
}
export async function loadCredentials(provider, options = {}) {
  providerName(provider); const vault = await readVault(options); const ring = keyRing(vault.credentials[provider]);
  const records = [...ring.keys].sort((a, b) => Number(b.label === ring.active) - Number(a.label === ring.active));
  const keys = [];
  for (const record of records) keys.push({ label: record.label, apiKey: await decryptCredential(record, options) });
  return { keys, rotation: ring.rotation };
}
export async function loadCredential(provider, options = {}) { return (await loadCredentials(provider, options)).keys[0]?.apiKey || ''; }
export async function configureCredentials(provider, changes, options = {}) {
  providerName(provider);
  return updateVault(options, (vault) => {
    const ring = keyRing(vault.credentials[provider]);
    if (changes.active !== undefined) {
      if (!ring.keys.some((key) => key.label === changes.active)) throw new Error('Unknown key label. Use /auth status.');
      ring.active = changes.active;
    }
    if (changes.rotation !== undefined) {
      if (!['failover', 'round-robin', 'off'].includes(changes.rotation)) throw new Error('Rotation must be failover, round-robin, or off.');
      ring.rotation = changes.rotation;
    }
    vault.credentials[provider] = ring;
    return { provider, active: ring.active, rotation: ring.rotation };
  });
}
export async function vaultStatus(options = {}) {
  const vault = await readVault(options);
  return Object.entries(vault.credentials).map(([provider, value]) => {
    const ring = keyRing(value);
    return { provider, method: ring.keys.find((key) => key.label === ring.active)?.method, configured: Boolean(ring.keys.length),
      rotation: ring.rotation, keys: ring.keys.map((key) => ({ label: key.label, method: key.method, active: key.label === ring.active })) };
  });
}
export async function removeCredential(provider, options = {}) {
  providerName(provider);
  return updateVault(options, (vault) => {
    const ring = keyRing(vault.credentials[provider]);
    const removed = options.label ? ring.keys.some((key) => key.label === options.label) : Boolean(ring.keys.length);
    if (options.label) {
      ring.keys = ring.keys.filter((key) => key.label !== options.label);
      if (ring.active === options.label) ring.active = ring.keys[0]?.label;
    }
    if (!options.label || !ring.keys.length) delete vault.credentials[provider]; else vault.credentials[provider] = ring;
    return { provider, ...(options.label ? { label: options.label } : {}), removed };
  });
}
