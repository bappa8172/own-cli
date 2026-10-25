import { positiveInteger } from './config.js';
import { normalizeModels } from './models.js';
import { nativeResponse } from './providers/native.js';
import { withCredentials } from './providers/credentials.js';
import { httpError, sanitizedError } from './providers/errors.js';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type && !['output_text', 'text', 'refusal'].includes(part.type)) return '';
    if (typeof part?.text === 'string') return part.text;
    return typeof part?.refusal === 'string' ? part.refusal : '';
  }).join('');
}

export function extractResponseText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  const response = payload.response || payload;
  if (typeof response.output_text === 'string') return response.output_text;
  if (Array.isArray(response.output)) {
    return response.output.map((item) => {
      if (typeof item === 'string') return item;
      if (item?.type && !['message', 'output_text', 'text'].includes(item.type)) return '';
      return contentText(item.content) || (typeof item.text === 'string' ? item.text : '');
    }).join('');
  }
  const message = response.choices?.[0]?.message;
  return contentText(message?.content) || (typeof message?.refusal === 'string' ? message.refusal : '');
}

export function extractStreamDelta(payload) {
  if (!payload || (payload.type && !payload.choices && !['response.output_text.delta', 'response.refusal.delta'].includes(payload.type))) return '';
  if (typeof payload.delta === 'string') return payload.delta;
  if (typeof payload.output_text?.delta === 'string') return payload.output_text.delta;
  if (typeof payload.response?.output_text?.delta === 'string') return payload.response.output_text.delta;
  const delta = payload.choices?.[0]?.delta;
  return contentText(delta?.content) || (typeof delta?.refusal === 'string' ? delta.refusal : '');
}

function redact(message, secret) {
  let text = String(message);
  if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').slice(0, 2000);
}

function failure(payload) {
  const response = payload?.response || payload;
  if (payload?.error || response?.error || ['failed', 'cancelled', 'incomplete'].includes(response?.status)
    || ['error', 'response.failed', 'response.incomplete'].includes(payload?.type)) {
    const detail = payload.error || response.error;
    return typeof detail === 'string' ? detail : detail?.message
      || `Response ${response?.status || payload.type}: ${response?.incomplete_details?.reason || 'provider did not complete the answer'}`;
  }
  const choice = response?.choices?.[0];
  if (choice && ['length', 'content_filter'].includes(choice.finish_reason)) {
    return `Response incomplete: ${choice.finish_reason}. Increase --max-output-tokens if the answer reached its limit.`;
  }
  return '';
}

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function extractToolCalls(payload) {
  const response = payload?.response || payload;
  if (Array.isArray(response?.output) && response.output.some((item) => item.type === 'function_call' && item.status && item.status !== 'completed')) {
    throw new Error('The API returned an incomplete function call. No action can be executed.');
  }
  const calls = Array.isArray(response?.output)
    ? response.output.filter((item) => item.type === 'function_call').map((item) => ({ id: item.call_id || item.id, name: item.name, arguments: item.arguments }))
    : (response?.choices?.[0]?.message?.tool_calls || []).map((item) => ({ id: item.id, name: item.function?.name, arguments: item.function?.arguments }));
  const ids = new Set();
  for (const call of calls) {
    if (typeof call.id !== 'string' || !call.id || ids.has(call.id)
      || typeof call.name !== 'string' || !call.name || typeof call.arguments !== 'string') {
      throw new Error('The API returned an invalid or duplicate function call.');
    }
    ids.add(call.id);
  }
  return calls;
}

function requestDetails(config, messages, outputLimit, stream, tools) {
  const wire = config.wireApi || 'responses';
  if (!['responses', 'chat', 'chat_completions'].includes(wire)) throw new Error(`Unsupported wire API: ${wire}. Use responses or chat.`);
  const url = new URL(config.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid API base URL. Use HTTP or HTTPS without credentials, query parameters, or a fragment.');
  }
  const base = url.href.replace(/\/+$/, '');
  const endpoint = wire === 'responses' ? '/responses' : '/chat/completions';
  if (/\/(responses|chat\/completions)$/.test(base) && !base.endsWith(endpoint)) {
    throw new Error('API endpoint does not match wire_api. Configure the provider base URL, usually ending in /v1.');
  }
  const payload = wire === 'responses' ? {
    input: messages.filter((message) => !['system', 'developer'].includes(message.role)),
    instructions: messages.filter((message) => ['system', 'developer'].includes(message.role)).map((message) => message.content).join('\n') || undefined,
    max_output_tokens: outputLimit,
    model: config.model, store: false, stream,
  } : { messages, max_tokens: outputLimit, model: config.model, stream };
  if (tools.length) {
    payload.tools = tools.map((tool) => wire === 'responses'
      ? { type: 'function', ...tool, strict: false }
      : { type: 'function', function: { ...tool, strict: false } });
    payload.parallel_tool_calls = false;
  }
  return { url: base.endsWith(endpoint) ? base : base + endpoint, payload };
}

