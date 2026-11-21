// engine/src/app.js — the engine's "server.js": mounts the same routers under the same
// paths, builds Express-like req/res objects for one call and collects the response.
'use strict';

const express = require('../shims/express');
const { MOUNTS } = require('../routes');
const { notFound, errorHandler } = require('../../middleware/error');

// ---------- query string (qs-style: a=1&a=2 -> array, a[]=1, a[b]=1) ----------
function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { return s; } };
    const k = dec(i < 0 ? part : part.slice(0, i));
    const v = i < 0 ? '' : dec(part.slice(i + 1));
    const m = /^([^[\]]+)\[([^[\]]*)\]$/.exec(k);
    if (m) {
      const [, base, sub] = m;
      if (sub === '') { out[base] = [].concat(out[base] === undefined ? [] : out[base], v); } else {
        if (typeof out[base] !== 'object' || Array.isArray(out[base])) out[base] = {};
        out[base][sub] = v;
      }
    } else if (out[k] === undefined) out[k] = v;
    else out[k] = [].concat(out[k], v);
  }
  return out;
}

function lowerKeys(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') { h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); }); return out; }
  for (const [k, v] of Object.entries(h)) if (v !== undefined && v !== null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

function emitter(obj) {
  const handlers = {};
  obj.on = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); return obj; };
  obj.once = (ev, fn) => { const w = (...a) => { obj.off(ev, w); fn(...a); }; return obj.on(ev, w); };
  obj.off = (ev, fn) => { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); return obj; };
  obj.removeListener = obj.off;
  obj.addListener = obj.on;
  obj.emit = (ev, ...a) => { for (const f of (handlers[ev] || []).slice()) { try { f(...a); } catch (_) { /* listener errors never break the response */ } } return true; };
  return obj;
}

const CONTENT_TYPES = { json: 'application/json', html: 'text/html', text: 'text/plain', csv: 'text/csv', pdf: 'application/pdf', xml: 'application/xml', txt: 'text/plain', bin: 'application/octet-stream' };

// ---------- one request ----------
function makeRequest({ method, url, headers, body, files, user }) {
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const req = emitter({
    method: String(method || 'GET').toUpperCase(),
    url,
    originalUrl: url,
    baseUrl: '',
    path,
    query: parseQuery(q < 0 ? '' : url.slice(q + 1)),
    headers: lowerKeys(headers),
    body,
    params: {},
    user,
    ip: '127.0.0.1',
    ips: [],
    protocol: 'https',
    secure: true,
    hostname: 'vault.local',
    cookies: {},
    signedCookies: {},
    session: {},
    socket: { remoteAddress: '127.0.0.1', destroy() {} },
    connection: { remoteAddress: '127.0.0.1' },
    _engineFiles: files || [],
    isVault: true,
  });
  req.get = (name) => {
    const n = String(name).toLowerCase();
    if (n === 'referer' || n === 'referrer') return req.headers.referer || req.headers.referrer;
    return req.headers[n];
  };
  req.header = req.get;
  req.is = (type) => {
    const ct = req.headers['content-type'] || '';
    return ct.includes(String(type).replace(/^\./, '')) ? type : false;
  };
  req.accepts = () => true;
  req.destroy = () => {};
  // path getter tracks url changes made by routers
  Object.defineProperty(req, 'path', { get() { return req.url.split('?')[0] || '/'; }, enumerable: true });
  return req;
}

