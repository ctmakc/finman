// services/mcp/oauth.js — OAuth 2.1 authorization server for the MCP connector.
//
// claude.ai (custom connector), Claude Code and other MCP hosts register themselves
// (RFC 7591), send the person to /oauth/authorize (PKCE S256 only), and trade the code
// for an access token (1 h) + a rotating refresh token (60 days). Every secret —
// client secret, code, access and refresh token — is stored only as a sha-256 hash.
// Tokens carry users.token_version: a password change signs every app out.
'use strict';

const crypto = require('crypto');
const { query, get, run } = require('../../db/database');

const ACCESS_TTL = 60 * 60; // seconds
const REFRESH_TTL = 60 * 24 * 60 * 60;
const CODE_TTL = 10 * 60;
const SCOPE = 'finman';
const ACCESS_PREFIX = 'finman_oat_';
const REFRESH_PREFIX = 'finman_ort_';
const MAX_CLIENTS_PER_HOUR = 200;

class OAuthError extends Error {
  constructor(error, description, status = 400) { super(description); this.error = error; this.status = status; }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const now = () => Math.floor(Date.now() / 1000);

function baseUrl() {
  return (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, '');
}
const resourceUrl = () => `${baseUrl()}/mcp`;

function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [baseUrl()],
    scopes_supported: [SCOPE, 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_name: 'Finman',
    resource_documentation: `${baseUrl()}/connect-ai`,
  };
}

function authorizationServerMetadata() {
  const b = baseUrl();
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    revocation_endpoint: `${b}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE, 'offline_access'],
    // RFC 9207: every authorization redirect carries ?iss= (ChatGPT checks it).
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${b}/connect-ai`,
  };
}

// https anywhere; plain http only back to this machine (Claude Code's local callback);
// custom app schemes (cursor://, vscode://…) for desktop MCP clients. Never fragments.
function validRedirectUri(u) {
  if (typeof u !== 'string' || u.length > 2000) return false;
  let url;
  try { url = new URL(u); } catch (_) { return false; }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (/^(javascript|data|file|vbscript|blob):$/i.test(url.protocol)) return false;
  return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol);
}

async function registerClient(body) {
  const b = body && typeof body === 'object' ? body : {};
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https URLs (or http://localhost)');
  }
  const method = b.token_endpoint_auth_method || 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
    throw new OAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
  }
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ['authorization_code', 'refresh_token'];
  if (!grants.includes('authorization_code')) throw new OAuthError('invalid_client_metadata', 'authorization_code grant is required');
  const recent = await get(`SELECT COUNT(*) AS n FROM oauth_clients WHERE created_at > datetime('now', '-1 hour')`);
  if (recent && recent.n >= MAX_CLIENTS_PER_HOUR) throw new OAuthError('temporarily_unavailable', 'Too many registrations, try later', 503);

  const clientId = 'fmc_' + rand(16);
  const secret = method === 'none' ? null : 'fmcs_' + rand(32);
  const name = String(b.client_name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100);
  await run(
    'INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method) VALUES (?, ?, ?, ?, ?)',
    [clientId, secret ? sha(secret) : null, name, JSON.stringify(uris), method],
  );
  const out = {
    client_id: clientId,
    client_id_issued_at: now(),
    client_name: name || undefined,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    scope: SCOPE,
  };
  if (secret) { out.client_secret = secret; out.client_secret_expires_at = 0; }
  return out;
}

async function getClient(clientId) {
  if (!clientId || typeof clientId !== 'string' || clientId.length > 100) return null;
  const row = await get('SELECT * FROM oauth_clients WHERE client_id = ?', [clientId]);
  if (!row) return null;
  let uris = [];
  try { uris = JSON.parse(row.redirect_uris); } catch (_) { uris = []; }
  return { ...row, redirect_uris: uris };
}

