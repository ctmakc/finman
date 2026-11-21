// engine/src/aiProvider.js — replaces lib/ai/provider.js inside the engine.
// The server's default LLM (our Gemini / Ollama account) never sees vault data, so here the
// "provider" is the user's own key from the local user_ai_keys table (services/userAi):
// the default key, else the newest. No key -> isConfigured() is false and every call fails
// with AppError 503 AI_KEY_REQUIRED. Same exports as lib/ai/provider.js.
'use strict';

const { AppError } = require('../../middleware/error');
const { ctx } = require('./context');
const db = require('../shims/database');

const KEY_REQUIRED_MESSAGE = 'Connect your own AI key (Settings → Your AI). Your data is encrypted, so Finman AI cannot read it; your own ChatGPT, Claude or Gemini key works right from this device.';

function keyRequired() {
  return new AppError(503, 'AI_KEY_REQUIRED', KEY_REQUIRED_MESSAGE);
}

function keyRow() {
  if (!ctx.sql || !ctx.user) return null;
  try {
    return db._sync.get('SELECT id, provider, model FROM user_ai_keys WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [ctx.user.id]) || null;
  } catch (_) {
    return null;
  }
}

function isConfigured() { return !!keyRow(); }
function supportsStreaming() { return false; }
function supportsVision() { return false; }
function resolveProviderName() { const r = keyRow(); return r ? r.provider : null; }
function describe() {
  const r = keyRow();
  return r ? { provider: r.provider, model: r.model, configured: true, own: true } : { provider: null, model: null, configured: false, own: true };
}

async function complete({ system, messages, maxTokens }) {
  if (!ctx.user) throw keyRequired();
  const keys = require('../../services/userAi/keys');
  const providers = require('../../services/userAi/providers');
  let resolved;
  try {
    resolved = await keys.resolve(ctx.user.id);
  } catch (e) {
    if (e && e.code === 'AI_NO_KEY') throw keyRequired();
    throw new AppError(e.status || 400, e.code || 'AI_PROVIDER_ERROR', e.message);
  }
  const { row, secret } = resolved;
  const neutral = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, text: String(m.content == null ? '' : m.content) }));
  try {
    const out = await providers.complete({ provider: row.provider, key: secret, model: row.model, baseUrl: row.base_url, system: system || '', messages: neutral, tools: [] });
    await keys.markUsed(row.id, null);
    return { text: out.text || '', provider: row.provider, model: row.model };
  } catch (e) {
    try { await keys.markUsed(row.id, e && e.message); } catch (_) { /* ignore */ }
    if (e instanceof providers.UserAiError) throw new AppError(e.status || 502, e.code, e.message);
    throw e;
  }
}

async function chat(args = {}) {
  return complete(args);
}

async function chatStream(args = {}, onChunk) {
  const { signal } = args;
  if (signal && signal.aborted) throw new AppError(499, 'AI_ABORTED', 'AI request aborted');
  const r = await complete(args);
  if (signal && signal.aborted) throw new AppError(499, 'AI_ABORTED', 'AI request aborted');
  if (typeof onChunk === 'function') {
    for (let i = 0; i < r.text.length; i += 60) onChunk(r.text.slice(i, i + 60));
  }
  return { ...r, streamed: false };
}

async function vision() {
  throw new AppError(501, 'AI_VISION_UNSUPPORTED', 'Receipt recognition with AI is not available in the encrypted vault yet');
}

module.exports = {
  chat, chatStream, vision, isConfigured, supportsStreaming, supportsVision, resolveProviderName, describe,
  KEY_REQUIRED_MESSAGE,
  _internal: { DEFAULTS: {}, AUTO_ORDER: [] },
};
