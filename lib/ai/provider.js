// lib/ai/provider.js — provider-agnostic AI client on top of axios (no vendor SDKs).
//
// Providers (owner law: product LLM = Google Gemini / Ollama Cloud / OpenAI-compatible;
// Anthropic is an explicit opt-in only, never a default):
//   google        Gemini REST  https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//                 key (x-goog-api-key header, never in the URL):
//                 GOOGLE_API_KEY | GEMINI_API_KEY | AI_API_KEY (when AI_PROVIDER=google)   default model gemini-2.5-flash
//   gemini-oauth  Gemini via cloudcode-pa.googleapis.com with a Google OAuth refresh token
//                 (GEMINI_CLIENT_ID + GEMINI_CLIENT_SECRET + GEMINI_REFRESH_TOKEN | GEMINI_OAUTH_CREDS json file)
//   ollama        Ollama Cloud https://ollama.com (or a local Ollama via AI_BASE_URL)
//                 key: OLLAMA_API_KEY | AI_API_KEY (when AI_PROVIDER=ollama) | file OLLAMA_API_KEY_FILE
//                 (~/.ollama/api_key only with AI_ALLOW_HOME_CREDENTIALS=1)
//   openai        OpenAI-compatible chat completions (honours AI_BASE_URL for gateways / compatible servers)
//                 key: OPENAI_API_KEY | AI_API_KEY (when AI_PROVIDER=openai)   default model gpt-4o-mini
//   anthropic     opt-in only (AI_PROVIDER=anthropic + ANTHROPIC_API_KEY | AI_API_KEY)
//
// Resolution when AI_PROVIDER is unset: google -> gemini-oauth -> ollama -> openai, first one
// with PROVIDER-SPECIFIC credentials wins; none -> not configured (AI endpoints answer 503
// AI_NOT_CONFIGURED). The generic AI_API_KEY is never guessed onto a provider: it applies only
// to the provider named in AI_PROVIDER (an sk-… or Anthropic key must never reach Google).
//
// Credential files under $HOME (~/.ollama/api_key, ~/.gemini-home/.gemini/oauth_creds.json) are
// read only with AI_ALLOW_HOME_CREDENTIALS=1, so a server running as a developer's user never
// spends that person's own credentials on users' data. Explicit *_FILE / GEMINI_OAUTH_CREDS
// paths are always honoured.
//
// Other env: AI_MODEL (model override), AI_BASE_URL (base URL override for the env provider),
// AI_MAX_TOKENS (default 1024).
//
// Exports:
//   chat({ system, messages, maxTokens, provider, model })            -> { text, provider, model }
//   chatStream({ ...same, signal }, onChunk)                           -> { text, provider, model, streamed }
//     signal: AbortSignal — aborting (client went away) cancels the upstream request/stream
//     and rejects with AppError 499 AI_ABORTED. A stream that stays silent longer than the
//     provider timeout is cut off (axios' timeout only covers the response headers).
//   vision({ imageBase64, mimeType, prompt, maxTokens, provider, model }) -> { text, provider, model }
//   isConfigured(provider?) / supportsStreaming(provider?) / supportsVision(provider?)
//   resolveProviderName(provider?) / describe(provider?)
//
// messages: [{ role: 'user'|'assistant', content: string }, ...]

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppError } = require('../../middleware/error');
const logger = require('../logger');

const DEFAULTS = {
  google: {
    baseURL: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
    stream: true,
    vision: true,
    timeout: 60000,
  },
  'gemini-oauth': {
    baseURL: 'https://cloudcode-pa.googleapis.com',
    model: 'gemini-2.5-flash',
    stream: true,
    vision: true,
    timeout: 60000,
  },
  ollama: {
    baseURL: 'https://ollama.com',
    model: 'gpt-oss:20b',
    stream: true,
    vision: false,
    timeout: 120000,
  },
  openai: {
    baseURL: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    stream: true,
    vision: true,
    timeout: 60000,
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com',
    model: 'claude-opus-4-8',
    stream: false,
    vision: false,
    timeout: 60000,
  },
};

// Auto-detection order when AI_PROVIDER is unset.
const AUTO_ORDER = ['google', 'gemini-oauth', 'ollama', 'openai'];

const STREAM_CHUNK_SIZE = 60; // used only for providers that cannot stream
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// --------------------------------------------------------------------------
// env / credential helpers
// --------------------------------------------------------------------------

function env(name) {
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
}

