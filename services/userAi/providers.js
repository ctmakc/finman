// services/userAi/providers.js — the person's own AI: OpenAI-compatible, Anthropic, Gemini.
//
// One call shape for all of them:
//   complete({ provider, key, model, baseUrl, system, messages, tools }) ->
//     { text, calls: [{ id, name, args, meta? }], usage? }
// messages are the neutral transcript (see agent.js):
//   { role: 'user', text } | { role: 'assistant', text, calls: [...] } | { role: 'tool', results: [{ id, name, content, isError }] }
// listModels({ provider, key, baseUrl }) -> [{ id, name }]; also proves the key works.
//
// The key: only in request headers (never in a URL, never in logs or error texts). Errors
// come back as UserAiError with the provider's message, the key scrubbed out of it.
// Custom base URLs: https only, and the connection refuses private / loopback addresses
// (checked at DNS time on every request, so a rebinding name cannot reach the LAN).
'use strict';

const axios = require('axios');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

class UserAiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

const OPENAI_COMPAT = {
  openai: { name: 'ChatGPT (OpenAI)', base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
  mistral: { name: 'Mistral', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  xai: { name: 'Grok (xAI)', base: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai' },
  custom: { name: 'Other (OpenAI-compatible)', base: null, keyUrl: null },
};
const PROVIDERS = {
  openai: OPENAI_COMPAT.openai,
  anthropic: { name: 'Claude (Anthropic)', base: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys' },
  google: { name: 'Gemini (Google)', base: 'https://generativelanguage.googleapis.com', keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: OPENAI_COMPAT.openrouter,
  deepseek: OPENAI_COMPAT.deepseek,
  mistral: OPENAI_COMPAT.mistral,
  groq: OPENAI_COMPAT.groq,
  xai: OPENAI_COMPAT.xai,
  custom: OPENAI_COMPAT.custom,
};
const kind = (p) => (p === 'anthropic' ? 'anthropic' : p === 'google' ? 'google' : 'openai');

// ---------- network guard ----------
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
    if (!list.length || list.some((x) => privateIp(x.address))) return cb(new UserAiError('AI_BAD_URL', 'This address points to a private network', 400));
    if (options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}
const agents = { https: new https.Agent({ lookup: guardedLookup, keepAlive: true }), http: new http.Agent({ lookup: guardedLookup }) };

function checkBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { throw new UserAiError('AI_BAD_URL', 'Base URL is not a valid address'); }
  if (u.protocol !== 'https:') throw new UserAiError('AI_BAD_URL', 'Base URL must start with https://');
  if (u.username || u.password || u.hash) throw new UserAiError('AI_BAD_URL', 'Base URL must not contain a login or #fragment');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || (net.isIP(host) && privateIp(host))) {
    throw new UserAiError('AI_BAD_URL', 'This address points to a private network');
  }
  return u.toString().replace(/\/+$/, '');
}

function baseFor(provider, baseUrl) {
  if (provider === 'custom') return checkBaseUrl(baseUrl);
  const p = PROVIDERS[provider];
  if (!p) throw new UserAiError('AI_BAD_PROVIDER', 'Unknown AI provider');
  return p.base;
}

const BUSY = new Set([502, 503, 529]);
const GEMINI_SPARE = 'gemini-flash-lite-latest';
let retryDelayMs = 1500;

// Test seam: tests replace the HTTP layer; nothing leaves the machine.
const realHttp = (cfg) => axios({ ...cfg, httpsAgent: agents.https, httpAgent: agents.http, maxRedirects: 0, timeout: cfg.timeout || 90000, validateStatus: () => true });
let httpImpl = realHttp;
function _setHttp(fn, delayMs) {
  httpImpl = fn || realHttp;
  if (delayMs !== undefined) retryDelayMs = delayMs;
}

function scrub(text, key) {
  let s = String(text || '');
  if (key && key.length >= 6) s = s.split(key).join('***');
  return s.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…').replace(/(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]+/g, '$1…').slice(0, 400);
}
function providerMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  const e = data.error;
  if (e && typeof e === 'object') return e.message || e.type || JSON.stringify(e);
  if (typeof e === 'string') return e;
  return data.message || '';
}

async function send(cfg, key) {
  let r;
  try {
    // Overloaded provider (503 / Anthropic 529): two quiet retries before giving up.
    for (let attempt = 0; ; attempt += 1) {
      r = await httpImpl(cfg);
      if (!BUSY.has(r.status) || attempt >= 2) break;
      await new Promise((ok) => setTimeout(ok, retryDelayMs * (attempt + 1)));
    }
  } catch (e) {
    if (e instanceof UserAiError) throw e;
    if (e && e.cause instanceof UserAiError) throw e.cause;
    const code = e && e.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') throw new UserAiError('AI_TIMEOUT', 'The AI service did not answer in time', 504);
    throw new UserAiError('AI_UNREACHABLE', 'Could not reach the AI service' + (code ? ` (${code})` : ''), 502);
  }
  if (r.status >= 200 && r.status < 300) return r.data;
  const msg = scrub(providerMessage(r.data), key);
  if (r.status === 401 || r.status === 403) throw new UserAiError('AI_KEY_REJECTED', `The key was rejected${msg ? ': ' + msg : ''}`, 400);
  if (r.status === 429) throw new UserAiError('AI_RATE_LIMIT', `The AI service limit is reached${msg ? ': ' + msg : ''}`, 429);
  if (BUSY.has(r.status)) throw new UserAiError('AI_BUSY', `The AI service is busy right now, try again in a minute${msg ? ': ' + msg : ''}`, 503);
  if (r.status === 404) throw new UserAiError('AI_MODEL_NOT_FOUND', `Not found${msg ? ': ' + msg : ''}`, 400);
  throw new UserAiError('AI_PROVIDER_ERROR', `AI service error ${r.status}${msg ? ': ' + msg : ''}`, 502);
}

// ---------- models ----------
const PREFER = {
  openai: [/^gpt-5(\.\d+)?-mini$/, /^gpt-5(\.\d+)?$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/, /^gpt-4\.1$/, /^gpt-4o$/],
  anthropic: [/sonnet/, /haiku/, /opus/],
  google: [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/, /^gemini-pro-latest$/, /flash/],
  openrouter: [/^openai\/gpt-[\d.]+-mini$/, /^google\/gemini-[\d.]+-flash$/, /^anthropic\/claude-.*(sonnet|haiku)/],
  deepseek: [/^deepseek-chat$/],
  mistral: [/^mistral-medium-latest$/, /^mistral-small-latest$/, /^mistral-large-latest$/],
  groq: [/llama-3\.3-70b/, /gpt-oss-120b/, /llama/],
  xai: [/^grok-[\d.]+-fast/, /^grok-[\d.]+$/, /^grok/],
};
const SKIP_OPENAI = /(embed|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|computer-use|davinci|babbage|codex|sora|instruct)/i;

function pickDefault(provider, models) {
  const ids = models.map((m) => m.id);
  for (const re of PREFER[provider] || []) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0] || '';
}

async function listModels({ provider, key, baseUrl }) {
  if (!key) throw new UserAiError('AI_NO_KEY', 'API key is required');
  const base = baseFor(provider, baseUrl);
  const k = kind(provider);
  let models = [];
  if (k === 'anthropic') {
    const d = await send({ method: 'GET', url: `${base}/v1/models?limit=100`, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, timeout: 20000 }, key);
    models = (d.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  } else if (k === 'google') {
    const d = await send({ method: 'GET', url: `${base}/v1beta/models?pageSize=1000`, headers: { 'x-goog-api-key': key }, timeout: 20000 }, key);
    models = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), name: m.displayName || m.name }))
      .filter((m) => /^gemini/.test(m.id) && !/(image|tts|embedding|live|audio|robotics|computer|transcribe|banana|omni)/i.test(m.id));
  } else {
    if (provider === 'openrouter') {
      // /models is public there; /key proves this key is real.
      await send({ method: 'GET', url: `${base}/key`, headers: { Authorization: `Bearer ${key}` }, timeout: 20000 }, key);
    }
    const d = await send({ method: 'GET', url: `${base}/models`, headers: { Authorization: `Bearer ${key}` }, timeout: 20000 }, key);
    const raw = Array.isArray(d) ? d : (d.data || d.models || []);
    models = raw
      .filter((m) => !(provider === 'openrouter' && Array.isArray(m.supported_parameters) && !m.supported_parameters.includes('tools')))
      .map((m) => ({ id: String(m.id || m.name || ''), name: m.name || m.id }))
      .filter((m) => m.id && (provider !== 'openai' || (/^(gpt|o\d|chatgpt)/.test(m.id) && !SKIP_OPENAI.test(m.id))));
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models: models.slice(0, 500), defaultModel: pickDefault(provider, models) };
}

