// engine/shims/axios.js — fetch-based axios subset for the bundled server code.
// All traffic goes through engine/src/net.js externalFetch (public market data via the
// caller's serverFetch; everything else refused). The AI providers do not use this path:
// the engine plugs its own fetch into services/userAi/providers.js (_setHttp).
// Supported: axios(config), axios.request/get/delete/head/post/put/patch, params, headers,
// data (object -> JSON), timeout, responseType 'text'|'json'|'arraybuffer', transformResponse,
// validateStatus, axios.create(), axios.isAxiosError. Errors look like axios errors.
'use strict';

const net = require('../src/net');

function buildUrl(url, baseURL, params) {
  let u = String(url || '');
  if (baseURL && !/^[a-z]+:\/\//i.test(u)) u = String(baseURL).replace(/\/+$/, '') + '/' + u.replace(/^\/+/, '');
  if (params && typeof params === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.append(k, String(v));
    const s = qs.toString();
    if (s) u += (u.includes('?') ? '&' : '?') + s;
  }
  return u;
}

function axiosError(message, code, config, response) {
  const e = new Error(message);
  e.isAxiosError = true;
  e.code = code;
  e.config = config;
  e.response = response;
  e.toJSON = () => ({ message, code });
  return e;
}

function lowerHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') { h.forEach((v, k) => { out[k.toLowerCase()] = v; }); return out; }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

async function request(config, defaults = {}) {
  const cfg = { ...defaults, ...config, headers: { ...(defaults.headers || {}), ...(config.headers || {}) } };
  const method = String(cfg.method || 'get').toUpperCase();
  const url = buildUrl(cfg.url, cfg.baseURL, cfg.params);
  const headers = { ...cfg.headers };
  let body;
  if (cfg.data !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (typeof cfg.data === 'string' || cfg.data instanceof Uint8Array || (typeof URLSearchParams !== 'undefined' && cfg.data instanceof URLSearchParams)) body = cfg.data;
    else {
      body = JSON.stringify(cfg.data);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
  }
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (ac && cfg.timeout) timer = setTimeout(() => ac.abort(), cfg.timeout);
  if (ac && cfg.signal) {
    if (cfg.signal.aborted) ac.abort();
    else if (typeof cfg.signal.addEventListener === 'function') cfg.signal.addEventListener('abort', () => ac.abort());
  }
  let r;
  try {
    r = await net.externalFetch(url, { method, headers, body, signal: ac ? ac.signal : undefined });
  } catch (e) {
    if (ac && ac.signal.aborted) throw axiosError(`timeout of ${cfg.timeout}ms exceeded`, 'ECONNABORTED', cfg);
    throw axiosError(e.message || 'Network Error', e.code || 'ERR_NETWORK', cfg);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const type = cfg.responseType || 'json';
  let data;
  if (type === 'arraybuffer') data = Buffer.from(new Uint8Array(await r.arrayBuffer()));
  else {
    const text = await r.text();
    data = text;
    if (type === 'json' && !cfg.transformResponse) { try { data = text ? JSON.parse(text) : text; } catch (_) { data = text; } }
  }
  if (cfg.transformResponse) {
    const fns = Array.isArray(cfg.transformResponse) ? cfg.transformResponse : [cfg.transformResponse];
    for (const fn of fns) data = fn(data);
  }
  const response = { status: r.status, statusText: r.statusText || '', headers: lowerHeaders(r.headers), data, config: cfg };
  const ok = typeof cfg.validateStatus === 'function' ? cfg.validateStatus(r.status) : r.status >= 200 && r.status < 300;
  if (!ok) throw axiosError(`Request failed with status code ${r.status}`, r.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', cfg, response);
  return response;
}

function create(defaults = {}) {
  const inst = (cfgOrUrl, cfg) => (typeof cfgOrUrl === 'string' ? request({ ...(cfg || {}), url: cfgOrUrl }, defaults) : request(cfgOrUrl || {}, defaults));
  inst.request = (cfg) => request(cfg, defaults);
  for (const m of ['get', 'delete', 'head', 'options']) inst[m] = (url, cfg) => request({ ...(cfg || {}), url, method: m }, defaults);
  for (const m of ['post', 'put', 'patch']) inst[m] = (url, data, cfg) => request({ ...(cfg || {}), url, data, method: m }, defaults);
  inst.create = (d) => create({ ...defaults, ...d });
  inst.defaults = defaults;
  inst.interceptors = { request: { use() {}, eject() {} }, response: { use() {}, eject() {} } };
  inst.isAxiosError = (e) => !!(e && e.isAxiosError);
  inst.isCancel = () => false;
  return inst;
}

const axios = create({});
module.exports = axios;
module.exports.default = axios;