function readFileTrim(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

// Credential files under $HOME are an explicit opt-in (AI_ALLOW_HOME_CREDENTIALS=1).
function homeFilesAllowed() {
  return env('AI_ALLOW_HOME_CREDENTIALS') === '1';
}

function homeDir() {
  return process.env.HOME || os.homedir();
}

function googleKey(explicit) {
  return env('GOOGLE_API_KEY') || env('GEMINI_API_KEY') || (explicit ? env('AI_API_KEY') : '');
}

function geminiCredsPath() {
  const explicit = env('GEMINI_OAUTH_CREDS');
  if (explicit) return explicit;
  return homeFilesAllowed() ? path.join(homeDir(), '.gemini-home', '.gemini', 'oauth_creds.json') : '';
}

function geminiRefreshToken() {
  const direct = env('GEMINI_REFRESH_TOKEN');
  if (direct) return direct;
  const credsPath = geminiCredsPath();
  if (!credsPath) return '';
  try {
    return JSON.parse(fs.readFileSync(credsPath, 'utf8')).refresh_token || '';
  } catch (_) {
    return '';
  }
}

function geminiOAuthConfigured() {
  return Boolean(env('GEMINI_CLIENT_ID') && env('GEMINI_CLIENT_SECRET') && geminiRefreshToken());
}

function ollamaKey(explicit) {
  const direct = env('OLLAMA_API_KEY') || (explicit ? env('AI_API_KEY') : '');
  if (direct) return direct;
  const file = env('OLLAMA_API_KEY_FILE') || (homeFilesAllowed() ? path.join(homeDir(), '.ollama', 'api_key') : '');
  return file ? readFileTrim(file) : '';
}

function openaiKey(explicit) {
  return env('OPENAI_API_KEY') || (explicit ? env('AI_API_KEY') : '');
}

function anthropicKey(explicit) {
  return env('ANTHROPIC_API_KEY') || (explicit ? env('AI_API_KEY') : '');
}

// credentials(name, explicit) -> { ok, apiKey, baseURL? }
// `explicit` = the provider was named (env or per-call), so the generic AI_API_KEY applies to it.
function credentials(name, explicit) {
  switch (name) {
    case 'google': {
      const apiKey = googleKey(explicit);
      return { ok: Boolean(apiKey), apiKey };
    }
    case 'gemini-oauth':
      return { ok: geminiOAuthConfigured(), apiKey: '' };
    case 'ollama': {
      const apiKey = ollamaKey(explicit);
      const baseURL = env('OLLAMA_BASE_URL');
      // A local Ollama (AI_BASE_URL/OLLAMA_BASE_URL) needs no key; Ollama Cloud does.
      return { ok: Boolean(apiKey || baseURL || (explicit && env('AI_BASE_URL'))), apiKey, baseURL };
    }
    case 'openai': {
      const apiKey = openaiKey(explicit);
      return { ok: Boolean(apiKey), apiKey };
    }
    case 'anthropic': {
      const apiKey = anthropicKey(explicit);
      return { ok: Boolean(apiKey), apiKey };
    }
    default:
      return { ok: false, apiKey: '' };
  }
}

// Which provider serves a call. Explicit (per-call or AI_PROVIDER) wins; otherwise the first
// auto-detected provider with credentials; null when nothing is configured.
function resolveProviderName(override) {
  const explicit = String(override || env('AI_PROVIDER') || '').toLowerCase();
  if (explicit) {
    if (DEFAULTS[explicit]) return explicit;
    logger.warn({ provider: explicit }, 'Unknown AI_PROVIDER — AI stays unconfigured');
    return null;
  }
  for (const name of AUTO_ORDER) {
    if (credentials(name, false).ok) return name;
  }
  warnGenericKeyIgnored();
  return null;
}

// AI_API_KEY without AI_PROVIDER: the key's vendor is unknown, so it is not used (warned once).
let _warnedGenericKey = false;
function warnGenericKeyIgnored() {
  if (_warnedGenericKey || !env('AI_API_KEY') || env('AI_PROVIDER')) return;
  _warnedGenericKey = true;
  logger.warn('AI_API_KEY is set but AI_PROVIDER is not — the key is ignored; set AI_PROVIDER (google|ollama|openai|anthropic)');
}

// Full resolved config for a call. opts: { provider, model }
function config(opts = {}) {
  const name = resolveProviderName(opts.provider);
  if (!name) {
    return { name: null, configured: false, canStream: false, canVision: false };
  }
  const d = DEFAULTS[name];
  const envProvider = env('AI_PROVIDER').toLowerCase();
  const explicit = Boolean(opts.provider) || envProvider === name;
  const creds = credentials(name, explicit);
  // AI_BASE_URL belongs to the env provider; a per-call override of a different provider ignores it.
  const baseOverrideApplies = !opts.provider || !envProvider || envProvider === name;
  const baseURL =
    (baseOverrideApplies && env('AI_BASE_URL')) || creds.baseURL || d.baseURL;
  const modelOverrideApplies = !opts.provider || !envProvider || envProvider === name;
  const model = opts.model || (modelOverrideApplies && env('AI_MODEL')) || d.model;
  return {
    name,
    baseURL: String(baseURL).replace(/\/+$/, ''),
    model,
    apiKey: creds.apiKey || '',
    configured: creds.ok,
    maxTokens: parseInt(env('AI_MAX_TOKENS'), 10) || 1024,
    timeout: d.timeout,
    canStream: d.stream,
    canVision: d.vision,
  };
}

function isConfigured(provider) {
  return config({ provider }).configured;
}

function supportsStreaming(provider) {
  const c = config({ provider });
  return Boolean(c.configured && c.canStream);
}

function supportsVision(provider) {
  const c = config({ provider });
  return Boolean(c.configured && c.canVision);
}

// Public, secret-free description (for diagnostics / UI).
function describe(provider) {
  const c = config({ provider });
  return {
    provider: c.name,
    model: c.name ? c.model : null,
    configured: c.configured,
    streaming: Boolean(c.configured && c.canStream),
    vision: Boolean(c.configured && c.canVision),
  };
}

function requireConfig(opts) {
  const c = config(opts);
  if (!c.configured) {
    const hint =
      env('AI_API_KEY') && !env('AI_PROVIDER') && !(opts && opts.provider)
        ? ' (AI_API_KEY needs AI_PROVIDER)'
        : '';
    throw new AppError(503, 'AI_NOT_CONFIGURED', `AI provider not configured${hint}`);
  }
  return c;
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content == null ? '' : m.content) }));
}