// ---------- chat with tools ----------
const MAX_OUT = 2000;
const parseArgs = (s) => {
  if (s && typeof s === 'object') return s;
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
};

// JSON Schema subset that every provider accepts (Gemini is the strictest).
function cleanSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['type', 'description', 'enum', 'required', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern'].includes(k)) out[k] = v;
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, cleanSchema(pv)]));
    else if (k === 'items') out.items = cleanSchema(v);
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.calls && m.calls.length) {
        msg.tool_calls = m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
        if (!m.text) msg.content = null;
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

function toAnthropic(messages) {
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text }]);
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.calls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
      if (blocks.length) push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: !!r.isError })));
    }
  }
  return out;
}

function toGemini(messages) {
  const out = [];
  const push = (role, parts) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else out.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ text: m.text }]);
    else if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.calls || []) {
        const p = { functionCall: { name: c.name, args: c.args || {} } };
        if (c.meta && c.meta.gid) p.functionCall.id = c.meta.gid;
        if (c.meta && c.meta.sig) p.thoughtSignature = c.meta.sig;
        parts.push(p);
      }
      if (parts.length) push('model', parts);
    } else if (m.role === 'tool') {
      push('user', m.results.map((r) => {
        let response;
        try { response = JSON.parse(r.content); } catch (_) { response = null; }
        if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: r.content };
        if (r.isError) response = { error: r.content };
        const fr = { name: r.name, response };
        if (r.gid) fr.id = r.gid;
        return { functionResponse: fr };
      }));
    }
  }
  return out;
}

