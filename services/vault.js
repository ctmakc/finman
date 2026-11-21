// services/vault.js — server side of Finman Vault (docs/E2E-ENCRYPTION.md).
// The server never sees the vault key or the password of an fm1 account: it stores
// ciphertext, key wraps, the public KDF salt/params and bcrypt(authToken).
'use strict';

const crypto = require('crypto');
const { query, get, run } = require('../db/database');
const config = require('../config/config');
const logger = require('../lib/logger');
const { VAULT_TABLES, paramsFor } = require('../lib/vaultTables');

const DEFAULT_PARAMS = Object.freeze({ alg: 'argon2id', m: 65536, t: 3, p: 1, len: 32 });
const DEFAULT_PARAMS_JSON = JSON.stringify(DEFAULT_PARAMS);
const AUTH_TOKEN_RE = /^fm1\$[0-9a-f]{64}$/;
// "w1.<iv b64>.<ct b64>" (public/js/vault/crypto.js wrap()).
const WRAP_RE = /^w1\.[A-Za-z0-9+/=_-]{8,64}\.[A-Za-z0-9+/=_-]{16,256}$/;

const isAuthToken = (s) => typeof s === 'string' && AUTH_TOKEN_RE.test(s);
const isWrap = (s) => typeof s === 'string' && WRAP_RE.test(s);

function isSalt(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]{22}(==)?$/.test(s)) return false;
  return Buffer.from(s, 'base64').length === 16;
}

// Same floor as the client (crypto.js parseParams): nobody may weaken the KDF.
// Returns the canonical JSON string or null.
function normalizeParams(p) {
  let v = p;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return null; } }
  if (!v || typeof v !== 'object') return null;
  const out = { alg: v.alg, m: Number(v.m), t: Number(v.t), p: Number(v.p), len: Number(v.len) };
  if (out.alg !== 'argon2id') return null;
  if (![out.m, out.t, out.p, out.len].every(Number.isInteger)) return null;
  if (out.m < 19456 || out.m > 1048576 || out.t < 2 || out.t > 20 || out.p < 1 || out.p > 16 || out.len !== 32) return null;
  return JSON.stringify(out);
}

// Unknown login: a stable salt, so asking twice does not reveal that the account is missing.
function fakeSalt(login) {
  return crypto.createHmac('sha256', String(config.jwtSecret))
    .update('finman-prelogin:' + String(login || '').trim().toLowerCase())
    .digest().subarray(0, 16).toString('base64');
}

async function vaultRow(userId, { withBlob = false } = {}) {
  const cols = 'user_id, version, size, wrapped_pw, wrapped_rc, created_at, updated_at' + (withBlob ? ', blob' : '');
  return get(`SELECT ${cols} FROM user_vaults WHERE user_id = ?`, [userId]);
}

// A vault user: setup done (row exists) or already purged. Their financial rows on
// the server are stale or gone, so server-side numbers must not be shown to them.
async function isVaultUser(userId) {
  const r = await get(
    `SELECT 1 AS x FROM users u WHERE u.id = ? AND (u.vault_state = 'active'
       OR EXISTS (SELECT 1 FROM user_vaults v WHERE v.user_id = u.id))`, [userId],
  ).catch(() => null);
  return Boolean(r);
}
// SQL fragment for job queries: true for vault users (alias of users = `alias`).
const VAULT_USER_SQL = (alias = 'u') =>
  `(${alias}.vault_state = 'active' OR EXISTS (SELECT 1 FROM user_vaults vv WHERE vv.user_id = ${alias}.id))`;

// VAULT_TABLES that exist in this database. Two may be missing: ai_chat_sessions exists
// only on databases that started on the old prod line (migrations/017 did not port it),
// onboarding_progress is created lazily by routes/onboarding.js on first use.
async function presentTables() {
  const names = new Set((await query(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name));
  return VAULT_TABLES.filter((t) => names.has(t.name));
}

// { table: n } for every VAULT_TABLES entry (missing tables = 0).
async function legacyCounts(userId) {
  const out = {};
  for (const t of VAULT_TABLES) out[t.name] = 0;
  for (const t of await presentTables()) {
    const r = await get(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${t.where}`, paramsFor(t, userId));
    out[t.name] = Number((r && r.n) || 0);
  }
  return out;
}

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

// Server-encrypted secrets inside the vault tables. user_ai_keys: the browser talks to
// the AI provider itself, so the key goes into the vault readable (key_plain), the
// server copy is deleted with the purge. Bank tokens: bank sync is off in vault mode,
// and the tokens are useless outside the server — they are left out.
const STRIP = { bank_connections: ['access_token', 'refresh_token'] };

function exportRow(table, row) {
  const out = { ...row };
  for (const c of STRIP[table] || []) if (c in out) out[c] = null;
  if (table === 'user_ai_keys') {
    let plain = null;
    try { plain = config.decryptToken(row.key_enc) || null; } catch (_) { plain = null; }
    out.key_plain = plain;
  }
  for (const [k, v] of Object.entries(out)) {
    if (Buffer.isBuffer(v)) out[k] = { $b64: v.toString('base64') };
  }
  return out;
}

async function legacyExport(userId) {
  const tables = {};
  for (const t of VAULT_TABLES) tables[t.name] = [];
  for (const t of await presentTables()) {
    const rows = await query(`SELECT * FROM ${t.name} WHERE ${t.where}`, paramsFor(t, userId));
    tables[t.name] = rows.map((r) => exportRow(t.name, r));
  }
  return tables;
}

// ---- VACUUM after a purge: freed plaintext pages must not stay in the file ----------
const VACUUM_EVERY_MS = 10 * 60 * 1000;
let lastVacuumAt = 0;
let vacuumTimer = null;

function scheduleVacuum() {
  if (vacuumTimer) return false;
  const delay = Math.max(Number(process.env.VAULT_VACUUM_DELAY_MS || 30000), lastVacuumAt + VACUUM_EVERY_MS - Date.now());
  vacuumTimer = setTimeout(async () => {
    vacuumTimer = null;
    lastVacuumAt = Date.now();
    try {
      // run() goes through the write queue, so VACUUM never lands inside a transaction.
      await run('VACUUM');
      await query('PRAGMA wal_checkpoint(TRUNCATE)');
      logger.info('[vault] vacuum done');
    } catch (e) {
      logger.warn({ err: e.message }, '[vault] vacuum failed');
    }
  }, delay);
  if (vacuumTimer.unref) vacuumTimer.unref();
  return true;
}

function _resetVacuum() {
  if (vacuumTimer) clearTimeout(vacuumTimer);
  vacuumTimer = null;
  lastVacuumAt = 0;
}

module.exports = {
  DEFAULT_PARAMS, DEFAULT_PARAMS_JSON, isAuthToken, isWrap, isSalt, normalizeParams, fakeSalt,
  vaultRow, isVaultUser, VAULT_USER_SQL, presentTables, legacyCounts, sum, legacyExport, exportRow,
  scheduleVacuum, _resetVacuum,
};
