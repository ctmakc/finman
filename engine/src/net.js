// engine/src/net.js — every network call the bundled server code makes goes through here.
//   - AI providers (services/userAi/providers.js): browser fetch with the user's own key;
//   - public market data (stooq quotes, NBU / exchangerate.host rates): the caller's serverFetch
//     when given (it may proxy through our server), otherwise refused;
//   - anything else (mail, bank APIs, OpenPanel, Stripe…): refused, NOT_AVAILABLE_IN_VAULT.
// While a request waits on the network the request lock is released (unless a transaction
// is open), so other screens keep working during a long AI answer.
'use strict';

const { ctx, EngineUnavailable } = require('./context');

const PUBLIC_DATA = /^(?:[a-z0-9-]+\.)*(stooq\.com|stooq\.pl|bank\.gov\.ua|exchangerate\.host)$/i;

async function unlocked(fn) {
  const release = !!(ctx.lock && ctx.lock.held && !ctx.inTx);
  // Another engine (Node: another user's consent-MCP call) may run while we wait:
  // remember whose vault is active and put it back after re-acquiring the lock.
  const saved = { inst: ctx.inst, sql: ctx.sql, user: ctx.user, serverFetch: ctx.serverFetch };
  if (release) ctx.lock.release();
  try { return await fn(); } finally {
    if (release) { await ctx.lock.acquire(); Object.assign(ctx, saved); }
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

// fetch for the AI providers (direct, CORS-enabled APIs).
function aiFetch(url, init) {
  if (typeof fetch !== 'function') return Promise.reject(new EngineUnavailable('fetch'));
  return unlocked(() => fetch(url, init));
}

// fetch for everything else the server code would reach.
function externalFetch(url, init) {
  const host = hostOf(url);
  if (PUBLIC_DATA.test(host) && typeof ctx.serverFetch === 'function') {
    return unlocked(() => ctx.serverFetch(url, init));
  }
  const err = new EngineUnavailable(`network access to ${host || url}`);
  err.code = 'ENOTAVAIL';
  return Promise.reject(err);
}

function serverFetch(url, init) {
  if (typeof ctx.serverFetch !== 'function') return Promise.reject(new EngineUnavailable('serverFetch'));
  return unlocked(() => ctx.serverFetch(url, init));
}

module.exports = { aiFetch, externalFetch, serverFetch, unlocked };