function wrapError(err, c) {
  if (err instanceof AppError) throw err;
  const status = err && err.response && err.response.status;
  const detail =
    err && err.response && err.response.data && err.response.data.error
      ? err.response.data.error.message || JSON.stringify(err.response.data.error).slice(0, 200)
      : undefined;
  logger.error({ provider: c.name, model: c.model, status, msg: err && err.message, detail }, 'AI provider request failed');
  throw new AppError(502, 'AI_REQUEST_FAILED', `AI provider request failed${status ? ` (HTTP ${status})` : ''}`);
}

// --------------------------------------------------------------------------
// Streaming helpers: read a Node stream line by line (SSE "data:" lines or NDJSON).
// --------------------------------------------------------------------------

// opts: { signal, idleMs } — abort via signal, or give up when no bytes arrive for idleMs.
function readLines(stream, onLine, opts = {}) {
  const { signal, idleMs } = opts;
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    let idleTimer = null;
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof stream.destroy === 'function') stream.destroy();
      reject(err);
    };
    function onAbort() {
      const err = new Error('stream aborted');
      err.code = 'ERR_CANCELED';
      fail(err);
    }
    const armIdle = () => {
      if (!idleMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const err = new Error(`stream idle for ${idleMs}ms`);
        err.code = 'ECONNABORTED';
        fail(err);
      }, idleMs);
    };
    const flush = (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.length) onLine(line);
      }
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    armIdle();
    stream.on('data', (d) => {
      if (settled) return;
      armIdle();
      try {
        flush(Buffer.isBuffer(d) ? d.toString('utf8') : String(d));
      } catch (err) {
        fail(err);
      }
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (buffer.trim().length) onLine(buffer.replace(/\r$/, ''));
      resolve();
    });
    stream.on('error', fail);
    stream.on('close', () => {
      // destroyed without 'end' (socket reset) — do not hang forever
      if (!settled) fail(new Error('stream closed before end'));
    });
  });
}

function streamOpts(c, args) {
  return { signal: args.signal, idleMs: c.timeout };
}

