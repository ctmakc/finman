// engine/src/aiHttp.js — HTTP layer for services/userAi/providers.js inside the engine.
// Plugged in with providers._setHttp(): the browser calls OpenAI / Anthropic / Gemini /
// OpenRouter / … directly with the user's own key (all of them allow CORS; Anthropic only
// with the anthropic-dangerous-direct-browser-access header). Same contract as the axios
// call it replaces: resolves { status, data } for every HTTP status, rejects on network
// failure (code ECONNABORTED on timeout).
'use strict';

const net = require('./net');

async function aiHttp(cfg) {
  const method = String(cfg.method || 'GET').toUpperCase();
  const headers = { ...(cfg.headers || {}) };
  let host = '';
  try { host = new URL(cfg.url).hostname; } catch (_) { /* invalid URL -> fetch rejects */ }
  if (host === 'api.anthropic.com' || headers['anthropic-version']) headers['anthropic-dangerous-direct-browser-access'] = 'true';
  // OpenRouter attribution headers are fine from the browser; nothing else to add.
  let body;
  if (cfg.data !== undefined && method !== 'GET') {
    body = typeof cfg.data === 'string' ? cfg.data : JSON.stringify(cfg.data);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = cfg.timeout || 90000;
  const timer = ac ? setTimeout(() => ac.abort(), timeout) : null;
  let r;
  try {
    r = await net.aiFetch(cfg.url, { method, headers, body, signal: ac ? ac.signal : undefined, redirect: 'error', credentials: 'omit' });
    const text = await r.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* keep text */ }
    return { status: r.status, data, headers: {} };
  } catch (e) {
    if (ac && ac.signal.aborted) { const err = new Error('timeout'); err.code = 'ECONNABORTED'; throw err; }
    const err = new Error((e && e.message) || 'Network error');
    err.code = (e && e.code) || 'ENETWORK';
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { aiHttp };
