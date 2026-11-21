// routes/vault.js — Finman Vault API (mounted at /api/vault, JWT). docs/E2E-ENCRYPTION.md §8.
//
//   GET  /meta           state, version, size, wraps, KDF salt/params, legacy row count
//   GET  /blob           the encrypted vault (application/octet-stream, X-Vault-Version)
//   PUT  /blob           new ciphertext; If-Match: <version> required, 409 VERSION_CONFLICT
//   POST /setup          first upload + wraps; password accounts switch to bcrypt(authToken)
//   GET  /legacy-export  the user's plaintext rows (migration source, before purge)
//   POST /purge-legacy   delete the plaintext rows when the client's counts match ours
//   POST /rewrap         new wrapped_pw (password change) and/or new wrapped_rc
//
// Body parsers for /setup (JSON 25 MB) and PUT /blob (raw 25 MB) are mounted in
// server.js before the global 10 MB JSON parser.
'use strict';

const express = require('express');
const passport = require('passport');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query, get, run, transaction } = require('../db/database');
const config = require('../config/config');
const User = require('../models/user');
const tracker = require('../services/tracker');
const vault = require('../services/vault');
const logger = require('../lib/logger');
const { VAULT_TABLES, paramsFor } = require('../lib/vaultTables');

const router = express.Router();
router.use(passport.authenticate('jwt', { session: false }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const MAX_BLOB = 25 * 1024 * 1024;
const MAGIC = Buffer.from('FMV1');
const bad = (res, status, code, message, extra = {}) => res.status(status).json({ error: true, code, message, ...extra });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function signToken(user) {
  return jwt.sign({ id: user.id, tv: Number(user.token_version || 0) }, config.jwtSecret, { expiresIn: config.jwtExpiration });
}
const bcryptRounds = () => config.bcryptRounds || 12;

// "FMV1" | iv(12) | ciphertext+tag(≥16). Anything else is not a vault (e.g. a plain SQLite file).
function looksEncrypted(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 32 && buf.subarray(0, 4).equals(MAGIC);
}

async function fullUser(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

// vault_sync: at most one event per user per UTC day (lifecycle reads it as activity).
const syncDay = new Map();
async function trackSync(req) {
  const uid = req.user.id;
  const day = new Date().toISOString().slice(0, 10);
  if (syncDay.get(uid) === day) return;
  syncDay.set(uid, day);
  if (syncDay.size > 20000) syncDay.clear();
  const seen = await get(
    `SELECT 1 AS x FROM analytics_events WHERE user_id = ? AND event = 'vault_sync' AND created_at >= date('now') LIMIT 1`, [uid],
  ).catch(() => null);
  if (!seen) tracker.track('vault_sync', { userId: uid, req, test: tracker.isTestEmail(req.user.email) });
}

router.get('/meta', wrap(async (req, res) => {
  const u = await fullUser(req.user.id);
  if (!u) return bad(res, 404, 'NOT_FOUND', 'User not found');
  const v = await vault.vaultRow(u.id);
  const methods = await User.authMethods(u.id);
  const counts = await vault.legacyCounts(u.id);
  res.json({
    state: u.vault_state || 'none',
    version: v ? v.version : null,
    size: v ? v.size : null,
    updated_at: v ? v.updated_at : null,
    wrapped_pw: v ? v.wrapped_pw : null,
    wrapped_rc: v ? v.wrapped_rc : null,
    kdf: u.kdf || 'legacy',
    salt: u.kdf_salt || null,
    params: u.kdf_params ? JSON.parse(u.kdf_params) : null,
    hasPassword: methods.password,
    legacyRows: vault.sum(counts),
  });
}));

router.get('/blob', wrap(async (req, res) => {
  const v = await vault.vaultRow(req.user.id, { withBlob: true });
  if (!v) return bad(res, 404, 'NO_VAULT', 'No vault yet');
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Vault-Version', String(v.version));
  res.set('Access-Control-Expose-Headers', 'X-Vault-Version');
  return res.end(Buffer.from(v.blob));
}));

router.put('/blob', wrap(async (req, res) => {
  const ifMatch = String(req.get('If-Match') || '').replace(/^W\//, '').replace(/"/g, '').trim();
  if (!/^\d+$/.test(ifMatch)) return bad(res, 428, 'IF_MATCH_REQUIRED', 'If-Match: <version> is required');
  const expected = Number(ifMatch);
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) return bad(res, 400, 'EMPTY_BODY', 'Vault body is empty');
  if (!looksEncrypted(body)) return bad(res, 400, 'NOT_ENCRYPTED', 'Body is not an encrypted Finman vault');
  const r = await run(
    `UPDATE user_vaults SET blob = ?, size = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND version = ?`,
    [body, body.length, req.user.id, expected],
  );
  if (!r.changes) {
    const v = await vault.vaultRow(req.user.id);
    if (!v) return bad(res, 404, 'NO_VAULT', 'Set up the vault first');
    return bad(res, 409, 'VERSION_CONFLICT', 'The vault changed on another device', { version: v.version });
  }
  trackSync(req).catch(() => {});
  return res.json({ version: expected + 1 });
}));

router.post('/setup', wrap(async (req, res) => {
  const b = req.body || {};
  const uid = req.user.id;
  if (typeof b.blob_b64 !== 'string' || !b.blob_b64) return bad(res, 400, 'BAD_BLOB', 'blob_b64 is required');
  const blob = Buffer.from(b.blob_b64, 'base64');
  if (!looksEncrypted(blob)) return bad(res, 400, 'NOT_ENCRYPTED', 'blob_b64 is not an encrypted Finman vault');
  if (blob.length > MAX_BLOB) return bad(res, 413, 'TOO_LARGE', 'Vault is too large');
  if (!vault.isWrap(b.wrapped_pw) || !vault.isWrap(b.wrapped_rc)) return bad(res, 400, 'BAD_WRAP', 'wrapped_pw and wrapped_rc are required');
  if (!vault.isSalt(b.kdf_salt)) return bad(res, 400, 'BAD_SALT', 'kdf_salt must be 16 bytes, base64');
  const params = vault.normalizeParams(b.kdf_params);
  if (!params) return bad(res, 400, 'BAD_PARAMS', 'kdf_params are invalid or too weak');

  const u = await fullUser(uid);
  if (!u) return bad(res, 404, 'NOT_FOUND', 'User not found');
  if (await vault.vaultRow(uid)) return bad(res, 409, 'VAULT_EXISTS', 'The vault is already set up');

  const methods = await User.authMethods(uid);
  // A Google/Apple account that also signs in with a password (it gave it here) is
  // switched too: otherwise that raw password would keep reaching the server.
  const passwordLogin = methods.password || (typeof b.current_password === 'string' && b.current_password.length > 0);
  let newHash = null;
  if (passwordLogin) {
    if (!vault.isAuthToken(b.auth_token)) return bad(res, 400, 'BAD_AUTH_TOKEN', 'auth_token is required (fm1$ + 64 hex)');
    if (u.kdf === 'fm1') {
      // Registered with the vault scheme: the hash already is bcrypt(authToken).
      if (u.kdf_salt && u.kdf_salt !== b.kdf_salt) return bad(res, 400, 'SALT_MISMATCH', 'kdf_salt differs from the account salt');
      if (!(await User.verifyPassword(u, b.auth_token))) return bad(res, 400, 'wrong_password', 'Current password is incorrect');
    } else {
      const ok = typeof b.current_password === 'string' && b.current_password.length > 0
        && await User.verifyPassword(u, b.current_password);
      // 400, never 401: the client treats 401 as an expired session.
      if (!ok) return bad(res, 400, 'wrong_password', 'Current password is incorrect');
      newHash = await bcrypt.hash(b.auth_token, bcryptRounds());
    }
  }

  try {
    await transaction(async () => {
      await run(
        `INSERT INTO user_vaults (user_id, version, blob, size, wrapped_pw, wrapped_rc) VALUES (?, 1, ?, ?, ?, ?)`,
        [uid, blob, blob.length, b.wrapped_pw, b.wrapped_rc],
      );
      // The password itself is the same, so other sessions stay valid (no token_version bump).
      if (newHash) {
        await run(`UPDATE users SET password = ?, kdf = 'fm1', kdf_salt = ?, kdf_params = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [newHash, b.kdf_salt, params, uid]);
      } else {
        // Registered with the vault scheme (kdf already 'fm1'), or a
        // Google/Apple account with a separate vault password: only the vault KDF is stored.
        // users.kdf says how the LOGIN password is sent; it stays 'legacy', otherwise an
        // account that also has a linked password could no longer sign in with it.
        await run(`UPDATE users SET kdf_salt = ?, kdf_params = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [b.kdf_salt, params, uid]);
      }
    });
  } catch (e) {
    if (/UNIQUE constraint failed: user_vaults|PRIMARY KEY/.test(e.message || '')) {
      return bad(res, 409, 'VAULT_EXISTS', 'The vault is already set up');
    }
    throw e;
  }
  tracker.track('vault_setup', { userId: uid, req, test: tracker.isTestEmail(u.email) });
  return res.json({ version: 1, state: u.vault_state || 'none', kdf: 'fm1' });
}));

router.get('/legacy-export', wrap(async (req, res) => {
  const u = await User.findById(req.user.id);
  if (!u) return bad(res, 404, 'NOT_FOUND', 'User not found');
  const tables = await vault.legacyExport(u.id);
  res.json({
    schema: 1,
    user: {
      id: u.id, username: u.username, email: u.email, full_name: u.full_name,
      created_at: u.created_at, timezone: u.timezone || null, subscription_tier: u.subscription_tier || null,
    },
    tables,
  });
}));

router.post('/purge-legacy', wrap(async (req, res) => {
  const uid = req.user.id;
  const client = (req.body && req.body.counts && typeof req.body.counts === 'object') ? req.body.counts : null;
  if (!client) return bad(res, 400, 'COUNTS_REQUIRED', 'counts is required');
  if (!(await vault.vaultRow(uid))) return bad(res, 409, 'NO_VAULT', 'Upload the vault before purging');

  const clientCounts = {};
  for (const t of VAULT_TABLES) clientCounts[t.name] = Number(client[t.name] || 0);

  let mismatch = null;
  const deleted = {};
  // Freed pages are zeroed as they are freed (WAL included); VACUUM later compacts the file.
  await run('PRAGMA secure_delete = ON');
  try {
    await transaction(async () => {
      // Counted inside the transaction: no write can slip in between the check and the delete.
      const server = await vault.legacyCounts(uid);
      if (Object.keys(server).some((name) => server[name] !== clientCounts[name])) {
        mismatch = server;
        return;
      }
      await run('PRAGMA defer_foreign_keys = ON');
      const fkKey = (x) => `${x.table}:${x.rowid}:${x.parent}`;
      const fkBefore = new Set((await query('PRAGMA foreign_key_check')).map(fkKey));
      for (const t of VAULT_TABLES) deleted[t.name] = 0;
      for (const t of (await vault.presentTables()).slice().reverse()) {
        const r = await run(`DELETE FROM ${t.name} WHERE ${t.where}`, paramsFor(t, uid));
        deleted[t.name] = r.changes || 0;
      }
      const broken = (await query('PRAGMA foreign_key_check')).filter((x) => !fkBefore.has(fkKey(x)));
      if (broken.length) {
        const err = new Error('FK_BLOCKED');
        err.fkTables = [...new Set(broken.map((x) => x.table))];
        throw err;
      }
      await run(`UPDATE users SET vault_state = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [uid]);
    });
  } catch (e) {
    if (e.message === 'FK_BLOCKED') {
      logger.warn({ tables: e.fkTables, userId: uid }, '[vault] purge blocked by foreign keys');
      return bad(res, 409, 'FK_BLOCKED', 'Other data still points at these rows', { tables: e.fkTables });
    }
    throw e;
  } finally {
    await run('PRAGMA secure_delete = OFF').catch(() => {});
  }
  if (mismatch) return bad(res, 409, 'COUNT_MISMATCH', 'Row counts differ', { server: mismatch, client: clientCounts });

  await query('PRAGMA wal_checkpoint(TRUNCATE)').catch((e) => logger.warn({ err: e.message }, '[vault] checkpoint failed'));
  vault.scheduleVacuum();
  tracker.track('vault_purged', { userId: uid, req, test: tracker.isTestEmail(req.user.email) });
  return res.json({ deleted, state: 'active' });
}));

router.post('/rewrap', wrap(async (req, res) => {
  const b = req.body || {};
  const uid = req.user.id;
  const v = await vault.vaultRow(uid);
  if (!v) return bad(res, 404, 'NO_VAULT', 'No vault yet');
  if (b.wrapped_pw != null && !vault.isWrap(b.wrapped_pw)) return bad(res, 400, 'BAD_WRAP', 'wrapped_pw is invalid');
  if (b.wrapped_rc != null && !vault.isWrap(b.wrapped_rc)) return bad(res, 400, 'BAD_WRAP', 'wrapped_rc is invalid');
  if (b.wrapped_pw == null && b.wrapped_rc == null && b.auth_token == null) return bad(res, 400, 'NOTHING_TO_DO', 'wrapped_pw or wrapped_rc is required');

  const u = await fullUser(uid);
  const methods = await User.authMethods(uid);
  let newHash = null;
  if (b.auth_token != null || (methods.password && b.wrapped_pw != null)) {
    // Password change: the new wrap and the new authToken travel together.
    if (!vault.isAuthToken(b.auth_token)) return bad(res, 400, 'BAD_AUTH_TOKEN', 'auth_token is required (fm1$ + 64 hex)');
    if (b.wrapped_pw == null) return bad(res, 400, 'VAULT_REWRAP_REQUIRED', 'wrapped_pw is required with a new password');
    const ok = vault.isAuthToken(b.current_auth_token) && await User.verifyPassword(u, b.current_auth_token);
    if (!ok) return bad(res, 400, 'wrong_password', 'Current password is incorrect');
    newHash = await bcrypt.hash(b.auth_token, bcryptRounds());
  }

  await transaction(async () => {
    const sets = [];
    const params = [];
    if (b.wrapped_pw != null) { sets.push('wrapped_pw = ?'); params.push(b.wrapped_pw); }
    if (b.wrapped_rc != null) { sets.push('wrapped_rc = ?'); params.push(b.wrapped_rc); }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    await run(`UPDATE user_vaults SET ${sets.join(', ')} WHERE user_id = ?`, [...params, uid]);
    if (newHash) {
      await run(`UPDATE users SET password = ?, kdf = 'fm1', token_version = COALESCE(token_version, 0) + 1,
                 updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newHash, uid]);
    }
  });
  const out = { ok: true };
  if (newHash) {
    // Same as PUT /api/auth/me: older tokens are revoked, this session gets a new one.
    out.token = signToken(await get('SELECT id, token_version FROM users WHERE id = ?', [uid]));
  }
  return res.json(out);
}));

module.exports = router;