// SSE line -> parsed JSON payload or null (ignores comments, "[DONE]", non-data lines).
function parseSseLine(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch (_) {
    return null;
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function chunkText(text, size = STREAM_CHUNK_SIZE) {
  const str = String(text == null ? '' : text);
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

// --------------------------------------------------------------------------
// Google Gemini (API key, REST)
// --------------------------------------------------------------------------

function geminiContents(msgs) {
  return msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
}

function geminiBody({ system, msgs, tokens, contents }) {
  const body = {
    contents: contents || geminiContents(msgs),
    generationConfig: { maxOutputTokens: tokens, temperature: 0.7 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

function geminiText(data) {
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  return parts.map((p) => (p && p.text) || '').join('');
}

// The API key travels in the x-goog-api-key header: URLs end up in proxy/access logs.
function googleUrl(c, method, extraQuery) {
  return `${c.baseURL}/v1beta/models/${encodeURIComponent(c.model)}:${method}${extraQuery ? `?${extraQuery}` : ''}`;
}

function googleHeaders(c, extra) {
  return { 'content-type': 'application/json', 'x-goog-api-key': c.apiKey, ...(extra || {}) };
}

const google = {
  async chat(c, args) {
    const resp = await axios.post(googleUrl(c, 'generateContent'), geminiBody(args), {
      headers: googleHeaders(c),
      timeout: c.timeout,
      signal: args.signal,
    });
    return geminiText(resp.data);
  },
  async stream(c, args, onChunk) {
    const resp = await axios.post(googleUrl(c, 'streamGenerateContent', 'alt=sse'), geminiBody(args), {
      headers: googleHeaders(c, { accept: 'text/event-stream' }),
      timeout: c.timeout,
      responseType: 'stream',
      signal: args.signal,
    });
    let text = '';
    await readLines(resp.data, (line) => {
      const piece = geminiText(parseSseLine(line));
      if (piece) {
        text += piece;
        onChunk(piece);
      }
    }, streamOpts(c, args));
    return text;
  },
  async vision(c, { imageBase64, mimeType, prompt, tokens }) {
    const contents = [
      { role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: prompt }] },
    ];
    const resp = await axios.post(googleUrl(c, 'generateContent'), geminiBody({ tokens, contents }), {
      headers: googleHeaders(c),
      timeout: c.timeout,
    });
    return geminiText(resp.data);
  },
};

// --------------------------------------------------------------------------
// Gemini via Google OAuth (cloudcode-pa) — refresh-token flow ported from production.
// --------------------------------------------------------------------------

let _geminiOAuthToken = null;
let _geminiOAuthExpiry = 0;
let _geminiProjectId = null;

function resetOAuthCache() {
  _geminiOAuthToken = null;
  _geminiOAuthExpiry = 0;
  _geminiProjectId = null;
}

async function getGeminiOAuthToken() {
  if (_geminiOAuthToken && Date.now() < _geminiOAuthExpiry - 60000) return _geminiOAuthToken;

  const refreshToken = geminiRefreshToken();
  if (!refreshToken) throw new Error('No GEMINI_REFRESH_TOKEN configured');

  const clientId = env('GEMINI_CLIENT_ID');
  const clientSecret = env('GEMINI_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('GEMINI_CLIENT_ID / GEMINI_CLIENT_SECRET not set');

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  const resp = await axios.post(OAUTH_TOKEN_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });
  const tokenData = resp.data || {};
  if (!tokenData.access_token) {
    throw new Error(`Gemini OAuth token refresh failed: ${JSON.stringify(tokenData)}`);
  }
  _geminiOAuthToken = tokenData.access_token;
  _geminiOAuthExpiry = Date.now() + (tokenData.expires_in || 3600) * 1000;
  return _geminiOAuthToken;
}

async function cloudcodePost(c, apiPath, body, token, extra = {}) {
  const resp = await axios.post(`${c.baseURL}${apiPath}`, body, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(extra.headers || {}) },
    timeout: c.timeout,
    ...(extra.responseType ? { responseType: extra.responseType } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
  return resp.data;
}

async function getGeminiProject(c, token) {
  if (_geminiProjectId) return _geminiProjectId;
  const res = await cloudcodePost(
    c,
    '/v1internal:loadCodeAssist',
    {
      metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
      cloudaicompanionProject: null,
    },
    token
  );
  if (!res || !res.cloudaicompanionProject) throw new Error('loadCodeAssist returned no project');
  _geminiProjectId = res.cloudaicompanionProject;
  return _geminiProjectId;
}

function cloudcodeRequest(c, project, { system, msgs, tokens, contents }) {
  const request = {
    model: `models/${c.model}`,
    contents: contents || geminiContents(msgs),
    generationConfig: { maxOutputTokens: tokens, temperature: 0.7 },
  };
  if (system) request.systemInstruction = { parts: [{ text: system }] };
  return { model: c.model, project, request };
}

function cloudcodeText(res) {
  if (res && res.error) throw new Error(`Gemini error: ${res.error.message}`);
  return geminiText(res && res.response);
}

const geminiOAuth = {
  async chat(c, args) {
    const token = await getGeminiOAuthToken();
    const project = await getGeminiProject(c, token);
    const res = await cloudcodePost(c, '/v1internal:generateContent', cloudcodeRequest(c, project, args), token, {
      signal: args.signal,
    });
    return cloudcodeText(res);
  },
  async stream(c, args, onChunk) {
    const token = await getGeminiOAuthToken();
    const project = await getGeminiProject(c, token);
    const stream = await cloudcodePost(
      c,
      '/v1internal:streamGenerateContent?alt=sse',
      cloudcodeRequest(c, project, args),
      token,
      { responseType: 'stream', headers: { accept: 'text/event-stream' }, signal: args.signal }
    );
    let text = '';
    await readLines(stream, (line) => {
      const payload = parseSseLine(line);
      if (!payload) return;
      const piece = geminiText(payload.response || payload);
      if (piece) {
        text += piece;
        onChunk(piece);
      }
    }, streamOpts(c, args));
    return text;
  },
  async vision(c, { imageBase64, mimeType, prompt, tokens }) {
    const token = await getGeminiOAuthToken();
    const project = await getGeminiProject(c, token);
    const contents = [
      { role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: prompt }] },
    ];
    const res = await cloudcodePost(
      c,
      '/v1internal:generateContent',
      cloudcodeRequest(c, project, { tokens, contents }),
      token
    );
    return cloudcodeText(res);
  },
};

// --------------------------------------------------------------------------
// OpenAI-compatible chat completions
// --------------------------------------------------------------------------

function openaiMessages(system, msgs) {
  return system ? [{ role: 'system', content: system }, ...msgs] : msgs;
}

function openaiHeaders(c) {
  return { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' };
}

const openai = {
  async chat(c, { system, msgs, tokens, signal }) {
    const resp = await axios.post(
      `${c.baseURL}/v1/chat/completions`,
      { model: c.model, max_tokens: tokens, messages: openaiMessages(system, msgs) },
      { headers: openaiHeaders(c), timeout: c.timeout, signal }
    );
    const d = resp.data;
    return (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  },
  async stream(c, args, onChunk) {
    const { system, msgs, tokens, signal } = args;
    const resp = await axios.post(
      `${c.baseURL}/v1/chat/completions`,
      { model: c.model, max_tokens: tokens, messages: openaiMessages(system, msgs), stream: true },
      { headers: { ...openaiHeaders(c), accept: 'text/event-stream' }, timeout: c.timeout, responseType: 'stream', signal }
    );
    let text = '';
    await readLines(resp.data, (line) => {
      const payload = parseSseLine(line);
      const piece =
        payload && payload.choices && payload.choices[0] && payload.choices[0].delta
          ? payload.choices[0].delta.content || ''
          : '';
      if (piece) {
        text += piece;
        onChunk(piece);
      }
    }, streamOpts(c, args));
    return text;
  },
  async vision(c, { imageBase64, mimeType, prompt, tokens }) {
    const resp = await axios.post(
      `${c.baseURL}/v1/chat/completions`,
      {
        model: c.model,
        max_tokens: tokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
      { headers: openaiHeaders(c), timeout: c.timeout }
    );
    const d = resp.data;
    return (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  },
};

// --------------------------------------------------------------------------
// Ollama (Ollama Cloud https://ollama.com or a local server)
// --------------------------------------------------------------------------

function ollamaHeaders(c) {
  const h = { 'content-type': 'application/json' };
  // Ollama Cloud requires Bearer auth; a local Ollama ignores it.
  if (c.apiKey) h.Authorization = `Bearer ${c.apiKey}`;
  return h;
}

const ollama = {
  async chat(c, { system, msgs, tokens, signal }) {
    const resp = await axios.post(
      `${c.baseURL}/api/chat`,
      { model: c.model, messages: openaiMessages(system, msgs), stream: false, options: { num_predict: tokens } },
      { headers: ollamaHeaders(c), timeout: c.timeout, signal }
    );
    return (resp.data && resp.data.message && resp.data.message.content) || '';
  },
  async stream(c, args, onChunk) {
    const { system, msgs, tokens, signal } = args;
    const resp = await axios.post(
      `${c.baseURL}/api/chat`,
      { model: c.model, messages: openaiMessages(system, msgs), stream: true, options: { num_predict: tokens } },
      { headers: ollamaHeaders(c), timeout: c.timeout, responseType: 'stream', signal }
    );
    let text = '';
    await readLines(resp.data, (line) => {
      const payload = parseJsonLine(line);
      const piece = payload && payload.message ? payload.message.content || '' : '';
      if (piece) {
        text += piece;
        onChunk(piece);
      }
    }, streamOpts(c, args));
    return text;
  },
};

// --------------------------------------------------------------------------
// Anthropic — explicit opt-in only (AI_PROVIDER=anthropic). Not a default.
// --------------------------------------------------------------------------

const anthropic = {
  async chat(c, { system, msgs, tokens, signal }) {
    const resp = await axios.post(
      `${c.baseURL}/v1/messages`,
      { model: c.model, max_tokens: tokens, system: system || undefined, messages: msgs },
      {
        headers: { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: c.timeout,
        signal,
      }
    );
    const d = resp.data;
    return (d && d.content && d.content[0] && d.content[0].text) || '';
  },
};

const IMPL = { google, 'gemini-oauth': geminiOAuth, openai, ollama, anthropic };

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

async function chat({ system, messages, maxTokens, provider, model } = {}) {
  const c = requireConfig({ provider, model });
  const args = { system, msgs: normalizeMessages(messages), tokens: maxTokens || c.maxTokens };
  try {
    const text = await IMPL[c.name].chat(c, args);
    return { text: text || '', provider: c.name, model: c.model };
  } catch (err) {
    return wrapError(err, c);
  }
}

// Streams the answer through onChunk(textPiece). Real token streaming for providers
// that support it; providers without a stream path get the full answer cut into chunks.
function abortedError() {
  return new AppError(499, 'AI_ABORTED', 'AI request aborted: the client disconnected');
}

async function chatStream({ system, messages, maxTokens, provider, model, signal } = {}, onChunk) {
  const c = requireConfig({ provider, model });
  if (signal && signal.aborted) throw abortedError();
  // After an abort no further chunk reaches the caller (it may write to a closed socket).
  const emit = (piece) => {
    if (signal && signal.aborted) return;
    if (typeof onChunk === 'function') onChunk(piece);
  };
  const args = { system, msgs: normalizeMessages(messages), tokens: maxTokens || c.maxTokens, signal };
  const impl = IMPL[c.name];
  try {
    if (c.canStream && typeof impl.stream === 'function') {
      const text = await impl.stream(c, args, emit);
      if (signal && signal.aborted) throw abortedError();
      return { text: text || '', provider: c.name, model: c.model, streamed: true };
    }
    const text = (await impl.chat(c, args)) || '';
    if (signal && signal.aborted) throw abortedError();
    for (const piece of chunkText(text)) emit(piece);
    return { text, provider: c.name, model: c.model, streamed: false };
  } catch (err) {
    if (signal && signal.aborted) {
      logger.info({ provider: c.name }, 'AI stream aborted by client');
      throw abortedError();
    }
    return wrapError(err, c);
  }
}

async function vision({ imageBase64, mimeType, prompt, maxTokens, provider, model } = {}) {
  const c = requireConfig({ provider, model });
  const impl = IMPL[c.name];
  if (!c.canVision || typeof impl.vision !== 'function') {
    throw new AppError(501, 'AI_VISION_UNSUPPORTED', `Provider "${c.name}" has no vision support`);
  }
  if (!imageBase64) {
    throw new AppError(400, 'EMPTY_IMAGE', 'imageBase64 is required');
  }
  const args = {
    imageBase64: String(imageBase64),
    mimeType: mimeType || 'image/jpeg',
    prompt: prompt || 'Describe this image.',
    tokens: maxTokens || c.maxTokens,
  };
  try {
    const text = await impl.vision(c, args);
    return { text: text || '', provider: c.name, model: c.model };
  } catch (err) {
    return wrapError(err, c);
  }
}

module.exports = {
  chat,
  chatStream,
  vision,
  isConfigured,
  supportsStreaming,
  supportsVision,
  resolveProviderName,
  describe,
  // test hooks / internals
  _internal: { config, chunkText, parseSseLine, readLines, resetOAuthCache, DEFAULTS, AUTO_ORDER },
};
