// services/userAi/keys.js — the person's own AI keys.
//
// Saved only after the provider accepts the key (a model list call). Stored with
// config.encryptToken (AES-256-GCM); the API returns only a mask (provider + last 4).
// The plain key is decrypted right before a call and never logged or returned.
'use strict';

const { get, query, run } = require('../../db/database');
const config = require('../../config/config');
const providers = require('./providers');

const { UserAiError } = providers;
const MAX_KEYS = 10;

const mask = (hint) => `••••${hint || ''}`;
function publicKey(row) {
  if (!row) return null;
  const p = providers.PROVIDERS[row.provider] || {};
  return {
    id: row.id,
    provider: row.provider,
    provider_name: p.name || row.provider,
    label: row.label || '',
    key_mask: mask(row.key_hint),
    model: row.model || '',
    base_url: row.provider === 'custom' ? row.base_url || '' : null,
    is_default: !!row.is_default,
    last_used_at: row.last_used_at || null,
    last_error: row.last_error || null,
    created_at: row.created_at,
  };
}

function cleanKey(raw) {
  const key = String(raw || '').trim().replace(/^Bearer\s+/i, '');
  if (!key) throw new UserAiError('AI_NO_KEY', 'Paste your API key');
  if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw new UserAiError('AI_BAD_KEY', 'This does not look like an API key');
  return key;
}

async function list(userId) {
  const rows = await query('SELECT * FROM user_ai_keys WHERE user_id = ? ORDER BY is_default DESC, id DESC', [userId]);
  return rows.map(publicKey);
}

async function rowFor(userId, id) {
  const row = await get('SELECT * FROM user_ai_keys WHERE id = ? AND user_id = ?', [parseInt(id, 10) || 0, userId]);
  if (!row) throw new UserAiError('AI_KEY_NOT_FOUND', 'Key not found', 404);
  return row;
}

async function add(userId, { provider, key, label, model, base_url: baseUrl }) {
  if (!providers.PROVIDERS[provider]) throw new UserAiError('AI_BAD_PROVIDER', 'Choose an AI provider');
  const plain = cleanKey(key);
  const base = provider === 'custom' ? providers.checkBaseUrl(baseUrl) : null;
  const count = await get('SELECT COUNT(*) AS n FROM user_ai_keys WHERE user_id = ?', [userId]);
  if (count && count.n >= MAX_KEYS) throw new UserAiError('AI_TOO_MANY_KEYS', `Up to ${MAX_KEYS} keys`);

  const { models, defaultModel } = await providers.listModels({ provider, key: plain, baseUrl: base });
  let chosen = String(model || '').trim().slice(0, 200);
  if (!chosen) chosen = defaultModel;
  if (!chosen) throw new UserAiError('AI_NO_MODEL', 'The key works, but no chat model is available for it');

  const hasDefault = await get('SELECT id FROM user_ai_keys WHERE user_id = ? AND is_default = 1', [userId]);
  const r = await run(
    `INSERT INTO user_ai_keys (user_id, provider, label, key_enc, key_hint, model, base_url, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, provider, String(label || '').trim().slice(0, 60), config.encryptToken(plain), plain.slice(-4), chosen, base, hasDefault ? 0 : 1],
  );
  const row = await rowFor(userId, r.id);
  return { key: publicKey(row), models };
}

async function update(userId, id, { model, label, is_default: isDefault }) {
  const row = await rowFor(userId, id);
  if (model !== undefined) {
    const m = String(model || '').trim().slice(0, 200);
    if (!m) throw new UserAiError('AI_NO_MODEL', 'Choose a model');
    await run('UPDATE user_ai_keys SET model = ?, last_error = NULL WHERE id = ?', [m, row.id]);
  }
  if (label !== undefined) await run('UPDATE user_ai_keys SET label = ? WHERE id = ?', [String(label || '').trim().slice(0, 60), row.id]);
  if (isDefault === true) {
    await run('UPDATE user_ai_keys SET is_default = 0 WHERE user_id = ?', [userId]);
    await run('UPDATE user_ai_keys SET is_default = 1 WHERE id = ?', [row.id]);
  }
  return publicKey(await rowFor(userId, row.id));
}

async function remove(userId, id) {
  const row = await rowFor(userId, id);
  await run('DELETE FROM user_ai_keys WHERE id = ?', [row.id]);
  if (row.is_default) {
    const next = await get('SELECT id FROM user_ai_keys WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    if (next) await run('UPDATE user_ai_keys SET is_default = 1 WHERE id = ?', [next.id]);
  }
  await run('UPDATE ai_agent_threads SET key_id = NULL WHERE user_id = ? AND key_id = ?', [userId, row.id]);
  return { deleted: true };
}

// The stored key cannot be read (server encryption key changed): ask to add it again.
function plain(row) {
  try {
    const s = config.decryptToken(row.key_enc);
    if (s) return s;
  } catch (_) { /* below */ }
  throw new UserAiError('AI_KEY_REJECTED', 'This saved key can no longer be read. Remove it and add it again', 400);
}

async function models(userId, id) {
  const row = await rowFor(userId, id);
  return providers.listModels({ provider: row.provider, key: plain(row), baseUrl: row.base_url });
}

// For the agent: the key to use (explicit id, else the default one) with the plain secret.
async function resolve(userId, id) {
  const row = id
    ? await rowFor(userId, id)
    : await get('SELECT * FROM user_ai_keys WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [userId]);
  if (!row) throw new UserAiError('AI_NO_KEY', 'Connect your AI first: add an API key', 400);
  return { row, secret: plain(row) };
}

async function markUsed(id, error) {
  await run('UPDATE user_ai_keys SET last_used_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?', [error ? String(error).slice(0, 300) : null, id]);
}

module.exports = { list, add, update, remove, models, resolve, markUsed, publicKey, MAX_KEYS };
