import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCredentials } from './config-vault.js';

export const DEFAULT_BASE_URL = 'https://api.apinex.bond/v1';
export const DEFAULT_MODEL = 'free/claude-opus-4.6';

function stripTomlComment(line) {
  let quoted = '';
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted === '"') {
      escaped = true;
      continue;
    }
    if (character === quoted) {
      quoted = '';
      continue;
    }
    if (!quoted && (character === '"' || character === "'")) {
      quoted = character;
      continue;
    }
    if (character === '#' && !quoted) {
      return line.slice(0, index);
    }
  }

  return line;
}

function parseTomlValue(rawValue) {
  const value = rawValue.trim();
  if (!value) throw new Error('Missing config value.');

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch { throw new Error('Invalid quoted string in config.'); }
  }

  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(value)) return Number(value.replaceAll('_', ''));
  throw new Error('Config values must be quoted strings, booleans, or numbers.');
}

function keyParts(text) {
  const parts = text.match(/"(?:\\.|[^"\\])*"|'[^']*'|[\w-]+|\./g) || [];
  // Validate the gaps separately to preserve whitespace inside quoted names.
  let remaining = text;
  for (const part of parts) {
    remaining = remaining.trimStart();
    if (!remaining.startsWith(part)) throw new Error('Invalid config setting name.');
    remaining = remaining.slice(part.length);
  }
  if (remaining.trim() || !parts.length || parts.length % 2 === 0
    || parts.some((part, index) => index % 2 ? part !== '.' : part === '.')) {
    throw new Error('Invalid config setting name.');
  }
  return parts.filter((_, index) => index % 2 === 0).map((part) => {
    const key = /^["']/.test(part) ? parseTomlValue(part) : part;
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe config setting name.');
    return key;
  });
}

function setNestedValue(target, section, key, value) {
  const parts = [...section, ...keyParts(key)];
  let cursor = target;

  for (const part of parts.slice(0, -1)) {
    if (Object.hasOwn(cursor, part) && (typeof cursor[part] !== 'object' || cursor[part] === null)) {
      throw new Error('Conflicting config settings.');
    }
    if (!Object.hasOwn(cursor, part)) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }

  if (Object.hasOwn(cursor, parts.at(-1))) throw new Error('Duplicate config setting.');
  cursor[parts.at(-1)] = value;
}

export function parseToml(text) {
  const result = {};
  let section = [];

  for (const originalLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = stripTomlComment(originalLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = keyParts(sectionMatch[1]);
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) throw new Error('Invalid config line: expected key = value.');

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1);
    if (!key) throw new Error('Missing config setting name.');

    setNestedValue(result, section, key, parseTomlValue(rawValue));
  }

  return result;
}

async function readJsonIfPresent(filePath) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(contents.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Could not read ${filePath}: ${error.code || 'invalid JSON object'}`);
  }
}

async function readTextIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

export function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!String(value).trim() || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2147483647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647.`);
  }
  return parsed;
}

export function maskSecret(secret) {
  if (!secret) return '(missing)';
  return '********';
}

export function setupPaths({ env = process.env, homeDir = os.homedir() } = {}) {
  const ownDir = env.OWN_CODEX_HOME || path.join(homeDir, '.own-codex');
  return {
    configPath: path.resolve(env.OWN_CODEX_CONFIG_PATH || path.join(ownDir, 'config.toml')),
    authPath: path.resolve(env.OWN_CODEX_AUTH_PATH || path.join(ownDir, 'auth.json')),
  };
}