export async function listModels(options = {}) {
  return withCredentials(options, (config) => listModelsOnce({ ...options, config }));
}
async function listModelsOnce({ config, fetchImpl = fetch, timeoutMs = config?.timeoutMs ?? 120000, signal } = {}) {
  if (!config?.apiKey && config?.requiresOpenAiAuth !== false) {
    throw new Error(`Missing API key. Run own-codex setup and edit ${config?.authPath || '~/.own-codex/auth.json'}, or set APINEX_API_KEY.`);
  }
  positiveInteger(timeoutMs, 120000, 'timeoutMs');
  const url = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid API base URL for model discovery.');
  }
  const native = config.wireApi;
  url.pathname = native === 'ollama' ? url.pathname.replace(/\/(api|api\/chat)\/?$/, '').replace(/\/+$/, '') + '/api/tags'
    : url.pathname.replace(/\/+$/, '').replace(/\/(responses|chat\/completions|models|messages)$/, '') + '/models';
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Model listing cancelled.'));
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Model listing timed out after ${timeoutMs} ms.`)), timeoutMs);
  const entries = [];
  const cursors = new Set();
  let body;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    for (let page = 0; page < 100; page += 1) {
      const headers = { accept: 'application/json' };
      if (config.apiKey) {
        if (native === 'anthropic') { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = config.apiVersion || '2023-06-01'; }
        else if (native === 'gemini') headers['x-goog-api-key'] = config.apiKey;
        else headers.authorization = `Bearer ${config.apiKey}`;
      }
      const response = await abortable(fetchImpl(url.href, {
        method: 'GET', headers, signal: controller.signal, redirect: 'error',
      }), controller.signal);
      body = response.body;
      const text = await abortable(response.text(), controller.signal);
      if (!response.ok) throw httpError(response, text, 'Model listing failed');
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error('The models endpoint returned invalid JSON.'); }
      if (payload?.error) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error.message || 'Model listing failed.');
      const data = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
      if (!Array.isArray(data)) throw new Error('The models endpoint must return a data or models array.');
      entries.push(...data.map((entry) => entry && typeof entry === 'object' && !entry.id && entry.name ? { ...entry, id: native === 'gemini' ? entry.name.replace(/^models\//, '') : entry.name } : entry));
      if (entries.length > 10000) throw new Error('Model listing exceeded 10000 entries.');
      if (!payload.has_more && !payload.nextPageToken) return normalizeModels(entries);
      const after = payload.nextPageToken ?? payload.last_id ?? data.at(-1)?.id;
      if (typeof after !== 'string' || !after || cursors.has(after)) throw new Error('Invalid pagination cursor in the model catalog.');
      cursors.add(after);
      url.searchParams.set(native === 'gemini' ? 'pageToken' : native === 'anthropic' ? 'after_id' : 'after', after);
    }
    throw new Error('Model listing exceeded 100 pages.');
  } catch (error) {
    throw sanitizedError(error, [config.apiKey], redact(controller.signal.aborted ? controller.signal.reason.message : error.message, config.apiKey));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (body && !body.locked) body.cancel().catch(() => {});
  }
}

export async function createResponse(options = {}) {
  return withCredentials(options, (config) => createResponseOnce({ ...options, config }));
}
async function createResponseOnce({
  config, messages = [], maxOutputTokens, stream = true, onDelta, fetchImpl = fetch,
  timeoutMs = config?.timeoutMs ?? 120000, signal, tools = [],
} = {}) {
  if (['anthropic', 'gemini', 'ollama'].includes(config?.wireApi)) {
    return nativeResponse({ config, messages, maxOutputTokens, stream, onDelta, fetchImpl, timeoutMs, signal, tools });
  }
  if (!config?.apiKey && config?.requiresOpenAiAuth !== false) {
    throw new Error(`Missing API key. Run own-codex setup and edit ${config?.authPath || '~/.own-codex/auth.json'}, or set APINEX_API_KEY.`);
  }
  if (typeof config?.model !== 'string' || !config.model.trim()) throw new Error('A model must be configured.');
  const outputLimit = positiveInteger(maxOutputTokens ?? config.maxOutputTokens, 4096, 'maxOutputTokens');
  positiveInteger(timeoutMs, 120000, 'timeoutMs');
  const { url, payload } = requestDetails(config, messages, outputLimit, stream, tools);
  const controller = new AbortController();
  const cancelled = () => controller.abort(new Error('API request cancelled.'));
  if (signal?.aborted) cancelled();
  signal?.addEventListener('abort', cancelled, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`API request timed out after ${timeoutMs} ms.`)), timeoutMs);
  let reader;
  let body;
  const wait = (operation) => abortable(operation, controller.signal);
  const emit = (delta) => { if (delta) onDelta?.(delta); };
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const headers = {
      accept: stream ? 'text/event-stream, application/json' : 'application/json',
      'content-type': 'application/json',
    };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const response = await wait(fetchImpl(url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
      redirect: 'error',
    }));
    body = response.body;
    if (!response.ok) {
      const detail = await wait(response.text());
      throw httpError(response, detail);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (!contentType.includes('text/event-stream')) {
      let result;
      const data = await wait(response.text());
      try { result = JSON.parse(data); }
      catch { throw new Error('The API returned invalid JSON. Check base_url and wire_api.'); }
      const error = failure(result);
      if (error) throw new Error(error);
      const text = extractResponseText(result);
      const toolCalls = extractToolCalls(result);
      if (!text.trim() && !toolCalls.length) throw new Error('The API returned no answer text. Check the model and response format.');
      if (stream) emit(text);
      return { text, raw: result, usage: result.usage, model: result.model, toolCalls };
    }
    if (!body) throw new Error('The API returned an empty streaming body.');
    reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let complete = false;
    let raw;
    const outputItems = new Map();
    const chatCalls = new Map();
    let reportedModel;
    const append = (delta) => { text += delta; if (stream) emit(delta); };
    const handleEvent = (event) => {
      if (event.length > 1048576) throw new Error('API stream event exceeded 1 MiB.');
      const lines = event.split('\n');
      const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') { complete = true; return; }
      let value;
      try { value = JSON.parse(data); } catch { throw new Error('Malformed JSON in API stream. The answer may be incomplete.'); }
      if (!value || typeof value !== 'object') throw new Error('Invalid event in API stream.');
      if (type && !value.type) value.type = type;
      const error = failure(value);
      if (error) throw new Error(error);
      reportedModel ||= value.model;
      append(extractStreamDelta(value));
      if (['response.output_item.added', 'response.output_item.done'].includes(value.type) && value.item) {
        outputItems.set(value.output_index ?? value.item.id, { ...value.item });
      }
      if (value.type === 'response.function_call_arguments.delta') {
        const item = outputItems.get(value.output_index) || [...outputItems.values()].find((entry) => entry.id === value.item_id);
        if (!item) throw new Error('Function arguments arrived without a function-call item.');
        item.arguments = (item.arguments || '') + (value.delta || '');
      }
      if (value.type === 'response.function_call_arguments.done') {
        const item = outputItems.get(value.output_index) || [...outputItems.values()].find((entry) => entry.id === value.item_id);
        if (item) { item.arguments = value.arguments; item.status = 'completed'; }
      }
      for (const delta of value.choices?.[0]?.delta?.tool_calls || []) {
        const item = chatCalls.get(delta.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (delta.id) item.id = delta.id;
        if (delta.function?.name) item.function.name += delta.function.name;
        if (delta.function?.arguments) item.function.arguments += delta.function.arguments;
        chatCalls.set(delta.index, item);
      }
      if (value.type === 'response.completed') {
        raw = value.response || value;
        const finalText = extractResponseText(raw);
        if (finalText && !finalText.startsWith(text)) throw new Error('The completed answer differs from the streamed text.');
        if (finalText) append(finalText.slice(text.length));
        complete = true;
      }
      // Chat Completions can close immediately after a finish reason.
      if (value.choices?.[0]?.finish_reason) {
        raw = { ...value, model: value.model || reportedModel, choices: [{ ...value.choices[0], message: {
          role: 'assistant', content: text || null, ...(chatCalls.size ? { tool_calls: [...chatCalls.values()] } : {}),
        } }] };
        complete = true;
      }
    };
    // Normalize CRLF incrementally, including a CR/LF split across network chunks.
    let pendingCR = false;
    while (!complete) {
      const { done, value } = await wait(reader.read());
      let chunk = decoder.decode(value || new Uint8Array(), { stream: !done });
      if (pendingCR) { chunk = '\r' + chunk; pendingCR = false; }
      if (!done && chunk.endsWith('\r')) { chunk = chunk.slice(0, -1); pendingCR = true; }
      buffer += chunk.replace(/\r\n?/g, '\n');
      let boundary;
      while (!complete && (boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleEvent(event);
      }
      if (buffer.length > 1048576) throw new Error('API stream event exceeded 1 MiB.');
      if (done) { if (!complete && buffer.trim()) handleEvent(buffer); break; }
    }
    if (!complete) throw new Error('API stream ended before completion. The answer may be incomplete.');
    if (outputItems.size && !raw?.output?.length) raw = { ...raw, output: [...outputItems.values()] };
    if (chatCalls.size && !raw?.choices) raw = { ...raw, choices: [{ message: { role: 'assistant', content: text || null, tool_calls: [...chatCalls.values()] } }] };
    const toolCalls = extractToolCalls(raw);
    if (!text.trim() && !toolCalls.length) throw new Error('The API returned no answer text. Check the model and response format.');
    return { text, raw, usage: raw?.usage, model: raw?.model || reportedModel, toolCalls };
  } catch (error) {
    throw sanitizedError(error, [config.apiKey], redact(controller.signal.aborted ? controller.signal.reason.message : error.message, config.apiKey));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelled);
    if (reader) {
      // Do not let a broken peer hold the CLI open during cleanup.
      reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* A cancelled read may still be settling. */ }
    } else if (body && !body.locked) body.cancel().catch(() => {});
  }
}