let callSeq = 0;
const newCallId = () => `call_${Date.now().toString(36)}${(++callSeq).toString(36)}`;

async function complete({ provider, key, model, baseUrl, system, messages, tools }) {
  if (!key) throw new UserAiError('AI_NO_KEY', 'API key is required');
  if (!model) throw new UserAiError('AI_NO_MODEL', 'Choose a model');
  const base = baseFor(provider, baseUrl);
  const k = kind(provider);
  const specs = (tools || []).map((t) => ({ name: t.name, description: t.description, parameters: cleanSchema(t.inputSchema) }));

  if (k === 'anthropic') {
    const body = { model, max_tokens: MAX_OUT, system, messages: toAnthropic(messages) };
    if (specs.length) body.tools = specs.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const d = await send({ method: 'POST', url: `${base}/v1/messages`, data: body, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }, key);
    const blocks = d.content || [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
      calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
      usage: d.usage ? { input: d.usage.input_tokens, output: d.usage.output_tokens } : undefined,
    };
  }

  if (k === 'google') {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: toGemini(messages),
      generationConfig: { maxOutputTokens: MAX_OUT * 2 },
    };
    if (specs.length) body.tools = [{ functionDeclarations: specs }];
    const call = (m, timeout) => send({ method: 'POST', url: `${base}/v1beta/models/${encodeURIComponent(m)}:generateContent`, data: body, timeout, headers: { 'x-goog-api-key': key, 'content-type': 'application/json' } }, key);
    let d;
    if (model === GEMINI_SPARE) d = await call(model);
    else {
      // Free-tier Flash is often overloaded (503) or hangs for a minute: one answer from Flash-Lite instead.
      try { d = await call(model, 40000); } catch (e) {
        if (!(e instanceof UserAiError) || !['AI_BUSY', 'AI_TIMEOUT'].includes(e.code)) throw e;
        try { d = await call(GEMINI_SPARE); } catch (_) { throw e; }
      }
    }
    const cand = (d.candidates || [])[0];
    if (!cand) {
      const why = d.promptFeedback && d.promptFeedback.blockReason;
      throw new UserAiError('AI_PROVIDER_ERROR', why ? `Gemini blocked the request (${why})` : 'Gemini returned no answer', 502);
    }
    const parts = (cand.content && cand.content.parts) || [];
    const calls = [];
    let pendingSig = null;
    for (const p of parts) {
      if (p.functionCall) {
        const meta = {};
        if (p.functionCall.id) meta.gid = p.functionCall.id;
        if (p.thoughtSignature || pendingSig) meta.sig = p.thoughtSignature || pendingSig;
        pendingSig = null;
        calls.push({ id: newCallId(), name: p.functionCall.name, args: p.functionCall.args || {}, meta });
      } else if (p.thoughtSignature && !p.text) pendingSig = p.thoughtSignature;
    }
    return {
      text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim(),
      calls,
      usage: d.usageMetadata ? { input: d.usageMetadata.promptTokenCount, output: d.usageMetadata.candidatesTokenCount } : undefined,
    };
  }

  const body = { model, messages: toOpenAI(system, messages) };
  if (provider === 'openai') body.max_completion_tokens = MAX_OUT * 2; else body.max_tokens = MAX_OUT;
  if (specs.length) body.tools = specs.map((t) => ({ type: 'function', function: t }));
  const headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://app.finman.money'; headers['X-Title'] = 'Finman'; }
  const d = await send({ method: 'POST', url: `${base}/chat/completions`, data: body, headers }, key);
  const msg = ((d.choices || [])[0] || {}).message || {};
  let text = msg.content;
  if (Array.isArray(text)) text = text.map((p) => p.text || '').join('');
  return {
    text: String(text || '').trim(),
    calls: (msg.tool_calls || []).filter((c) => c && c.function).map((c) => ({ id: c.id || newCallId(), name: c.function.name, args: parseArgs(c.function.arguments) })),
    usage: d.usage ? { input: d.usage.prompt_tokens, output: d.usage.completion_tokens } : undefined,
  };
}

