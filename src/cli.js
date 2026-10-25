#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { collectProjectContext } from './context.js';
import { configSummary, loadConfig, positiveInteger, writeSetupFiles } from './config.js';
import { createResponse, listModels } from './client.js';
import { formatModels } from './models.js';
import { workspacePrompt, buildUserMessage } from './prompt.js';
import { createRuntime } from './core/runtime.js';
import { compactHistory } from './core/compactor.js';
import { listSessions } from './session/store.js';
import { permissionMode } from './permissions/engine.js';
import { createProjectWorktree } from './runtime/worktrees.js';
import { serveMcp } from './server/mcp.js';
import { markdownWriter } from './tui/render.js';
import { storeCredential, vaultStatus, removeCredential } from './config-vault.js';
import { createSandbox } from './sandbox/index.js';
import { randomUUID } from 'node:crypto';
import { configureCredentials } from './config-vault.js';
import { createChatInput, safeTerminalText } from './tui/input.js';
import { createActivity } from './tui/activity.js';

const { version } = createRequire(import.meta.url)('../package.json');
const COMMANDS = ['ask', 'exec', 'chat', 'config', 'doctor', 'setup', 'context', 'models', 'sessions', 'undo', 'serve', 'auth', 'help'];
const HELP = `Own Codex ${version} — repository-aware coding assistant

Usage:
  own-codex ask "your coding request" [options]
  own-codex exec "task" --json [options]
  own-codex chat [options]
  own-codex models [--free] [--json]
  own-codex context [--json] [context options]
  own-codex config [--json]
  own-codex doctor [--live] [--json]
  own-codex setup [--force]
  own-codex sessions [--root <path>] [--json]
  own-codex undo --resume <session-id>
  own-codex serve [options]       MCP stdio server
  own-codex auth login|add|status|logout [--provider <name>] [--label <name>] [--stdin-key]
  own-codex auth use <label> | auth rotate <failover|round-robin|off>

This CLI can create folders and edit project files. Use --allow-run for local test/build commands.
Use "own-codex context" to see exactly what will be shared with the API.
Pipe a prompt into "own-codex ask", or use -- before literal prompt text.

Options:
  --root <path>                 Project root (default: current directory)
  --file <path>                 Include a file; repeatable, in priority order
  --dir <path>                  Include a directory; repeatable
  --no-context                  Skip initial snapshot; file tools remain available
  --all-context                 Load all eligible project text (up to 1M chars)
  --permissions <mode>          read-only, workspace (default), or all
  --allow-run                   Enable project editing and local commands
  --read-only                   Allow inspection without edits or commands
  --max-steps <number>          Maximum agent rounds per request (default: 20)
  -p <prompt>                   One-shot request (same as exec)
  --provider <name>             Choose a configured/native provider
  --resume <id|last>            Resume a project session
  --permission-mode <mode>      read-only, auto-edit, ask, or yolo
  --max-turns <number>          Alias for --max-steps
  --max-tokens <number>         Aggregate provider-reported token budget
  --max-ms <number>             Entire-turn wall-clock budget (default: 600000)
  --max-cost <dollars>          Conservative dollar reserve; requires --prices
  --prices <json-file>          Explicit per-million model rates
  --plan                       Read-only planning turn
  --plan-first                 Plan with read-only tools, then implement
  --planner-model <id>          Explicit model for planning
  --lookup-model <id>           Explicit model for read-only child agents
  --subagents                  Enable isolated Explore/Plan/Implement/Review children
  --worktree                   Start at committed HEAD in a new Git worktree
  --worktree-name <name>        Name the new worktree
  --policy <json-file>          Tool allow/deny/ask and command/path regex rules
  --sandbox <off|required>      Fail closed if a required OS sandbox is unavailable
  --mcp <json-file>             Explicit MCP stdio/HTTP server configuration
  --allow-host <host[:port]>    Enable web_fetch for this host; repeatable
  --jsonl                      Emit core events as JSON lines
  --no-session                 Disable on-disk session/audit recording
  --max-output-tokens <number>  Response budget (default: 4096)
  --max-context-chars <number>  Total context budget (default: 24000)
  --max-file-chars <number>     Per-file context budget (default: 6000)
  --model <name>                Override the configured model
  --timeout-ms <number>         Whole-request timeout (default: 120000)
  --no-stream                   Print the complete response
  --live                        Send a minimal request (doctor only)
  --json                        JSON output (ask/config/doctor/context/models)
  --free                        Show only free-tagged models (models only)
  --label <name>                Named API key (auth only)
  --force                       Back up and replace existing setup files
  --version, -v                 Show version
  --help, -h                    Show help

Config: %USERPROFILE%\\.own-codex\\config.toml and auth.json
Environment: APINEX_API_KEY, OPENAI_API_KEY, OWN_CODEX_HOME,
  OWN_CODEX_CONFIG_PATH, OWN_CODEX_AUTH_PATH, OWN_CODEX_PROVIDER,
  OWN_CODEX_MODEL, OWN_CODEX_BASE_URL, OWN_CODEX_MAX_OUTPUT_TOKENS,
  OWN_CODEX_TIMEOUT_MS
`;

