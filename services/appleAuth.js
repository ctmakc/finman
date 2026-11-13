// services/appleAuth.js — Sign in with Apple for the native iOS app.
//
// The app gets an identity token (a JWT signed by Apple) from the system sheet
// and posts it to POST /api/auth/apple together with the raw nonce it passed to
// Apple. Here we:
//   - verify the RS256 signature against Apple's published keys (cached 1 hour);
//   - check iss, aud (our bundle id), exp and the nonce;
//   - find or create the Finman user with the same email policy as Google;
//   - optionally (SIWA key configured) exchange the authorization code for a
//     refresh token, so account deletion can revoke it at Apple.
// Nothing here logs tokens, codes or nonces.
const crypto = require('crypto');
const fs = require('fs');
const config = require('../config/config');
const User = require('../models/user');
const { run, get } = require('../db/database');

const APPLE_ISSUER = 'https://appleid.apple.com';
const JWKS_URL = 'https://appleid.apple.com/auth/keys';
const TOKEN_URL = 'https://appleid.apple.com/auth/token';
const REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_MIN_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;
const HTTP_TIMEOUT_MS = 8000;

class AppleAuthError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

let jwksCache = { keys: null, fetchedAt: 0 };

function resetJwksCache() {
  jwksCache = { keys: null, fetchedAt: 0 };
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function loadJwks(force) {
  const age = Date.now() - jwksCache.fetchedAt;
  if (jwksCache.keys && !force && age < JWKS_TTL_MS) return jwksCache.keys;
  if (jwksCache.keys && force && age < JWKS_REFETCH_MIN_MS) return jwksCache.keys;
  const res = await fetchWithTimeout(JWKS_URL);
  if (!res.ok) throw new AppleAuthError('apple_keys_unavailable', 503);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new AppleAuthError('apple_keys_unavailable', 503);
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return jwksCache.keys;
}

async function keyFor(kid) {
  let keys = await loadJwks(false);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    // Apple rotates keys: one refetch (at most once a minute) before giving up.
    keys = await loadJwks(true);
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new AppleAuthError('invalid_token');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function b64urlJson(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch (_) {
    throw new AppleAuthError('invalid_token');
  }
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// -> { sub, email, emailVerified }
async function verifyIdentityToken(identityToken, rawNonce) {
  if (typeof identityToken !== 'string' || identityToken.length > 8000) throw new AppleAuthError('invalid_token', 400);
  if (typeof rawNonce !== 'string' || rawNonce.length < 16 || rawNonce.length > 256) {
    throw new AppleAuthError('invalid_nonce', 400);
  }
  const parts = identityToken.split('.');
  if (parts.length !== 3) throw new AppleAuthError('invalid_token', 400);
  const header = b64urlJson(parts[0]);
  if (header.alg !== 'RS256' || !header.kid) throw new AppleAuthError('invalid_token');
  const key = await keyFor(header.kid);
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]),
    key,
    Buffer.from(parts[2], 'base64url')
  );
  if (!ok) throw new AppleAuthError('invalid_token');

  const claims = b64urlJson(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== APPLE_ISSUER) throw new AppleAuthError('invalid_token');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.apple.bundleId)) throw new AppleAuthError('invalid_token');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw new AppleAuthError('token_expired');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > now) throw new AppleAuthError('invalid_token');
  if (!claims.sub || typeof claims.sub !== 'string') throw new AppleAuthError('invalid_token');
  // The app passes sha256(rawNonce) to Apple (the plugin docs' pattern); a raw
  // nonce in the token is accepted too.
  if (!claims.nonce || !(safeEqual(claims.nonce, sha256Hex(rawNonce)) || safeEqual(claims.nonce, rawNonce))) {
    throw new AppleAuthError('invalid_nonce');
  }
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  return { sub: claims.sub, email, emailVerified };
}

// Same policy as googleVerify: known apple_id -> that user; a verified email is
// required to create an account; an existing account with the same email is
// never linked automatically (email_exists).
// -> { user, created } or throws AppleAuthError
async function findOrCreateUser({ sub, email, emailVerified }, { givenName, familyName, attribution, req } = {}) {
  const known = await User.findByAppleId(sub);
  if (known) return { user: known, created: false };
  if (!email || !emailVerified) throw new AppleAuthError('email_missing');
  if (await User.findByEmail(email)) throw new AppleAuthError('email_exists', 409);

  const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 60) : '');
  const fullName = [clean(givenName), clean(familyName)].filter(Boolean).join(' ');
  const created = await User.createFromApple({ appleId: sub, email, fullName });
  const att = typeof attribution === 'string' && attribution.length <= 4000 ? attribution : null;
  await require('./signupFlow').handleSignup(
    { id: created.id, username: created.username, email, fullName },
    'apple', att, req
  );
  const fresh = await User.findByAppleId(sub);
  return { user: fresh, created: true };
}

// ---- optional: refresh token for revocation (SIWA key on disk) -------------

function siwaConfigured() {
  const a = config.apple;
  return Boolean(a.keyPath && a.keyId && a.teamId);
}

let cachedKeyPem = null;
function siwaKey() {
  if (!cachedKeyPem) cachedKeyPem = fs.readFileSync(config.apple.keyPath, 'utf8');
  return cachedKeyPem;
}

// ES256 client_secret JWT that Apple's /auth/token and /auth/revoke expect.
function clientSecret() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: config.apple.keyId, typ: 'JWT' };
  const payload = { iss: config.apple.teamId, iat: now, exp: now + 300, aud: APPLE_ISSUER, sub: config.apple.bundleId };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = enc(header) + '.' + enc(payload);
  const sig = crypto.sign('sha256', Buffer.from(data), { key: siwaKey(), dsaEncoding: 'ieee-p1363' });
  return data + '.' + sig.toString('base64url');
}

// Best effort: never throws, never blocks sign-in on failure.
async function storeRefreshToken(userId, authorizationCode) {
  if (!siwaConfigured() || typeof authorizationCode !== 'string' || !authorizationCode || authorizationCode.length > 2000) {
    return false;
  }
  try {
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.apple.bundleId,
        client_secret: clientSecret(),
        code: authorizationCode,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) {
      console.warn('Apple token exchange failed with status', res.status);
      return false;
    }
    const body = await res.json();
    if (!body || !body.refresh_token) return false;
    await run('UPDATE users SET apple_refresh_token_enc = ? WHERE id = ?', [config.encryptToken(body.refresh_token), userId]);
    return true;
  } catch (e) {
    console.warn('Apple token exchange error:', e.name || 'error');
    return false;
  }
}

// Best effort revoke on account deletion. Takes the encrypted value because the
// user row is gone by the time this runs.
async function revokeRefreshToken(encrypted) {
  if (!encrypted || !siwaConfigured()) return false;
  try {
    const token = config.decryptToken(encrypted);
    const res = await fetchWithTimeout(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.apple.bundleId,
        client_secret: clientSecret(),
        token,
        token_type_hint: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) console.warn('Apple revoke failed with status', res.status);
    return res.ok;
  } catch (e) {
    console.warn('Apple revoke error:', e.name || 'error');
    return false;
  }
}

async function appleRefreshTokenOf(userId) {
  const row = await get('SELECT apple_refresh_token_enc FROM users WHERE id = ?', [userId]);
  return row ? row.apple_refresh_token_enc : null;
}

module.exports = {
  AppleAuthError,
  verifyIdentityToken,
  findOrCreateUser,
  storeRefreshToken,
  revokeRefreshToken,
  appleRefreshTokenOf,
  siwaConfigured,
  resetJwksCache,
  _clientSecret: clientSecret,
};
