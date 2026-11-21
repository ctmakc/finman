// engine/shims/node-net.js — node `net`, `dns`, `http`, `https`, `os` stand-ins.
// net.isIP* are real (services/userAi/providers.js validates custom base URLs with them);
// sockets, lookups and raw HTTP requests throw NOT_AVAILABLE_IN_VAULT.
'use strict';

function unavailable(what) {
  return () => { const e = new Error(`NOT_AVAILABLE_IN_VAULT: ${what}`); e.code = 'NOT_AVAILABLE_IN_VAULT'; throw e; };
}

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function isIPv4(s) { return V4.test(String(s)); }
function isIPv6(s) {
  s = String(s);
  if (!s.includes(':') || /[^0-9a-fA-F:.%]/.test(s.split('%')[0])) return false;
  const main = s.split('%')[0];
  if ((main.match(/::/g) || []).length > 1) return false;
  let parts = main.split(':');
  const last = parts[parts.length - 1];
  let groups = parts.length;
  if (last.includes('.')) { if (!isIPv4(last)) return false; groups += 1; parts = parts.slice(0, -1); }
  if (!main.includes('::') && groups !== 8) return false;
  if (groups > 8) return false;
  return parts.every((p) => p === '' || /^[0-9a-fA-F]{1,4}$/.test(p));
}
function isIP(s) { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }

class Agent { constructor(opts) { this.options = opts || {}; } destroy() {} }

const net = { isIP, isIPv4, isIPv6, connect: unavailable('net.connect'), createConnection: unavailable('net.createConnection'), createServer: unavailable('net.createServer'), Socket: unavailable('net.Socket') };
const dns = {
  lookup(host, opts, cb) { const e = new Error(`NOT_AVAILABLE_IN_VAULT: dns.lookup ${host}`); e.code = 'NOT_AVAILABLE_IN_VAULT'; (typeof opts === 'function' ? opts : cb)(e); },
  promises: { lookup: () => Promise.reject(Object.assign(new Error('NOT_AVAILABLE_IN_VAULT: dns'), { code: 'NOT_AVAILABLE_IN_VAULT' })) },
};
const http = {
  Agent,
  request: unavailable('http.request'),
  get(url, opts, cb) {
    // models/currency.js style: https.get(url, cb).on('error', handler)
    const handlers = {};
    const req = { on(ev, fn) { handlers[ev] = fn; return req; }, end() {}, destroy() {}, setTimeout() { return req; } };
    setTimeout(() => { if (handlers.error) handlers.error(Object.assign(new Error('NOT_AVAILABLE_IN_VAULT: http.get'), { code: 'NOT_AVAILABLE_IN_VAULT' })); }, 0);
    return req;
  },
  createServer: unavailable('http.createServer'),
  STATUS_CODES: {},
};
const os = {
  homedir: () => '/vault', tmpdir: () => '/tmp', hostname: () => 'vault', platform: () => 'browser', type: () => 'Browser',
  cpus: () => [], totalmem: () => 0, freemem: () => 0, EOL: '\n', arch: () => 'wasm', release: () => '', networkInterfaces: () => ({}),
};

module.exports = { net, dns, http, https: http, os };