export function parseArgs(argv) {
  const args = [...argv];
  let command = 'chat';
  if (COMMANDS.includes(args[0])) command = args.shift();
  else if (args[0] && !args[0].startsWith('-')) command = 'ask';
  const options = {
    directories: [], files: [], maxContextChars: 24000, maxFileChars: 6000,
    noContext: false, noStream: false, root: process.cwd(), permissions: 'workspace', maxSteps: 20, allowHosts: [],
  };
  const valueOptions = {
    '--root': 'root', '--file': 'files', '--dir': 'directories', '--model': 'model',
    '--max-output-tokens': 'maxOutputTokens', '--max-context-chars': 'maxContextChars',
    '--max-file-chars': 'maxFileChars', '--timeout-ms': 'timeoutMs', '--permissions': 'permissions', '--max-steps': 'maxSteps',
    '--provider': 'provider', '--resume': 'resume', '--permission-mode': 'permissions', '--max-turns': 'maxSteps', '-p': 'prompt',
    '--max-tokens': 'maxTokens', '--max-ms': 'maxMs', '--max-cost': 'maxCost', '--prices': 'prices', '--policy': 'policy',
    '--planner-model': 'plannerModel', '--lookup-model': 'lookupModel', '--worktree-name': 'worktreeName', '--sandbox': 'sandbox', '--mcp': 'mcp', '--allow-host': 'allowHosts', '--label': 'label',
  };
  const booleans = {
    '--help': 'help', '-h': 'help', '--version': 'version', '-v': 'version', '--no-context': 'noContext',
    '--no-stream': 'noStream', '--live': 'live', '--json': 'json', '--force': 'force', '--free': 'free',
    '--all-context': 'allContext', '--allow-run': 'allowRun', '--read-only': 'readOnly',
    '--plan': 'plan', '--plan-first': 'planFirst', '--subagents': 'subagents', '--worktree': 'worktree', '--jsonl': 'jsonl', '--no-session': 'noSession',
    '--stdin-key': 'stdinKey',
  };
  const seen = [];
  const prompt = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') { prompt.push(...args.slice(index + 1)); break; }
    const separator = argument.indexOf('=');
    const flag = separator > 0 ? argument.slice(0, separator) : argument;
    const inline = separator > 0 ? argument.slice(separator + 1) : undefined;
    if (Object.hasOwn(valueOptions, flag)) {
      const value = inline ?? args[++index];
      if (value === undefined || !value.trim() || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
      const key = valueOptions[flag];
      if (key === 'files' || key === 'directories') options[key].push(value);
      else if (key === 'allowHosts') options.allowHosts.push(value);
      else if (key === 'root') options.root = path.resolve(value);
      else if (key === 'maxCost') { options.maxCost = Number(value); if (!Number.isFinite(options.maxCost) || options.maxCost <= 0) throw new Error('--max-cost must be a positive number.'); }
      else if (['model', 'permissions', 'provider', 'resume', 'prompt', 'prices', 'policy', 'plannerModel', 'lookupModel', 'worktreeName', 'sandbox', 'mcp', 'label'].includes(key)) options[key] = value;
      else options[key] = positiveInteger(value, undefined, flag);
      if (key === 'maxContextChars') options.contextBudgetExplicit = true;
      if (key === 'maxFileChars') options.fileBudgetExplicit = true;
      seen.push(flag);
    } else if (Object.hasOwn(booleans, flag)) {
      if (inline !== undefined) throw new Error(`${flag} does not accept a value.`);
      options[booleans[flag]] = true;
      seen.push(flag);
    } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}. Use --help for available options.`);
    else prompt.push(argument);
  }
  if (command === 'exec') command = 'ask';
  if (options.prompt) { command = 'ask'; prompt.unshift(options.prompt); }
  options.permissions = permissionMode(options.permissions);
  if (!options.help && !options.version && command !== 'help') {
    if (!['read-only', 'workspace', 'all', 'ask'].includes(options.permissions)) throw new Error('--permissions must be read-only, workspace, ask, or all.');
    if (options.allowRun && options.readOnly) throw new Error('--allow-run and --read-only cannot be combined.');
    if (options.allowRun) options.permissions = 'all';
    if (options.readOnly) options.permissions = 'read-only';
    if (options.maxSteps > 100) throw new Error('--max-steps cannot exceed 100.');
    if (!['ask', 'auth'].includes(command) && prompt.length) throw new Error(`${command} does not accept prompt text. Use own-codex ask "your request".`);
    if (options.live && command !== 'doctor') throw new Error('--live is only valid for doctor.');
    if (options.force && command !== 'setup') throw new Error('--force is only valid for setup.');
    if (options.json && !['ask', 'config', 'doctor', 'context', 'models', 'sessions', 'undo', 'auth'].includes(command)) throw new Error(`--json is not supported for ${command}.`);
    if (options.stdinKey && (command !== 'auth' || !['login', 'add'].includes(prompt.join(' ').trim()))) throw new Error('--stdin-key is only valid for auth login or auth add.');
    if (options.label && command !== 'auth') throw new Error('--label is only valid for auth.');
    if (options.json && options.jsonl) throw new Error('--json and --jsonl cannot be combined.');
    if (options.jsonl && command !== 'ask') throw new Error('--jsonl is supported for ask/exec and -p one-shot requests.');
    if (options.noSession && options.resume) throw new Error('--resume cannot be combined with --no-session.');
    if (options.worktree && options.resume) throw new Error('Resume with the existing worktree root; --worktree creates a new session.');
    if (options.worktreeName && !options.worktree) throw new Error('--worktree-name requires --worktree.');
    if (options.sandbox && !['off', 'required'].includes(options.sandbox)) throw new Error('--sandbox must be off or required.');
    if (options.plan && options.planFirst) throw new Error('--plan and --plan-first cannot be combined.');
    if (options.free && command !== 'models') throw new Error('--free is only valid for models. Use /model free inside chat.');
    const contextFlags = ['--root', '--file', '--dir', '--no-context', '--all-context', '--max-context-chars', '--max-file-chars'];
    if (seen.some((flag) => contextFlags.includes(flag) && !(flag === '--root' && ['sessions', 'undo'].includes(command))) && !['ask', 'chat', 'context', 'serve'].includes(command)) {
      throw new Error(`Context options are not supported for ${command}.`);
    }
    if ((options.noContext && (options.files.length || options.directories.length || options.allContext))) throw new Error('--no-context cannot be combined with --file, --dir or --all-context.');
    if (seen.some((flag) => ['--permissions', '--permission-mode', '--allow-run', '--read-only', '--max-steps', '--max-turns'].includes(flag)) && !['ask', 'chat', 'serve'].includes(command)) {
      throw new Error(`Agent permission/step options are not supported for ${command}.`);
    }
    const apiFlags = ['--model', '--provider', '--max-output-tokens', '--timeout-ms', '--no-stream'];
    if (seen.some((flag) => apiFlags.includes(flag) && !(flag === '--provider' && command === 'auth')) && !['ask', 'chat', 'doctor', 'config', 'models', 'serve'].includes(command)) {
      throw new Error(`API options are not supported for ${command}.`);
    }
    const agentFlags = ['--max-tokens', '--max-ms', '--max-cost', '--prices', '--policy', '--plan', '--plan-first', '--planner-model', '--lookup-model', '--subagents', '--worktree', '--worktree-name', '--sandbox', '--mcp', '--allow-host', '--jsonl', '--no-session'];
    if (seen.some((flag) => agentFlags.includes(flag)) && !['ask', 'chat', 'serve'].includes(command)) throw new Error(`Agent options are not supported for ${command}.`);
    if (options.resume && !['ask', 'chat', 'undo'].includes(command)) throw new Error('--resume is only supported for ask/exec, chat, and undo.');
  }
  return { command, options, prompt: prompt.join(' ').trim() };
}

async function buildContext(options) {
  if (options.noContext) return { root: options.root, files: [], discoveredFiles: [], omittedFiles: [], truncatedFiles: [], warnings: [], text: '' };
  return collectProjectContext({
    directories: options.directories, files: options.files, root: options.root,
    maxChars: options.allContext && !options.contextBudgetExplicit ? 1000000 : options.maxContextChars,
    maxFileChars: options.allContext && !options.fileBudgetExplicit ? 200000 : options.maxFileChars,
    fullProject: options.allContext || false,
  });
}

function contextInfo(context) {
  const { text, ...info } = context;
  return { ...info, chars: text.length };
}

function contextNotice(context) {
  if (context.text) console.error(`Context: ${context.files.length} files, ${context.text.length} chars; ${context.truncatedFiles.length} excerpts, ${context.omittedFiles.length} omitted. Use "context --json" to inspect.`);
  for (const warning of context.warnings) console.error(`Warning: ${warning}`);
}

function configInfo(config) {
  return {
    apiKeyConfigured: Boolean(config.apiKey), authRequired: config.requiresOpenAiAuth,
    authPath: config.authPath, baseUrl: config.baseUrl, configPath: config.configPath,
    configExists: config.configExists, model: config.model, provider: config.providerName,
    maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs, wireApi: config.wireApi,
    credentialSource: config.credentialSource,
    keyCount: config.apiKeys?.length || Number(Boolean(config.apiKey)), keyRotation: config.keyRotation || 'failover',
  };
}

function responseNotice(result, config) {
  if (result.model && result.model !== config.model) console.error(`Response model reported by provider: ${result.model} (requested: ${config.model}).`);
}

async function interruptibleAgent(runtime, options) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  try { return await runtime.run({ ...options, signal: controller.signal }); }
  finally { process.removeListener('SIGINT', cancel); }
}

async function runModels({ config, options }) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  try {
    const models = await listModels({ config, signal: controller.signal });
    if (options.json) console.log(JSON.stringify({
      currentModel: config.model, provider: config.providerName,
      total: models.length, freeCount: models.filter((model) => model.pricing === 'free').length,
      models: options.free ? models.filter((model) => model.pricing === 'free') : models,
    }, null, 2));
    else console.log(formatModels(models, { currentModel: config.model, freeOnly: options.free }));
  } finally { process.removeListener('SIGINT', cancel); }
}

async function runDoctor({ config, live, json }) {
  const issues = [];
  if (config.requiresOpenAiAuth && !config.apiKey) issues.push('API key is missing or still a setup placeholder.');
  if (!['responses', 'chat', 'chat_completions', 'anthropic', 'gemini', 'ollama'].includes(config.wireApi)) issues.push(`Unsupported wire API: ${config.wireApi}.`);
  const report = { ...configInfo(config), ok: issues.length === 0, issues, live: live ? 'blocked' : 'not-run' };
  if (live && report.ok) {
    try {
      const result = await createResponse({
        config, maxOutputTokens: 16, messages: [{ content: 'Reply with OK only.', role: 'user' }], stream: false,
      });
      report.live = 'ok';
      report.preview = result.text.trim().slice(0, 80);
      if (result.model) report.responseModel = result.model;
    } catch (error) {
      report.ok = false; report.live = 'failed'; report.issues.push(error.message);
    }
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log([
    configSummary(config), `timeout: ${config.timeoutMs} ms`, `local checks: ${report.ok ? 'passed' : 'failed'}`,
    `live check: ${report.live}${report.preview ? ` (${report.preview})` : ''}`, ...report.issues.map((issue) => `Issue: ${issue}`),
  ].join('\n'));
  if (!report.ok) process.exitCode = 1;
}

function baseMessages(context, workspace) {
  return [
    { content: workspacePrompt(workspace), role: 'system' },
    ...(context.text ? [{ content: buildUserMessage('Repository snapshot for reference. Only files listed under FILE have supplied contents.\n'
      + `Excerpted files: ${context.truncatedFiles.join(', ') || 'none'}. Omitted files: ${context.omittedFiles.length}.`, context.text), role: 'user' }] : []),
  ];
}

function toolNotice(event) {
  if (!event.ok) { console.error(`[${event.name}] failed: ${event.error || event.stderr || `exit ${event.exitCode}`}`); return; }
  if (event.name === 'run_command') console.error(`[run_command] ${event.command} ${event.args.join(' ')} — exit ${event.exitCode}`);
  else if (event.path) console.error(`[${event.name}] ${event.path}${event.action ? ` — ${event.action}` : ''}`);
  else if (event.summary) console.error(`[${event.name}] ${event.role} completed${event.worktree ? ` in ${event.worktree.root}` : ''}`);
  else if (event.items) console.error(`[${event.name}] ${event.items.length} tasks`);
  else if (event.url) console.error(`[${event.name}] ${event.url}${event.truncated ? ' (excerpt)' : ''}`);
  else if (event.artifactId) console.error(`[${event.name}] ${event.artifactId}${event.truncated ? ' (excerpt)' : ''}`);
  else if (event.entries || event.matches) console.error(`[${event.name}] ${event.entries ? `${event.entries.length} entries` : `${event.matches.length} matches`}${event.truncated ? ' (truncated)' : ''}`);
  else console.error(`[${event.name}] completed`);
}

function presentEvent(event, writer, options, activity) {
  activity?.event(event);
  if (event.type === 'token.delta') writer?.delta(event.data.delta);
  if (event.type === 'tool.completed') toolNotice({ name: event.data.name, ...event.data.result });
  if (event.type === 'plan.saved' && options.planFirst) console.error(`Plan:\n${event.data.text}`);
  if (event.type === 'subagent.started') console.error(`[subagent] ${event.data.role}; requested model: ${event.data.model}`);
  if (event.type === 'credential.switched') {
    console.error(`[auth] ${safeTerminalText(event.data.from)} → ${safeTerminalText(event.data.to)} (${event.data.status}: ${event.data.reason})`);
    activity?.start(`Thinking / processing · key ${event.data.to}`);
  }
}

async function approveAction(action, input) {
  if (!process.stdin.isTTY) return 'deny';
  console.error(`\nApproval needed: ${action.name}\n${action.preview}`);
  let temporary;
  try {
    if (!input) temporary = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = 'Approve [y] once, [a] for this target/session, [n] deny? ';
    const answer = input ? await input.readLine(prompt, { signal: action.signal }) : await temporary.question(prompt, { signal: action.signal });
    return answer?.toLowerCase() === 'a' ? 'session' : answer?.toLowerCase() === 'y' ? 'once' : 'deny';
  } finally { temporary?.close(); }
}
async function readSecret(stdinKey) {
  if (stdinKey) {
    let text = '';
    for await (const chunk of process.stdin) { text += chunk.toString(); if (text.length > 64000) throw new Error('Credential is too long.'); }
    return text.trim();
  }
  if (!process.stdin.isTTY) throw new Error('Use --stdin-key to provide a credential on stdin. Never put the key in command arguments.');
  return new Promise((resolve, reject) => {
    let text = ''; const wasRaw = process.stdin.isRaw; const wasPaused = process.stdin.isPaused();
    process.stderr.write('API key: '); process.stdin.setRawMode(true); process.stdin.resume();
    const finish = (error) => { process.stdin.removeListener('data', receive); process.stdin.setRawMode(Boolean(wasRaw)); if (wasPaused) process.stdin.pause(); process.stderr.write('\n'); error ? reject(error) : resolve(text); };
    const receive = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { finish(new Error('Credential entry cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\b' || character === '\u007f') { if (text) { text = text.slice(0, -1); process.stderr.write('\b \b'); } }
        else if (character >= ' ' && text.length < 64000) { text += character; process.stderr.write('*'); }
      }
    };
    process.stdin.on('data', receive);
  });
}
function showStatus(accounting) {
  if (!accounting) return 'No model usage recorded in this process yet.';
  const tokens = accounting.usageComplete ? accounting.breakdownComplete ? `${accounting.totalTokens} total; ${accounting.inputTokens} input / ${accounting.outputTokens} output / ${accounting.cachedTokens} cached`
    : `${accounting.totalTokens} total (input/output breakdown unavailable)` : 'unavailable or incomplete';
  return `Tokens: ${tokens}. Provider-reported cost: ${accounting.reportedCost === null ? 'unavailable' : '$' + accounting.reportedCost.toFixed(6)}.`
    + (accounting.computedCost === null ? '' : ` Computed from configured rates: $${accounting.computedCost.toFixed(6)}.`);
}

function authStatus(config, entries) {
  const pool = config.credentialPool;
  return { provider: config.providerName, rotation: config.keyRotation || 'failover', source: config.credentialSource,
    keys: (config.apiKeys || []).map((key, index) => {
      const until = pool?.unavailable.get(key.label) || 0;
      return { label: key.label, active: index === (pool?.active || 0), state: until === Infinity ? 'rejected' : until > Date.now() ? 'cooldown' : 'available' };
    }), vault: entries.filter((entry) => entry.provider === config.providerName) };
}

async function chatAuth({ prompt, config, input, signal }) {
  let [, action, argument, ...extra] = prompt.split(/\s+/);
  if (extra.length) throw new Error('Use /auth add [label], then enter the key at the private prompt. Inline keys are not accepted.');
  if (!action || action === 'status') {
    console.log(JSON.stringify(authStatus(config, await vaultStatus()), null, 2));
    if (action || !input.terminal) return false;
    console.log('add [label] · use <label> · next · rotate <failover|round-robin|off> · remove <label>');
    const answer = await input.readLine('auth (blank to return)> ', { signal });
    if (!answer?.trim()) return false;
    [action, argument, ...extra] = answer.trim().split(/\s+/);
    if (extra.length) throw new Error('Enter the API key only at the private prompt.');
  }
  const reload = async () => {
    const fresh = await loadConfig({ env: { ...process.env, OWN_CODEX_PROVIDER: config.providerName, OWN_CODEX_MODEL: config.model } });
    for (const key of ['apiKey', 'apiKeys', 'keyRotation', 'credentialPool', 'credentialSource']) config[key] = fresh[key];
  };
  if (['add', 'enter', 'login'].includes(action)) {
    if (!input.terminal) throw new Error('Use auth add --stdin-key for scripts; /auth never reads API keys from chat lines.');
    const label = argument || (action === 'login' ? 'default' : 'key-' + randomUUID().slice(0, 8));
    const secret = await input.readLine(`API key for ${config.providerName} / ${label} (hidden; Ctrl+C cancels): `, { secret: true, signal });
    if (secret === null || signal?.aborted) throw new Error('Credential entry cancelled.');
    const result = await storeCredential(config.providerName, secret, { label, add: action !== 'login', signal });
    await reload();
    console.log(`Encrypted key saved as ${result.label}. ${config.apiKeys.length} keys available; rotation: ${config.keyRotation}.`);
    return true;
  }
  if (action === 'rotate') {
    const rotation = ({ on: 'failover', auto: 'failover' })[argument] || argument;
    await configureCredentials(config.providerName, { rotation: rotation || 'failover' });
    await reload(); console.log(`API key rotation: ${config.keyRotation}.`); return true;
  }
  if (action === 'use' || action === 'next') {
    const index = action === 'next' ? ((config.credentialPool?.active || 0) + 1) % Math.max(1, config.apiKeys.length) : config.apiKeys.findIndex((key) => key.label === argument);
    if (!config.apiKeys[index]) throw new Error('Unknown key label. Use /auth status.');
    const selected = config.apiKeys[index];
    if (!selected.label.startsWith('$')) await configureCredentials(config.providerName, { active: selected.label });
    config.credentialPool.active = index; config.credentialPool.unavailable.delete(selected.label);
    console.log(`Active key: ${selected.label} (key value hidden).`); return true;
  }
  if (action === 'remove' || action === 'logout') {
    if (!argument) throw new Error('Use /auth remove <label>. Environment/auth-file keys must be changed at their source.');
    const result = await removeCredential(config.providerName, { label: argument });
    await reload(); console.log(result.removed ? `Removed encrypted key ${argument}.` : 'No saved key with that label.'); return true;
  }
  throw new Error('Use /auth add [label], status, use <label>, next, rotate <mode>, or remove <label>.');
}

export async function pickModel(models, { config, input, freeOnly, signal, print = console.log }) {
  let query = ''; let page = 0;
  while (true) {
    const filtered = models.filter((model) => (!freeOnly || model.pricing === 'free') && model.id.toLowerCase().includes(query.toLowerCase()));
    page = Math.max(0, Math.min(page, Math.ceil(filtered.length / 20) - 1));
    print(`\nModels: ${filtered.length} matches${freeOnly ? ' · FREE filter' : ''} · current: ${safeTerminalText(config.model)}`);
    for (const [index, model] of filtered.slice(page * 20, page * 20 + 20).entries()) print(`${page * 20 + index + 1}. ${model.id === config.model ? '* ' : ''}[${model.pricing.toUpperCase()}] ${safeTerminalText(model.id)}`);
    print('Enter number/model ID, search text, :free, :all, :next, :prev; blank cancels.');
    const answer = (await input.readLine('model> ', { signal }))?.trim();
    if (!answer) return null;
    if (/^\d+$/.test(answer) && filtered[Number(answer) - 1]) return filtered[Number(answer) - 1].id;
    if (filtered.some((model) => model.id === answer)) return answer;
    if (answer === ':free' || answer === ':all') { freeOnly = answer === ':free'; query = ''; page = 0; }
    else if (answer === ':next') page += 1;
    else if (answer === ':prev') page -= 1;
    else { query = answer; page = 0; }
  }
}

async function runAsk({ prompt, options, config }) {
  if (!prompt && !process.stdin.isTTY) {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1048576) throw new Error('Piped prompt exceeds 1 MiB.');
      chunks.push(chunk);
    }
    prompt = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (!prompt) throw new Error('Ask requires a prompt. Example: own-codex ask "Explain this project"');
  const context = await buildContext(options);
  const writer = markdownWriter((text) => process.stdout.write(text), process.stdout.isTTY);
  const activity = createActivity({ enabled: process.stdout.isTTY && process.stderr.isTTY && !options.json && !options.jsonl });
  let runtime;
  runtime = await createRuntime({ config, options, approve: (action) => approveAction(action),
    onEvent: options.jsonl ? (event) => console.log(JSON.stringify({ ...event, sessionId: runtime?.session?.id || null }))
      : options.json ? undefined : (event) => presentEvent(event, writer, options, activity) });
  const workspace = runtime.workspace;
  try {
  if (!options.json && !options.jsonl && ['failed', 'interrupted'].includes(runtime.resumeState)) console.error(`Resumed a ${runtime.resumeState} turn. Completed file changes remain on disk; inspect the session log or use undo to review recovery.`);
  if (!options.json && !options.jsonl) contextNotice(context);
  const streaming = !options.noStream && !options.json;
  const history = compactHistory(runtime.history);
  const result = await interruptibleAgent(runtime, {
    messages: [...baseMessages(context, workspace), ...(history.summary ? [{ role: 'user', content: history.summary }] : []), ...history.recent, { content: prompt, role: 'user' }],
    stream: streaming,
  });
  writer.flush();
  if (options.json) console.log(JSON.stringify({ text: result.text, model: result.model || null, requestedModel: config.model, usage: result.usage || null,
    changes: result.changes, commands: result.commands, steps: result.steps, context: contextInfo(context), accounting: result.accounting, sessionId: result.sessionId, resumeState: runtime.resumeState }, null, 2));
  else if (!options.jsonl) { if (!streaming) process.stdout.write(result.text); process.stdout.write('\n'); }
  if (!options.json && !options.jsonl) { responseNotice(result, config); if (process.stdout.isTTY) console.error(showStatus(result.accounting)); }
  } finally { activity.stop(); await runtime.close(); }
}

async function runChat({ options, config }) {
  let context = await buildContext(options);
  let writer;
  let input;
  const activity = createActivity({ enabled: process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY });
  const runtime = await createRuntime({ config, options, approve: (action) => approveAction(action, input),
    onEvent: (event) => presentEvent(event, writer, options, activity) });
  const workspace = runtime.workspace;
  let history = runtime.history;
  let accounting;
  let modelCatalog;
  input = createChatInput({ getModels: () => modelCatalog || [] });
  let activeRequest;
  const cancel = () => { if (activeRequest) activeRequest.abort(); else input.close(); };
  input.rl.on('SIGINT', cancel);
  process.on('SIGINT', cancel);
  console.error(`Own Codex chat — ${workspace.permissions} permissions; project root: ${workspace.root}. /help for commands, /exit to quit.`);
  if (process.stdin.isTTY && runtime.session) console.error(`Session: ${runtime.session.id}. Resume with: own-codex chat --resume ${runtime.session.id}`);
  if (['failed', 'interrupted'].includes(runtime.resumeState)) console.error(`Previous turn ${runtime.resumeState}; completed file changes remain. Inspect /tools and /diff, or use /undo.`);
  contextNotice(context);
  try {
    while (true) {
      const line = await input.readLine('\nyou> ');
      if (line === null) break;
      let prompt = line.trim();
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      if (prompt === '/help') { console.log('/help  /auth [add|status|use|next|rotate|remove]  /context [all|auto|none|refresh]  /permissions [read-only|workspace|ask|all]  /config  /model [free|<id>]  /plan <task>  /todos  /status  /session  /sessions  /undo  /diff  /tools  /clear  /exit\nType / for live suggestions; Tab completes commands and cached model IDs.'); continue; }
      if (/^\/auth(?:\s|$)/.test(prompt)) {
        try {
          activeRequest = new AbortController();
          const changed = await chatAuth({ prompt, config, input, signal: activeRequest.signal });
          if (changed) modelCatalog = undefined;
        } catch (error) { console.error(`Error: ${error.message}`); if (!process.stdin.isTTY) process.exitCode = 1; }
        finally { activeRequest = undefined; }
        continue;
      }
      if (prompt === '/status') { console.log(showStatus(accounting)); continue; }
      if (prompt === '/session') { console.log(runtime.session ? JSON.stringify({ id: runtime.session.id, directory: runtime.session.directory }, null, 2) : 'Session recording is disabled.'); continue; }
      if (prompt === '/sessions') { console.log(JSON.stringify(await listSessions(options.root), null, 2)); continue; }
      if (prompt === '/todos') { console.log(JSON.stringify(workspace.todos, null, 2)); continue; }
      if (prompt === '/tools') { console.log(JSON.stringify(runtime.session?.events.filter((event) => event.type === 'tool.completed').slice(-20).map((event) => event.data) || [], null, 2)); continue; }
      if (prompt === '/diff') { console.log(runtime.session?.events.filter((event) => event.type === 'file.diff').slice(-5).map((event) => `Proposed diff (check tool receipts for execution):\n${event.data.diff}`).join('\n\n') || 'No file diffs recorded.'); continue; }
      if (prompt === '/undo') {
        try { const result = await runtime.undo(); console.log(JSON.stringify(result, null, 2)); context = await buildContext(options); history = runtime.session?.history() || history; }
        catch (error) { console.error(`Error: ${error.message}`); if (!process.stdin.isTTY) process.exitCode = 1; }
        continue;
      }
      if (/^\/context(?:\s|$)/.test(prompt)) {
        const argument = prompt.slice('/context'.length).trim();
        if (!argument) { console.log(JSON.stringify({ mode: options.noContext ? 'none' : options.allContext ? 'all' : 'auto', ...contextInfo(context) }, null, 2)); continue; }
        if (!['all', 'auto', 'none', 'refresh'].includes(argument)) { console.error('Usage: /context [all|auto|none|refresh]'); continue; }
        try {
          const next = { ...options };
          if (argument !== 'refresh') { next.noContext = argument === 'none'; next.allContext = argument === 'all'; next.files = []; next.directories = []; }
          const updated = await buildContext(next);
          Object.assign(options, next); context = updated;
          console.log(`Context mode: ${options.noContext ? 'none' : options.allContext ? 'all' : 'auto'}. ${context.files.length} files loaded; ${context.omittedFiles.length} omitted, ${context.truncatedFiles.length} excerpted.`);
          contextNotice(context);
        } catch (error) { console.error(`Error: ${error.message}`); if (!process.stdin.isTTY) process.exitCode = 1; }
        continue;
      }
      if (/^\/permissions(?:\s|$)/.test(prompt)) {
        const mode = permissionMode(prompt.slice('/permissions'.length).trim());
        if (!mode) console.log(`Permissions: ${workspace.permissions}. Project file tools stay inside ${workspace.root}. Commands require all permissions.`);
        else if (!['read-only', 'workspace', 'all', 'ask'].includes(mode)) console.error('Usage: /permissions [read-only|workspace|ask|all]');
        else { workspace.permissions = mode; console.log(`Permissions set to ${mode}.${mode === 'all' ? ' Local commands run with your account permissions.' : ''}`); }
        continue;
      }
      if (prompt === '/config') { console.log(configSummary(config)); continue; }
      if (prompt === '/clear') { history = []; await runtime.events.emit('conversation.cleared'); console.log('Conversation cleared; repository snapshot retained.'); continue; }
      if (/^\/models?(?:\s|$)/.test(prompt)) {
        const [, argument, ...extra] = prompt.split(/\s+/);
        if (extra.length) { console.error('Usage: /model, /model free, or /model <id>'); continue; }
        try {
          activeRequest = new AbortController();
          if (!argument || argument === 'free' || !modelCatalog) {
            activity.start('Loading provider model catalog');
            try { modelCatalog = await listModels({ config, signal: activeRequest.signal,
              onCredential: (change) => { activity.stop(); console.error(`[auth] ${change.from} → ${change.to} (${change.status})`); activity.start('Loading provider model catalog'); } }); }
            finally { activity.stop(); }
          }
          if (!argument || argument === 'free') {
            if (input.terminal) {
              const selected = await pickModel(modelCatalog, { config, input, freeOnly: argument === 'free', signal: activeRequest.signal });
              if (selected) { config.model = selected; console.log(`Current model set to ${config.model} (this session only).`); }
            } else console.log(formatModels(modelCatalog, { currentModel: config.model, freeOnly: argument === 'free' }));
          }
          else if (!modelCatalog.some((model) => model.id === argument)) {
            throw new Error(`Model not found in the provider catalog: ${argument}. Use /model to refresh the list.`);
          } else {
            config.model = argument;
            console.log(`Current model set to ${config.model} (this session only).`);
          }
        } catch (error) {
          console.error(`\nError: ${error.message}`);
          if (!process.stdin.isTTY) process.exitCode = 1;
        } finally { activeRequest = undefined; }
        continue;
      }
      const planOnly = prompt.startsWith('/plan ');
      if (planOnly) prompt = prompt.slice(6).trim();
      if (prompt.startsWith('/')) { console.error(`Unknown chat command: ${prompt}. Use /help.`); continue; }
      try {
        const compacted = compactHistory(history, { recentTurns: 5 });
        const pending = [...(compacted.summary ? [{ role: 'user', content: compacted.summary }] : []), ...compacted.recent, { content: prompt, role: 'user' }];
        if (process.stdin.isTTY) process.stdout.write('\nown> ');
        activeRequest = new AbortController();
        writer = markdownWriter((text) => process.stdout.write(text), process.stdout.isTTY);
        const result = await runtime.run({
          messages: [...baseMessages(context, workspace), ...pending], stream: !options.noStream, planOnly: planOnly || options.plan,
          signal: activeRequest.signal,
        });
        writer.flush();
        if (options.noStream) process.stdout.write(result.text);
        process.stdout.write('\n');
        responseNotice(result, config);
        history.push({ role: 'user', content: prompt }, { content: result.text, role: 'assistant' });
        accounting = result.accounting;
        if (process.stdout.isTTY) console.error(showStatus(accounting));
      } catch (error) {
        console.error(`\nError: ${error.message}`);
        if (error.accounting) accounting = error.accounting;
        if (!process.stdin.isTTY) process.exitCode = 1;
      } finally {
        activity.stop();
        activeRequest = undefined;
        if (workspace.changes.length && !options.noContext) {
          try { context = await buildContext(options); } catch (error) { console.error(`Context refresh failed: ${error.message}`); }
        }
      }
    }
  } finally { activity.stop(); process.removeListener('SIGINT', cancel); input.close(); await runtime.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const { command, options } = parsed;
  if (options.help || command === 'help') { console.log(HELP); return; }
  if (options.version) { console.log(version); return; }
  if (command === 'auth') {
    const [action = 'status', argument, ...extra] = parsed.prompt.split(/\s+/).filter(Boolean);
    const provider = options.provider || process.env.OWN_CODEX_PROVIDER || 'apinex';
    if (extra.length) throw new Error('Do not pass API keys in command arguments; use the private prompt or --stdin-key.');
    let result;
    if (action === 'status' && !argument) result = await vaultStatus();
    else if (['login', 'add'].includes(action) && !argument) result = await storeCredential(provider, await readSecret(options.stdinKey),
      { label: options.label || (action === 'add' ? 'key-' + randomUUID().slice(0, 8) : 'default'), add: action === 'add' });
    else if (action === 'logout' && !argument) result = await removeCredential(provider, { label: options.label });
    else if (action === 'use' && argument) result = await configureCredentials(provider, { active: argument });
    else if (action === 'rotate' && argument) result = await configureCredentials(provider, { rotation: ({ on: 'failover' })[argument] || argument });
    else throw new Error('Usage: auth login|add|status|logout [--label name] [--stdin-key], auth use <label>, or auth rotate <mode>.');
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === 'setup') {
    const result = await writeSetupFiles({ force: options.force });
    console.log(result.writes.length ? `Created:\n${result.writes.join('\n')}` : 'Config files already exist; nothing changed.');
    if (result.backups.length) console.log(`Backups:\n${result.backups.join('\n')}`);
    console.log(`Set your API key in ${result.authPath}, review the model and endpoint, then run: own-codex doctor --live`);
    return;
  }
  if (command === 'context') {
    const context = await buildContext(options);
    if (options.json) console.log(JSON.stringify({ ...contextInfo(context), text: context.text }, null, 2));
    else { contextNotice(context); console.log(context.text || '(No repository context loaded.)'); }
    return;
  }
  if (command === 'sessions') {
    const sessions = await listSessions(options.root);
    console.log(options.json ? JSON.stringify(sessions, null, 2) : sessions.map((item) => `${item.id}  ${item.updated}  ${item.turns} turns  ${item.lastPrompt}`).join('\n') || 'No saved sessions for this project.');
    return;
  }
  if (options.resume === 'last' || command === 'undo' && !options.resume) {
    const sessions = await listSessions(options.root);
    if (!sessions.length) throw new Error('No saved sessions for this project.');
    options.resume = sessions[0].id;
  }
  if (command === 'undo') {
    const runtime = await createRuntime({ options });
    try { const result = await runtime.undo(); console.log(options.json ? JSON.stringify(result, null, 2) : result.message || `Restored: ${result.restored.join(', ')}`); }
    finally { await runtime.close(); }
    return;
  }
  if (options.worktree) {
    await createSandbox({ mode: options.sandbox || 'off', root: options.root });
    const worktree = await createProjectWorktree(options.root, { name: options.worktreeName });
    options.root = worktree.root;
    console.error(`Worktree: ${worktree.root}\nBranch: ${worktree.branch}; starts at committed HEAD. Uncommitted files remain in the original checkout.`);
  }
  const config = await loadConfig({ env: { ...process.env,
    ...(options.provider ? { OWN_CODEX_PROVIDER: options.provider } : {}), ...(options.model ? { OWN_CODEX_MODEL: options.model } : {}) } });
  for (const key of ['maxOutputTokens', 'model', 'timeoutMs']) if (options[key] !== undefined) config[key] = options[key];
  if (command === 'serve') {
    await serveMcp({ run: async (prompt, signal) => {
      const context = await buildContext(options);
      const runtime = await createRuntime({ config, options });
      try { const result = await runtime.run({ messages: [...baseMessages(context, runtime.workspace), { role: 'user', content: prompt }], stream: false, signal });
        return { text: result.text, changes: result.changes, commands: result.commands, sessionId: result.sessionId, accounting: result.accounting }; }
      finally { await runtime.close(); }
    } });
  } else if (command === 'config') {
    console.log(options.json ? JSON.stringify(configInfo(config), null, 2) : `${configSummary(config)}\ntimeout: ${config.timeoutMs} ms`);
  } else if (command === 'doctor') await runDoctor({ config, json: options.json, live: options.live });
  else if (command === 'models') await runModels({ config, options });
  else if (command === 'ask') await runAsk({ config, options, prompt: parsed.prompt });
  else await runChat({ config, options });
}

function isEntrypoint() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isEntrypoint()) {
  process.stdout.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(0);
    else { console.error(`Output error: ${error.code || error.message}`); process.exit(1); }
  });
  main().catch((error) => {
    console.error(process.argv.includes('--json') || process.argv.includes('--jsonl') ? JSON.stringify({ error: error.message, ...(error.accounting ? { accounting: error.accounting } : {}) }) : `\nError: ${error.message}`);
    process.exitCode = 1;
  });
}