// What the "Your AI" screen shows on each tile. `free` = the provider offers a free tier
// (Gemini API in AI Studio, OpenRouter :free models, Groq free plan).
const CARD = {
  openai: { brand: 'ChatGPT', vendor: 'OpenAI', short: 'Ch', keyPlaceholder: 'sk-…' },
  anthropic: { brand: 'Claude', vendor: 'Anthropic', short: 'Cl', keyPlaceholder: 'sk-ant-…' },
  google: { brand: 'Gemini', vendor: 'Google AI Studio', short: 'Ge', keyPlaceholder: 'AIza…', free: true },
  openrouter: { brand: 'OpenRouter', vendor: 'openrouter.ai', short: 'OR', keyPlaceholder: 'sk-or-…', free: true },
  deepseek: { brand: 'DeepSeek', vendor: 'deepseek.com', short: 'DS', keyPlaceholder: 'sk-…' },
  mistral: { brand: 'Mistral', vendor: 'Le Chat API', short: 'Mi' },
  groq: { brand: 'Groq', vendor: 'groq.com', short: 'Gq', keyPlaceholder: 'gsk_…', free: true },
  xai: { brand: 'Grok', vendor: 'xAI', short: 'xA', keyPlaceholder: 'xai-…' },
  custom: { brand: 'Other', vendor: '', short: '+' },
};
function publicProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, name: p.name, keyUrl: p.keyUrl, needsBaseUrl: id === 'custom',
    brand: (CARD[id] || {}).brand || p.name, vendor: (CARD[id] || {}).vendor || '', short: (CARD[id] || {}).short || p.name.slice(0, 2),
    keyPlaceholder: (CARD[id] || {}).keyPlaceholder || '', free: !!(CARD[id] || {}).free,
  }));
}

module.exports = { PROVIDERS, publicProviders, listModels, complete, checkBaseUrl, privateIp, UserAiError, scrub, cleanSchema, _setHttp };
