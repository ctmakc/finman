#!/usr/bin/env node
// engine/check-browser.cjs — loads the browser bundle (public/js/vault/engine.js) and the
// sql.js browser build (public/vendor/sqljs/) in a bare vm context that has only browser
// APIs (no process, Buffer, global, require, module, __dirname), then opens a fresh vault,
// writes an account + an expense, reads them back and exports. Exit 0 = OK.
//
//   node engine/check-browser.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_JS = path.join(ROOT, 'public', 'js', 'vault', 'engine.js');
const SQL_JS = path.join(ROOT, 'public', 'vendor', 'sqljs', 'sql-wasm.js');
const SQL_WASM = path.join(ROOT, 'public', 'vendor', 'sqljs', 'sql-wasm.wasm');

const NODE_ONLY = ['process', 'Buffer', 'global', 'require', 'module', 'exports', '__dirname', '__filename', 'setImmediate'];

async function main() {
  const browserApis = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, AbortSignal,
    crypto: globalThis.crypto, performance: { now: () => performance.now() },
    fetch: async () => { throw new Error('network is off in check-browser'); },
    Blob, FormData, File: globalThis.File, Headers, Request, Response,
    atob, btoa, structuredClone,
  };
  const sandbox = { ...browserApis };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of NODE_ONLY) {
    const t = vm.runInContext(`typeof ${name}`, context);
    if (t !== 'undefined') throw new Error(`sandbox leaks Node global ${name}`);
  }
  if (vm.runInContext('typeof WebAssembly', context) === 'undefined') context.WebAssembly = WebAssembly;

  vm.runInContext(fs.readFileSync(SQL_JS, 'utf8'), context, { filename: 'sql-wasm.js' });
  vm.runInContext(fs.readFileSync(ENGINE_JS, 'utf8'), context, { filename: 'engine.js' });
  if (typeof context.FinmanEngine !== 'object' || typeof context.FinmanEngine.open !== 'function') throw new Error('FinmanEngine global missing');
  if (typeof context.initSqlJs !== 'function') throw new Error('initSqlJs global missing');

  context.__wasm = new Uint8Array(fs.readFileSync(SQL_WASM));
  const out = await vm.runInContext(`(async () => {
    const SQL = await initSqlJs({ wasmBinary: __wasm });
    const eng = await FinmanEngine.open({ SQL, bytes: null, user: { id: 5, email: 'browser@example.test', username: 'b', timezone: 'Europe/Kyiv' } });
    const j = async (method, url, body) => {
      const r = await eng.handle({ method, url, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, json: typeof r.body === 'string' ? JSON.parse(r.body) : null };
    };
    const a = await j('POST', '/api/accounts', { name: 'Wallet', currency: 'UAH', balance: 500 });
    const t = await j('POST', '/api/transactions', { accountId: a.json.id, amount: 120, type: 'expense', category: 'Food', description: 'Borsch', date: '2026-11-21' });
    const fd = new FormData();
    fd.append('accountId', String(a.json.id));
    fd.append('file', new Blob(['Date,Description,Amount\\n2026-11-20,TAXI,-80\\n'], { type: 'text/csv' }), 'st.csv');
    const pr = await eng.handle({ method: 'POST', url: '/api/bank-api/import/preview', body: fd });
    const list = await j('GET', '/api/accounts');
    const rep = await j('GET', '/api/analytics/overview');
    const bytes = eng.export();
    const again = await FinmanEngine.open({ SQL, bytes, user: { id: 5, email: 'browser@example.test' } });
    const counts = again.counts();
    return { a: a.status, t: t.status, preview: pr.status, previewRows: JSON.parse(pr.body).rows.length, balance: list.json.all[0].balance, rep: rep.status, size: bytes.length, tx: counts.transactions, local: eng.isLocal('GET', '/api/auth/me') };
  })()`, context);

  const ok = out.a === 201 && out.t === 201 && out.preview === 200 && out.previewRows === 1 && out.balance === 380 && out.rep === 200 && out.tx === 2 && out.local === false;
  console.log(`check-browser: ${ok ? 'OK' : 'FAILED'} ${JSON.stringify(out)}`);
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error('check-browser: FAILED', e && e.stack ? e.stack : e); process.exit(1); });