// Who is asking: a readable name for the consent screen.
function clientLabel(client) {
  const name = client.client_name || '';
  let host = '';
  let proto = '';
  try { const u = new URL(client.redirect_uris[0]); host = u.hostname; proto = u.protocol; } catch (_) { /* no label */ }
  if (/(^|\.)claude\.(ai|com)$/.test(host)) return name && /claude/i.test(name) ? name : 'Claude';
  if (/(^|\.)(chatgpt\.com|openai\.com)$/.test(host)) return name && /chatgpt|openai/i.test(name) ? name : 'ChatGPT';
  if (/(^|\.)cursor\.(com|sh)$/.test(host) || proto === 'cursor:') return name || 'Cursor';
  if (/(^|\.)vscode\.dev$/.test(host)) return name || 'VS Code';
  if (/(^|\.)(antigravity\.google|vertexaisearch\.cloud\.google\.com)$/.test(host)) return name || 'Gemini';
  return name || host || 'An MCP app';
}

// Checks every authorize parameter that does not need the person. Problems with the
// client or redirect_uri are shown on the page (never redirected); the rest go back to
// the app as ?error=… per RFC 6749 §4.1.2.1.
async function checkAuthorizeRequest(q) {
  const p = q || {};
  const client = await getClient(p.client_id);
  if (!client) return { fatal: 'This app is not registered with Finman. Remove the connector and add it again.' };
  const redirect = p.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '');
  if (!redirect || !client.redirect_uris.includes(redirect)) return { fatal: 'The return address of this app does not match its registration.' };
  const base = { client, redirect_uri: redirect, state: p.state === undefined ? undefined : String(p.state).slice(0, 2000) };
  if (p.response_type !== 'code') return { ...base, error: 'unsupported_response_type' };
  if (!p.code_challenge || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(p.code_challenge))) {
    return { ...base, error: 'invalid_request', error_description: 'PKCE with S256 is required' };
  }
  if (p.resource && String(p.resource).replace(/\/+$/, '') !== resourceUrl()) {
    return { ...base, error: 'invalid_target', error_description: 'Unknown resource' };
  }
  return { ...base, ok: true, code_challenge: String(p.code_challenge), scope: SCOPE, resource: p.resource ? resourceUrl() : null };
}

function withParams(uri, params) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  return url.toString();
}

async function issueCode(userId, checked) {
  const code = 'fmac_' + rand(32);
  await run(
    'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [sha(code), checked.client.client_id, userId, checked.redirect_uri, checked.code_challenge, checked.scope, checked.resource, now() + CODE_TTL],
  );
  await run('DELETE FROM oauth_codes WHERE expires_at < ?', [now()]);
  return code;
}

function clientCredentials(req) {
  const b = req.body || {};
  let id = b.client_id;
  let secret = b.client_secret;
  const h = req.headers.authorization;
  if (h && /^Basic\s+/i.test(h)) {
    try {
      const raw = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const i = raw.indexOf(':');
      if (i > 0) { id = decodeURIComponent(raw.slice(0, i)); secret = decodeURIComponent(raw.slice(i + 1)); }
    } catch (_) { /* fall through */ }
  }
  return { id, secret };
}