function makeResponse(onDone) {
  const headers = {};
  const chunks = [];
  const pending = [];
  const res = emitter({
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    finished: false,
    locals: {},
    _pending: pending,
  });
  res._track = (p) => { pending.push(p); };
  res.status = (code) => { res.statusCode = Number(code); return res; };
  res.set = (field, val) => {
    if (field && typeof field === 'object') { for (const [k, v] of Object.entries(field)) res.set(k, v); return res; }
    headers[String(field).toLowerCase()] = Array.isArray(val) ? val.map(String) : String(val);
    return res;
  };
  res.header = res.set;
  res.setHeader = (k, v) => { res.set(k, v); return res; };
  res.getHeader = (k) => headers[String(k).toLowerCase()];
  res.get = res.getHeader;
  res.getHeaders = () => ({ ...headers });
  res.removeHeader = (k) => { delete headers[String(k).toLowerCase()]; };
  res.hasHeader = (k) => String(k).toLowerCase() in headers;
  res.append = (k, v) => { const key = String(k).toLowerCase(); headers[key] = headers[key] ? [].concat(headers[key], v) : v; return res; };
  res.vary = () => res;
  res.cookie = () => res;
  res.clearCookie = () => res;
  res.type = (t) => {
    const s = String(t);
    res.set('content-type', s.includes('/') ? s : CONTENT_TYPES[s.replace(/^\./, '')] || 'application/octet-stream');
    return res;
  };
  res.contentType = res.type;
  res.attachment = (filename) => {
    if (filename) {
      res.set('content-disposition', `attachment; filename="${String(filename).replace(/"/g, '')}"`);
      const ext = String(filename).split('.').pop();
      if (!res.getHeader('content-type') && CONTENT_TYPES[ext]) res.type(ext);
    } else res.set('content-disposition', 'attachment');
    return res;
  };
  res.writeHead = (code, msgOrHeaders, maybeHeaders) => {
    res.statusCode = code;
    const h = typeof msgOrHeaders === 'object' ? msgOrHeaders : maybeHeaders;
    if (h) res.set(h);
    res.headersSent = true;
    return res;
  };
  res.flushHeaders = () => { res.headersSent = true; };
  res.write = (chunk) => {
    if (res.writableEnded) return false;
    res.headersSent = true;
    if (chunk !== undefined && chunk !== null) chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
    return true;
  };
  res.end = (chunk, encOrCb, cb) => {
    if (res.writableEnded) return res;
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (typeof encOrCb === 'function') cb = encOrCb;
    if (chunk !== undefined && chunk !== null) chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
    res.headersSent = true;
    res.writableEnded = true;
    res.finished = true;
    res.writableFinished = true;
    onDone({ status: res.statusCode, headers, chunks });
    res.emit('finish');
    res.emit('close');
    if (typeof cb === 'function') cb();
    return res;
  };
  res.send = (body) => {
    if (body === undefined || body === null) return res.end();
    if (typeof body === 'number') body = String(body);
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      if (!res.getHeader('content-type')) res.type('bin');
      return res.end(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
    }
    if (typeof body === 'object') return res.json(body);
    if (!res.getHeader('content-type')) res.set('content-type', 'text/html; charset=utf-8');
    return res.end(String(body));
  };
  res.json = (obj) => {
    if (!res.getHeader('content-type')) res.set('content-type', 'application/json; charset=utf-8');
    const text = JSON.stringify(obj);
    return res.end(text === undefined ? '' : text);
  };
  res.jsonp = res.json;
  res.sendStatus = (code) => { res.statusCode = code; res.type('text'); return res.end(String(code)); };
  res.redirect = (a, b) => {
    const [code, loc] = typeof a === 'number' ? [a, b] : [302, a];
    res.statusCode = code;
    res.set('location', loc);
    return res.end();
  };
  res.location = (loc) => res.set('location', loc);
  res.download = (data, filename, cb) => {
    // Only in-memory payloads exist in the vault: res.download(buffer|string, name).
    if (typeof data === 'string' && !filename) {
      res.statusCode = 501;
      return res.json({ error: true, code: 'NOT_AVAILABLE_IN_VAULT', message: 'File downloads from disk are not available in the vault' });
    }
    res.attachment(filename);
    res.send(typeof data === 'string' ? data : Buffer.from(data));
    if (typeof cb === 'function') cb(null);
    return res;
  };
  res.sendFile = () => {
    res.statusCode = 501;
    return res.json({ error: true, code: 'NOT_AVAILABLE_IN_VAULT', message: 'Files on disk are not available in the vault' });
  };
  res.format = (map) => { const fn = map['application/json'] || map.json || map.default || Object.values(map)[0]; return fn && fn(); };
  return res;
}

function buildApp() {
  const root = express.Router();
  for (const [mount, load] of MOUNTS) root.use(mount, load());
  root.use(notFound);
  // Server-only features (PDF, OCR, mail…) fail with NOT_AVAILABLE_IN_VAULT: say so plainly
  // instead of the generic 500 errorHandler gives unknown errors in production.
  // eslint-disable-next-line no-unused-vars
  root.use((err, req, res, next) => {
    const hit = err && (err.code === 'NOT_AVAILABLE_IN_VAULT' || /^NOT_AVAILABLE_IN_VAULT/.test(String(err.message || '')));
    if (!hit || res.writableEnded) return next(err);
    return res.status(501).json({ success: false, error: { code: 'NOT_AVAILABLE_IN_VAULT', message: 'This feature is not available while your data is encrypted yet' } });
  });
  root.use(errorHandler);
  // Legacy fallback, like server.js.
  // eslint-disable-next-line no-unused-vars
  root.use((err, req, res, next) => {
    if (res.writableEnded) return;
    res.status(500).json({ error: true, message: (err && err.message) || 'Internal Server Error' });
  });
  return root;
}

module.exports = { buildApp, makeRequest, makeResponse, parseQuery };
