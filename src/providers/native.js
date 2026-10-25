import { randomUUID } from 'node:crypto';
import { positiveInteger } from '../config.js';
import { abortable } from '../core/async.js';
import { httpError, sanitizedError } from './errors.js';

function inputMessages(messages) { return messages.filter((message) => !['system', 'developer'].includes(message.role)); }
function baseUrl(config) {
  const url = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid provider URL.');
  return url.href.replace(/\/+$/, '');
}
function anthropicMessages(messages) {
  return inputMessages(messages).map((message) => {
    if (message.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }] };
    if (message.nativeContent) return { role: message.role, content: message.nativeContent };
    const content = message.content ? [{ type: 'text', text: message.content }] : [];
    for (const call of message.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
    return { role: message.role, content };
  });
}
function geminiContents(messages) {
  const names = new Map();
  return inputMessages(messages).map((message) => {
    if (message.role === 'tool') { const call = names.get(message.tool_call_id); return { role: 'user', parts: [{ functionResponse: { name: call?.name, ...(call?.id ? { id: call.id } : {}), response: JSON.parse(message.content) } }] }; }
    const parts = message.nativeContent || (message.content ? [{ text: message.content }] : []);
    if (!message.nativeContent) for (const call of message.tool_calls || []) parts.push({ functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments) } });
    for (const call of message.tool_calls || []) names.set(call.id, { name: call.function.name,
      id: message.nativeContent?.find((part) => part.functionCall?.id === call.id)?.functionCall?.id });
    return { role: message.role === 'assistant' ? 'model' : 'user', parts };
  });
}
function ollamaMessages(messages) {
  const names = new Map();
  return messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', tool_name: names.get(message.tool_call_id), content: message.content };
    const calls = (message.tool_calls || []).map((call) => { names.set(call.id, call.function.name); return { function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) } }; });
    return { role: message.role, content: message.content || '', ...(calls.length ? { tool_calls: calls } : {}), ...(message.thinking ? { thinking: message.thinking } : {}) };
  });
}
export async function nativeResponse({ config, messages = [], tools = [], maxOutputTokens, stream = true, onDelta,
  signal, timeoutMs = config.timeoutMs || 120000, fetchImpl = fetch } = {}) {
  const wire = config.wireApi;
  positiveInteger(timeoutMs, 120000, 'timeoutMs');
  const outputLimit = positiveInteger(maxOutputTokens ?? config.maxOutputTokens, 4096, 'maxOutputTokens');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('API request cancelled.'));
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`API request timed out after ${timeoutMs} ms.`)), timeoutMs);
  let reader;
  const wait = (operation) => abortable(operation, controller.signal);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!config.apiKey && config.requiresOpenAiAuth !== false) throw new Error('Missing API key for the selected provider.');
    const system = messages.filter((message) => ['system', 'developer'].includes(message.role)).map((message) => message.content).join('\n');
    let url = baseUrl(config); let body; const headers = { 'content-type': 'application/json' };
    const limit = outputLimit;
    if (wire === 'anthropic') {
      url += url.endsWith('/messages') ? '' : '/messages';
      headers['anthropic-version'] = config.apiVersion || '2023-06-01';
      if (config.apiKey) headers['x-api-key'] = config.apiKey;
      body = { model: config.model, max_tokens: limit, system, messages: anthropicMessages(messages), stream,
        ...(tools.length ? { tools: tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })) } : {}) };
    } else if (wire === 'gemini') {
      url += `/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
      if (config.apiKey) headers['x-goog-api-key'] = config.apiKey;
      body = { systemInstruction: { parts: [{ text: system }] }, contents: geminiContents(messages), generationConfig: { maxOutputTokens: limit },
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, parametersJsonSchema: parameters })) }] } : {}) };
    } else if (wire === 'ollama') {
      url = url.replace(/\/(api|api\/chat)$/, '') + '/api/chat';
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      body = { model: config.model, messages: ollamaMessages(messages), stream, options: { num_predict: limit },
        ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}) };
    } else throw new Error(`Unsupported native wire API: ${wire}`);
    const response = await wait(fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' }));
    if (!response.ok) throw httpError(response, (await wait(response.text())).slice(0, 2000));
    let text = ''; let thinking = ''; let usage = {}; let model = config.model; let complete = false; const native = []; const calls = [];
    const emit = (delta) => { if (typeof delta !== 'string') throw new Error('Provider returned non-text content.'); text += delta; if (stream && delta) onDelta?.(delta); };
    const consume = (value) => {
      if (!value || typeof value !== 'object') throw new Error('Provider returned an invalid response object.');
      if (value.error) throw new Error(typeof value.error === 'string' ? value.error : value.error.message || 'Provider failed.');
      if (wire === 'anthropic') {
        if (value.type === 'message_start') { model = value.message.model; usage = { ...usage, ...value.message.usage }; }
        if (value.type === 'content_block_start') native[value.index] = { ...value.content_block };
        if (value.type === 'content_block_delta') {
          const block = native[value.index];
          if (!block) throw new Error('Content delta arrived without its block.');
          if (value.delta.type === 'text_delta') { block.text = (block.text || '') + value.delta.text; emit(value.delta.text); }
          if (value.delta.type === 'input_json_delta') block.partial = (block.partial || '') + value.delta.partial_json;
          if (value.delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + value.delta.thinking;
          if (value.delta.type === 'signature_delta') block.signature = (block.signature || '') + value.delta.signature;
        }
        if (value.type === 'message_delta') { usage = { ...usage, ...value.usage }; if (value.delta?.stop_reason === 'max_tokens') throw new Error('Response incomplete: max_tokens.'); }
        if (value.type === 'message_stop') complete = true;
        if (Array.isArray(value.content)) {
          if (value.stop_reason === 'max_tokens') throw new Error('Response incomplete: max_tokens.');
          native.push(...value.content); model = value.model || model; usage = value.usage || {}; complete = true;
          for (const block of value.content) if (block.type === 'text') emit(block.text);
        }
      } else if (wire === 'gemini') {
        const candidate = value.candidates?.[0];
        if (value.promptFeedback?.blockReason) throw new Error(`Provider blocked the prompt: ${value.promptFeedback.blockReason}`);
        for (const part of candidate?.content?.parts || []) { native.push(part); if (part.text && !part.thought) emit(part.text); }
        if (candidate?.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(candidate.finishReason)) throw new Error(`Response incomplete: ${candidate.finishReason}`);
        if (candidate?.finishReason === 'STOP') complete = true;
        if (value.usageMetadata) usage = { input_tokens: value.usageMetadata.promptTokenCount, output_tokens: (value.usageMetadata.candidatesTokenCount || 0) + (value.usageMetadata.thoughtsTokenCount || 0),
          total_tokens: value.usageMetadata.totalTokenCount, input_tokens_details: { cached_tokens: value.usageMetadata.cachedContentTokenCount || 0 } };
        model = value.modelVersion || model;
      } else {
        if (typeof value.message?.thinking === 'string') thinking += value.message.thinking;
        if (value.message?.content) emit(value.message.content);
        for (const call of value.message?.tool_calls || []) calls.push({ id: call.id || randomUUID(), name: call.function.name, arguments: JSON.stringify(call.function.arguments || {}) });
        if (value.done) { if (value.done_reason === 'length') throw new Error('Response incomplete: length.'); complete = true;
          usage = { input_tokens: value.prompt_eval_count, output_tokens: value.eval_count, input_tokens_details: { cached_tokens: value.prompt_eval_cached_count || 0 } }; }
      }
    };
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') && !contentType.includes('ndjson')) consume(await wait(response.json()));
    else {
      if (!response.body) throw new Error('Empty provider stream.');
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await wait(reader.read());
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let boundary;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary).replace(/\r$/, ''); buffer = buffer.slice(boundary + 1);
          if (line.length > 2097152) throw new Error('Provider stream event is too large.');
          const data = wire === 'ollama' ? line : line.startsWith('data:') ? line.slice(5).trim() : '';
          if (data && data !== '[DONE]') consume(JSON.parse(data));
        }
        if (buffer.length > 2097152) throw new Error('Provider stream event is too large.');
        if (done) { if (buffer.trim() && wire === 'ollama') consume(JSON.parse(buffer)); break; }
        if (complete) break;
      }
    }
    if (!complete) throw new Error('Provider response ended before completion.');
    if (wire === 'anthropic') for (const block of native) if (block?.type === 'tool_use') {
      if (block.partial) { block.input = JSON.parse(block.partial); delete block.partial; }
      calls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
    }
    if (wire === 'gemini') for (const part of native) if (part.functionCall) calls.push({ id: part.functionCall.id || randomUUID(), name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) });
    if (!text.trim() && !calls.length) throw new Error('The API returned no answer text.');
    const callIds = new Set();
    for (const call of calls) {
      if (typeof call.id !== 'string' || !call.id || callIds.has(call.id) || typeof call.name !== 'string' || !call.name) throw new Error('Provider returned an invalid or duplicate tool call.');
      callIds.add(call.id);
    }
    const tool_calls = calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
    return { text, model, usage, toolCalls: calls, continuation: [{ role: 'assistant', content: text || null,
      ...(tool_calls.length ? { tool_calls } : {}), ...(wire !== 'ollama' ? { nativeContent: native } : thinking ? { thinking } : {}) }] };
  } catch (error) {
    let message = controller.signal.aborted ? controller.signal.reason?.message || 'API request cancelled.' : error.message;
    if (config.apiKey) message = message.replaceAll(config.apiKey, '[redacted]');
    throw sanitizedError(error, [config.apiKey], message);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (reader) reader.cancel().catch(() => {});
  }
}