async function authenticateClient(req) {
  const { id, secret } = clientCredentials(req);
  const client = await getClient(id);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
  if (client.client_secret_hash) {
    const given = Buffer.from(sha(secret || ''));
    const want = Buffer.from(client.client_secret_hash);
    if (!secret || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
  }
  return client;
}

async function userTv(userId) {
  const u = await get('SELECT id, token_version FROM users WHERE id = ?', [userId]);
  return u ? Number(u.token_version || 0) : null;
}

async function issueTokens(client, userId, scope, resource, family) {
  const tv = await userTv(userId);
  if (tv === null) throw new OAuthError('invalid_grant', 'User not found');
  const access = ACCESS_PREFIX + rand(32);
  const refresh = REFRESH_PREFIX + rand(32);
  const fam = family || rand(12);
  const ins = 'INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, resource, tv, family, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
  await run(ins, [sha(access), 'access', client.client_id, userId, scope, resource, tv, fam, now() + ACCESS_TTL]);
  await run(ins, [sha(refresh), 'refresh', client.client_id, userId, scope, resource, tv, fam, now() + REFRESH_TTL]);
  await run('DELETE FROM oauth_tokens WHERE expires_at < ?', [now()]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope };
}

function pkceOk(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const calc = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(calc);
  const b = Buffer.from(String(challenge));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function exchange(req) {
  const b = req.body || {};
  const client = await authenticateClient(req);
  if (b.grant_type === 'authorization_code') {
    const row = await get('SELECT * FROM oauth_codes WHERE code_hash = ?', [sha(b.code || '')]);
    if (row) await run('DELETE FROM oauth_codes WHERE code_hash = ?', [row.code_hash]); // one use, even when it fails
    if (!row || row.expires_at < now() || row.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'Invalid or expired authorization code');
    if (b.redirect_uri !== undefined && b.redirect_uri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
    if (!pkceOk(b.code_verifier, row.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
    return issueTokens(client, row.user_id, row.scope, row.resource);
  }
  if (b.grant_type === 'refresh_token') {
    const token = String(b.refresh_token || '');
    const row = token.startsWith(REFRESH_PREFIX) ? await get(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`, [sha(token)]) : null;
    if (!row || row.expires_at < now() || row.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'Invalid or expired refresh token');
    if ((await userTv(row.user_id)) !== Number(row.tv)) {
      await run('DELETE FROM oauth_tokens WHERE family = ?', [row.family]);
      throw new OAuthError('invalid_grant', 'Sign in again');
    }
    // Rotation: the used refresh token and the old access token of this grant go away.
    await run('DELETE FROM oauth_tokens WHERE family = ?', [row.family]);
    return issueTokens(client, row.user_id, row.scope, row.resource, row.family);
  }
  throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

async function revoke(req) {
  const token = String((req.body || {}).token || '');
  if (!token) return;
  const row = await get('SELECT * FROM oauth_tokens WHERE token_hash = ?', [sha(token)]);
  if (!row) return;
  const { id } = clientCredentials(req);
  if (id && id !== row.client_id) return;
  await run('DELETE FROM oauth_tokens WHERE family = ?', [row.family]);
}

// Bearer access token -> { userId, clientId } or null.
async function verifyAccess(token) {
  if (typeof token !== 'string' || !token.startsWith(ACCESS_PREFIX)) return null;
  const row = await get(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`, [sha(token)]);
  if (!row || row.expires_at < now()) return null;
  if ((await userTv(row.user_id)) !== Number(row.tv)) return null;
  run('UPDATE oauth_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]).catch(() => {});
  return { userId: row.user_id, clientId: row.client_id };
}

// Apps connected to an account (one row per grant), for the settings page.
async function listGrants(userId) {
  const rows = await query(
    `SELECT t.family, t.client_id, c.client_name, c.redirect_uris, MIN(t.created_at) AS created_at, MAX(t.last_used_at) AS last_used_at
       FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.user_id = ? AND t.expires_at >= ? GROUP BY t.family ORDER BY created_at DESC`, [userId, now()]);
  return rows.map((r) => {
    let uris = [];
    try { uris = JSON.parse(r.redirect_uris || '[]'); } catch (_) { uris = []; }
    return { id: r.family, app: clientLabel({ client_name: r.client_name, redirect_uris: uris }), created_at: r.created_at, last_used_at: r.last_used_at };
  });
}

async function revokeGrant(userId, family) {
  const r = await run('DELETE FROM oauth_tokens WHERE user_id = ? AND family = ?', [userId, String(family)]);
  return r.changes > 0;
}

module.exports = {
  OAuthError, SCOPE, ACCESS_PREFIX, REFRESH_PREFIX,
  baseUrl, resourceUrl, protectedResourceMetadata, authorizationServerMetadata,
  validRedirectUri, registerClient, getClient, clientLabel, checkAuthorizeRequest, withParams,
  issueCode, exchange, revoke, verifyAccess, listGrants, revokeGrant, pkceOk,
};