export async function loadConfig({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const { configPath, authPath } = setupPaths({ env, homeDir });

  const configText = await readTextIfPresent(configPath);
  const config = configText ? parseToml(configText) : {};
  const providerName = env.OWN_CODEX_PROVIDER ?? config.model_provider ?? 'apinex';
  if (typeof providerName !== 'string' || !providerName.trim()) throw new Error('model_provider must be a non-empty string.');
  const provider = Object.hasOwn(config.model_providers || {}, providerName) ? config.model_providers[providerName] : {};
  if (!provider || typeof provider !== 'object') throw new Error(`Invalid settings for provider ${providerName}.`);
  const defaults = { apinex: { url: DEFAULT_BASE_URL, key: 'APINEX_API_KEY', wire: 'responses' },
    openai: { url: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', wire: 'responses' },
    anthropic: { url: 'https://api.anthropic.com/v1', key: 'ANTHROPIC_API_KEY', wire: 'anthropic' },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta', key: 'GEMINI_API_KEY', wire: 'gemini' },
    ollama: { url: 'http://localhost:11434', wire: 'ollama' } }[providerName] || {};
  const baseUrl = env.OWN_CODEX_BASE_URL ?? provider.base_url ?? defaults.url;
  if (!baseUrl) throw new Error(`No base_url configured for provider ${providerName}.`);
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('base_url must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('base_url must use HTTP or HTTPS without credentials, query parameters, or a fragment.');
  }
  if (provider.env_key !== undefined && typeof provider.env_key !== 'string') throw new Error('env_key must be a string.');
  if (provider.requires_openai_auth !== undefined && typeof provider.requires_openai_auth !== 'boolean') {
    throw new Error('requires_openai_auth must be true or false.');
  }
  if (provider.api_version !== undefined && (typeof provider.api_version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(provider.api_version))) throw new Error('api_version must be a YYYY-MM-DD string.');

  const environmentKey = (provider.env_key ? env[provider.env_key] : undefined)
    || (defaults.key ? env[defaults.key] : undefined)
    || '';
  let vault = { keys: [], rotation: 'failover' };
  try { vault = await loadCredentials(providerName, { env, homeDir }); }
  catch (error) { if (!environmentKey) throw error; }
  const vaultKey = vault.keys[0]?.apiKey || '';
  const auth = environmentKey || vaultKey ? {} : await readJsonIfPresent(authPath) || {};
  const candidate = environmentKey || vaultKey || auth.OPENAI_API_KEY
    || auth.api_key
    || '';
  if (typeof candidate !== 'string') throw new Error('API key must be a string.');
  const apiKey = /^(?:PASTE[_ -]|YOUR[_ -]|REPLACE[_ -])/i.test(candidate.trim()) ? '' : candidate.trim();
  const model = env.OWN_CODEX_MODEL ?? config.model ?? (providerName === 'apinex' ? DEFAULT_MODEL : '');
  if (typeof model !== 'string' || !model.trim()) throw new Error('A non-empty model must be configured.');

  return {
    apiKey,
    apiKeys: [...(environmentKey && apiKey ? [{ label: '$environment', apiKey }] : []), ...vault.keys,
      ...(!environmentKey && !vaultKey && apiKey ? [{ label: '$auth-file', apiKey }] : [])]
      .filter((key, index, keys) => key.apiKey && keys.findIndex((item) => item.apiKey === key.apiKey) === index),
    keyRotation: vault.rotation,
    credentialPool: { active: 0, unavailable: new Map() },
    authPath,
    baseUrl: url.href.replace(/\/+$/, ''),
    configPath,
    configExists: configText !== null,
    credentialSource: environmentKey ? 'environment' : vaultKey ? 'encrypted-vault' : apiKey ? 'auth-file' : 'missing',
    maxOutputTokens: positiveInteger(
      env.OWN_CODEX_MAX_OUTPUT_TOKENS,
      4096,
      'OWN_CODEX_MAX_OUTPUT_TOKENS',
    ),
    timeoutMs: positiveInteger(env.OWN_CODEX_TIMEOUT_MS, 120000, 'OWN_CODEX_TIMEOUT_MS'),
    model: model.trim(),
    providerName,
    requiresOpenAiAuth: provider.requires_openai_auth ?? providerName !== 'ollama',
    wireApi: provider.wire_api || defaults.wire || 'responses',
    apiVersion: provider.api_version || '2023-06-01',
  };
}

export function configSummary(config) {
  return [
    `provider: ${config.providerName}`,
    `model: ${config.model}`,
    `base URL: ${config.baseUrl}`,
    `wire API: ${config.wireApi}`,
    `API key: ${config.apiKey ? 'configured' : 'missing'}`,
    `credential source: ${config.credentialSource || 'unknown'}`,
    `API keys: ${config.apiKeys?.length || Number(Boolean(config.apiKey))}; rotation: ${config.keyRotation || 'failover'}`,
    `config: ${config.configPath}${config.configExists ? '' : ' (using defaults; file missing)'}`,
    `auth: ${config.authPath}`,
  ].join('\n');
}

export async function writeSetupFiles({ homeDir = os.homedir(), env = process.env, force = false } = {}) {
  const { configPath, authPath } = setupPaths({ env, homeDir });
  if (configPath === authPath) throw new Error('Config and auth paths must be different.');

  const configContents = [
    `model = "${DEFAULT_MODEL}"`,
    'model_provider = "apinex"',
    '',
    '[model_providers.apinex]',
    'name = "APInex"',
    `base_url = "${DEFAULT_BASE_URL}"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n');

  const authContents = '{\n  "auth_mode": "apikey",\n  "OPENAI_API_KEY": "PASTE_YOUR_APINEX_KEY_HERE"\n}\n';

  const writes = [];
  const backups = [];
  for (const [filePath, contents] of [[configPath, configContents], [authPath, authContents]]) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      writes.push(filePath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!force) continue;
      const backupPath = `${filePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.bak`;
      await fs.copyFile(filePath, backupPath, 1);
      await fs.chmod(backupPath, 0o600);
      backups.push(backupPath);
      await fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 });
      writes.push(filePath);
    }
  }

  return { authPath, configPath, writes, backups };
}
