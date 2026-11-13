// services/appHandoff.js — Google sign-in from the native app.
//
// The app cannot read the system browser's cookies or URL, so the browser leg
// leaves its result here and the app picks it up:
//   1. the app makes a random 64-hex nonce and opens
//      /api/auth/google?app_nonce=<nonce> in the system browser;
//   2. the Google callback stores sha256(nonce) -> JWT (or an error code);
//   3. the app POSTs the raw nonce to /api/auth/app/claim and gets the result once.
// Only the hash is stored, so a database read cannot be turned into a claim.
// Rows expire after 10 minutes and are deleted on the first claim.
const crypto = require('crypto');
const { get, run, transaction } = require('../db/database');

const TTL_MS = 10 * 60 * 1000;
const NONCE_RE = /^[a-f0-9]{64}$/;

function isValidNonce(nonce) {
  return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

function hashNonce(nonce) {
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

async function store(nonce, { token = null, error = null }) {
  if (!isValidNonce(nonce)) return false;
  const now = Date.now();
  await run(`DELETE FROM app_auth_handoff WHERE expires_at < ?`, [now]);
  await run(
    `INSERT OR REPLACE INTO app_auth_handoff (nonce_hash, token, error, expires_at) VALUES (?, ?, ?, ?)`,
    [hashNonce(nonce), token, error, now + TTL_MS]
  );
  return true;
}

// -> { token } | { error } | null (missing, expired or already claimed)
async function claim(nonce) {
  if (!isValidNonce(nonce)) return null;
  const h = hashNonce(nonce);
  return transaction(async () => {
    const row = await get(`SELECT token, error, expires_at FROM app_auth_handoff WHERE nonce_hash = ?`, [h]);
    if (!row) return null;
    await run(`DELETE FROM app_auth_handoff WHERE nonce_hash = ?`, [h]);
    if (Number(row.expires_at) < Date.now()) return null;
    if (row.token) return { token: row.token };
    return { error: row.error || 'google_failed' };
  });
}

module.exports = { store, claim, isValidNonce, hashNonce, TTL_MS };
