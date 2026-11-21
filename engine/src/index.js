// engine/src/index.js — FinmanEngine: the server's routes/models/services over one user's
// vault (sql.js), for the browser (public/js/vault/engine.js, global FinmanEngine) and for
// Node (engine/dist/engine.node.cjs, consent-MCP). See docs/E2E-ENCRYPTION.md §4, §6.
//
//   const eng = await FinmanEngine.open({ SQL, bytes, user, serverFetch })
//   eng.isLocal(method, path) · await eng.handle({ method, url, headers, body, files })
//   eng.export() · eng.importLegacy({ tables, user }) · eng.counts() · eng.dirty · eng.close()
//   eng.mcpListTools() · await eng.mcpCallTool(name, args) · FinmanEngine.MCP_LOCAL_TOOLS
'use strict';

const { ctx } = require('./context');
const { Lock } = require('./lock');
const db = require('../shims/database');
const routes = require('../routes');
const schema = require('./schema');
const { buildApp, makeRequest, makeResponse } = require('./app');
const { aiHttp } = require('./aiHttp');
const { VAULT_TABLES, paramsFor } = require('../../lib/vaultTables');
const aiProvider = require('./aiProvider');
const config = require('../shims/config');

const VERSION = '1';
const LOCAL_PASSWORD = '!vault-local'; // never a valid bcrypt hash: nobody can sign in with it
const lock = new Lock(); // shared by every engine in this bundle copy
ctx.lock = lock;

let app = null;
function getApp() {
  if (!app) app = buildApp();
  return app;
}

let mcp = null;
function getMcp() {
  if (!mcp) mcp = { tools: require('../../services/mcp/tools'), tx: require('../../services/mcp/txTools') };
  return mcp;
}
const MCP_LOCAL_TOOLS = Object.freeze(require('../../services/mcp/txTools').TX_TOOLS.map((t) => t.name));

// ---------- helpers ----------
const sync = db._sync;

function activate(inst) {
  ctx.inst = inst;
  ctx.sql = inst ? inst.sqlDb : null;
  ctx.user = inst ? inst.user : null;
  ctx.serverFetch = inst ? inst.serverFetch : null;
}

// Run synchronous engine work with this instance active, then put back whoever was active.
function withSync(inst, fn) {
  const prev = ctx.inst;
  activate(inst);
  try { return fn(); } finally { activate(prev); }
}

function tableColumns(name) {
  try { return sync.all(`PRAGMA table_info("${name.replace(/"/g, '')}")`).map((r) => r.name); } catch (_) { return []; }
}
function tableExists(name) {
  return !!sync.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
}

// Legacy-export values: BLOBs arrive as { $b64 } (services/vault.js exportRow) or as a
// JSON-serialised Buffer; other objects are stored as JSON text.
function reviveValue(v) {
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    if (typeof v.$b64 === 'string') { const b = Buffer.from(v.$b64, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
    if (v.type === 'Buffer' && Array.isArray(v.data)) return Uint8Array.from(v.data);
    return JSON.stringify(v);
  }
  return v;
}

function upsertUser(user) {
  if (!user || user.id === undefined || user.id === null) throw new Error('FinmanEngine.open: user.id is required');
  const id = Number(user.id);
  const cols = new Set(tableColumns('users'));
  const skip = new Set(['id', 'password', 'kdf', 'kdf_salt', 'kdf_params', 'vault_state', 'token_version']);
  const fields = Object.keys(user).filter((k) => cols.has(k) && !skip.has(k) && user[k] !== undefined);
  const existing = sync.get('SELECT id FROM users WHERE id = ?', [id]);
  if (existing) {
    if (fields.length) sync.run(`UPDATE users SET ${fields.map((f) => `"${f}" = ?`).join(', ')} WHERE id = ?`, [...fields.map((f) => reviveValue(user[f])), id]);
  } else {
    const row = { ...Object.fromEntries(fields.map((f) => [f, reviveValue(user[f])])), id, password: LOCAL_PASSWORD };
    if (!row.email) row.email = `user${id}@vault.local`;
    if (!row.username) row.username = row.email;
    const keys = Object.keys(row).filter((k) => cols.has(k));
    sync.run(`INSERT INTO users (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
  }
  // Only this user lives in the vault.
  sync.run('DELETE FROM users WHERE id <> ?', [id]);
  return loadUser(id);
}

function loadUser(id) {
  const row = sync.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!row) return null;
  delete row.password;
  return row;
}

// Global rates (currency_rates is shared server data, not part of the vault): seeded from
// the server on open so conversions in reports / net worth / budgets work offline-first.
async function seedRates(inst) {
  if (typeof inst.serverFetch !== 'function') return 0;
  let base = 'USD';
  try {
    const s = sync.get('SELECT base_currency FROM user_currency_settings WHERE user_id = ?', [inst.user.id]);
    if (s && s.base_currency) base = s.base_currency;
  } catch (_) { /* default */ }
  let data;
  try {
    const r = await inst.serverFetch(`/api/currency/rates?base=${encodeURIComponent(base)}`, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!r || (r.status && r.status >= 400)) return 0;
    data = typeof r.json === 'function' ? await r.json() : r;
  } catch (_) {
    return 0;
  }
  const rates = data && (data.rates || (data.data && data.data.rates));
  const b = String((data && data.base) || base).toUpperCase();
  if (!rates || typeof rates !== 'object') return 0;
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  return withSync(inst, () => {
    for (const [to, rate] of Object.entries(rates)) {
      const v = Number(rate);
      if (!Number.isFinite(v) || v <= 0) continue;
      try {
        sync.run(`INSERT OR REPLACE INTO currency_rates (from_currency, to_currency, rate, source, date) VALUES (?, ?, ?, 'server', ?)`, [b, String(to).toUpperCase(), v, today]);
        n += 1;
      } catch (_) { /* table shape differs: skip */ }
    }
    return n;
  });
}

// ---------- request body / files ----------
const isFormData = (b) => b && typeof b === 'object' && typeof b.append === 'function' && typeof b.entries === 'function';
const isBlob = (v) => v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && typeof v.size === 'number';

async function toBuffer(v) {
  if (v === undefined || v === null) return Buffer.alloc(0);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (isBlob(v)) return Buffer.from(new Uint8Array(await v.arrayBuffer()));
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  if (ArrayBuffer.isView(v)) return Buffer.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  return Buffer.from(String(v), 'utf8');
}

async function normFile(f, fallbackField) {
  if (isBlob(f)) return { fieldname: fallbackField || 'file', originalname: f.name || 'blob', mimetype: f.type || 'application/octet-stream', buffer: await toBuffer(f) };
  const src = f.buffer !== undefined ? f.buffer : f.bytes !== undefined ? f.bytes : f.data !== undefined ? f.data : f.file !== undefined ? f.file : f.text;
  return {
    fieldname: f.fieldname || f.field || fallbackField || 'file',
    originalname: f.originalname || f.filename || f.name || (isBlob(src) && src.name) || 'upload',
    mimetype: f.mimetype || f.type || (isBlob(src) && src.type) || 'application/octet-stream',
    buffer: await toBuffer(src),
  };
}

function parseUrlEncoded(s) {
  const out = {};
  for (const [k, v] of new URLSearchParams(s)) out[k] = out[k] === undefined ? v : [].concat(out[k], v);
  return out;
}

class BadJson extends Error {
  constructor() { super('Invalid JSON body'); this.type = 'entity.parse.failed'; this.status = 400; }
}

async function prepareBody(input, headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  let body = input.body;
  const files = [];
  for (const f of input.files || []) files.push(await normFile(f));
  if (isFormData(body)) {
    const fields = {};
    for (const [k, v] of body.entries()) {
      if (isBlob(v)) files.push(await normFile(v, k));
      else fields[k] = fields[k] === undefined ? v : [].concat(fields[k], v);
    }
    return { body: fields, files };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return { body: parseUrlEncoded(body.toString()), files };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const buf = await toBuffer(body);
    if (ct.includes('json') || ct.startsWith('text/') || ct.includes('urlencoded')) body = buf.toString('utf8');
    else return { body: buf, files };
  }
  if (typeof body === 'string') {
    if (ct.includes('json') || (!ct && /^\s*[[{]/.test(body))) {
      if (!body.trim()) return { body: {}, files };
      try { return { body: JSON.parse(body), files }; } catch (_) { return { body: {}, files, error: new BadJson() }; }
    }
    if (ct.includes('application/x-www-form-urlencoded')) return { body: parseUrlEncoded(body), files };
    return { body, files };
  }
  if (body === undefined || body === null) return { body: {}, files };
  return { body, files };
}

function joinBody(chunks, contentType) {
  const textual = /^(text\/|application\/(json|javascript|xml|x-ndjson|csv)|.*\+json|.*\+xml)/i.test(contentType || '') || !contentType;
  if (chunks.every((c) => typeof c === 'string')) {
    const s = chunks.join('');
    return textual ? s : Uint8Array.from(Buffer.from(s, 'utf8'));
  }
  const buf = Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c)));
  if (textual && contentType) return buf.toString('utf8');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function jsonResult(status, obj) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, contentType: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// ---------- the engine ----------
class Engine {
  constructor({ sqlDb, user, serverFetch }) {
    this.sqlDb = sqlDb;
    this.user = user;
    this.serverFetch = typeof serverFetch === 'function' ? serverFetch : null;
    this.writes = 0;
    this.dirty = false;
    this.closed = false;
  }

  isLocal(method, path) { return routes.isLocal(method, path); }

  _check() { if (this.closed) throw new Error('FinmanEngine: engine is closed'); }

  async handle(input = {}) {
    this._check();
    const method = String(input.method || 'GET').toUpperCase();
    let url = String(input.url || '/');
    if (/^[a-z]+:\/\//i.test(url)) { const u = new URL(url); url = u.pathname + u.search; }
    const path = routes.pathOf(url);
    const headers = {};
    if (input.headers) {
      const h = input.headers;
      if (typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach((v, k) => { headers[String(k).toLowerCase()] = String(v); });
      else for (const [k, v] of Object.entries(h)) if (v != null) headers[k.toLowerCase()] = String(v);
    }

    if (routes.vaultUnavailable(method, path)) {
      return jsonResult(409, { error: true, success: false, code: 'VAULT_UNAVAILABLE', message: 'Live bank connections are not available while your data is encrypted. Import a CSV or OFX statement instead.' });
    }
    if (method === 'POST' && /^\/api\/sync\/run\/?$/.test(path)) {
      return jsonResult(200, { success: true, data: { summary: { connections: 0, accounts: 0, fetched: 0, inserted: 0, skipped: 0, errors: 0 }, available: false, code: 'VAULT_UNAVAILABLE' } });
    }
    if (!routes.isLocal(method, path)) {
      return jsonResult(421, { success: false, error: { code: 'NOT_LOCAL', message: `${method} ${path} is served by the server, not the vault engine` } });
    }

    const prepared = await prepareBody(input, headers);
    const inst = this;

    await lock.acquire();
    activate(inst);
    const before = inst.writes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (ctx.inst === inst) activate(null);
      lock.release();
    };

    let result;
    try {
      const req = makeRequest({ method, url, headers, body: prepared.body, files: prepared.files, user: { ...inst.user } });
      const outcome = await new Promise((resolve) => {
        let res;
        const timer = setTimeout(() => {
          if (!res.writableEnded) res.status(504).json({ success: false, error: { code: 'VAULT_TIMEOUT', message: 'The vault engine did not answer in time' } });
        }, REQUEST_TIMEOUT_MS);
        res = makeResponse((r) => { clearTimeout(timer); resolve({ r, res }); });
        const finalHandler = (err) => {
          if (res.writableEnded) return;
          if (err) res.status(err.status || 500).json({ success: false, error: { code: err.code || 'INTERNAL_ERROR', message: err.message || 'Error' } });
          else res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Route not found: ${method} ${url}` } });
        };
        if (prepared.error) {
          // Same answer express.json() gives for a broken body.
          res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } });
          return;
        }
        try { getApp().handle(req, res, finalHandler); } catch (e) { finalHandler(e); }
      });
      const { r, res } = outcome;
      const contentType = r.headers['content-type'] || '';
      let body = joinBody(r.chunks, contentType);
      if (/^\/api\/ai(\/|$)/.test(path) && r.status === 503 && typeof body === 'string' && body.includes('AI_NOT_CONFIGURED')) {
        body = JSON.stringify({ success: false, error: { code: 'AI_KEY_REQUIRED', message: aiProvider.KEY_REQUIRED_MESSAGE } });
      }
      const outHeaders = {};
      for (const [k, v] of Object.entries(r.headers)) outHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      result = { status: r.status, headers: outHeaders, contentType, body };
      // Keep the lock until the handlers that were awaited by the router settle
      // (code after res.json() in the same handler), then free it.
      const pending = res._pending.slice();
      if (pending.length) {
        Promise.allSettled(pending).then(() => {
          if (inst.writes > before) inst.dirty = true;
          release();
        });
      } else release();
    } catch (e) {
      release();
      throw e;
    }
    if ((method !== 'GET' && method !== 'HEAD' && result.status < 400) || inst.writes > before) inst.dirty = true;
    return result;
  }

  export() {
    this._check();
    return withSync(this, () => {
      if (ctx.inTx) throw new Error('FinmanEngine.export: a transaction is open, try again');
      const bytes = this.sqlDb.export();
      // sql.js re-opens the database on export(): connection pragmas are reset.
      this.sqlDb.exec('PRAGMA foreign_keys = ON');
      return bytes;
    });
  }

  importLegacy({ tables = {}, user } = {}) {
    this._check();
    return withSync(this, () => {
      if (ctx.inTx) throw new Error('FinmanEngine.importLegacy: a transaction is open, try again');
      if (user) this.user = upsertUser({ ...this.user, ...user, id: this.user.id });
      ctx.user = this.user;
      const counts = {};
      const skipped = {};
      const known = new Set(VAULT_TABLES.map((t) => t.name));
      const order = [...VAULT_TABLES.map((t) => t.name), ...Object.keys(tables).filter((n) => !known.has(n))];
      this.sqlDb.exec('PRAGMA foreign_keys = OFF');
      sync.run('BEGIN');
      try {
        for (const name of order) {
          const rows = tables[name];
          if (!Array.isArray(rows)) continue;
          if (name === 'users' || name === 'schema_migrations') { skipped[name] = rows.length; continue; }
          if (!tableExists(name)) {
            // A vault table this schema lacks (ai_chat_sessions lives only on old prod DBs):
            // keep the rows in an untyped table built from their keys, so nothing is lost
            // and counts() match the server's. Unknown non-vault tables are skipped.
            if (!known.has(name) || !rows.length) { if (!known.has(name)) skipped[name] = rows.length; counts[name] = 0; continue; }
            const keys = [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))].filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
            if (!keys.length) { counts[name] = 0; continue; }
            sync.run(`CREATE TABLE IF NOT EXISTS "${name}" (${keys.map((k) => (k === 'id' ? '"id" INTEGER PRIMARY KEY' : `"${k}"`)).join(', ')})`);
          }
          const cols = new Set(tableColumns(name));
          let n = 0;
          for (let row of rows) {
            if (!row || typeof row !== 'object') continue;
            if (name === 'user_ai_keys' && row.key_plain) {
              // The server sends the decrypted provider key next to its server-encrypted copy;
              // inside the vault the key is kept in the engine's own format.
              row = { ...row, key_enc: config.encryptToken(String(row.key_plain)) };
              delete row.key_plain;
            }
            const keys = Object.keys(row).filter((k) => cols.has(k));
            if (!keys.length) continue;
            sync.run(`INSERT OR REPLACE INTO "${name}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => reviveValue(row[k])));
            n += 1;
          }
          counts[name] = n;
        }
        sync.run('COMMIT');
      } catch (e) {
        try { sync.run('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      } finally {
        this.sqlDb.exec('PRAGMA foreign_keys = ON');
      }
      this.dirty = true;
      return { counts, skipped };
    });
  }

  counts() {
    this._check();
    return withSync(this, () => {
      const out = {};
      for (const t of VAULT_TABLES) {
        try {
          const r = sync.get(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${t.where}`, paramsFor(t, this.user.id));
          out[t.name] = r ? Number(r.n) : 0;
        } catch (_) {
          out[t.name] = 0;
        }
      }
      return out;
    });
  }

  // Synchronous read-only-by-convention SQL for scripts (row hashes before/after migration).
  // BLOB columns come back as plain Uint8Array. Not counted as a change (dirty untouched).
  query(sql, params = []) {
    this._check();
    const stmt = this.sqlDb.prepare(sql);
    try {
      const bound = Array.isArray(params) ? params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) : params;
      stmt.bind(bound);
      const rows = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        for (const k of Object.keys(row)) {
          const v = row[k];
          if (v instanceof Uint8Array && v.constructor !== Uint8Array) row[k] = new Uint8Array(v);
        }
        rows.push(row);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  // ---------- MCP tools (consent-MCP on the server, local MCP later) ----------
  mcpListTools() {
    this._check();
    return getMcp().tools.listTools();
  }

  async mcpCallTool(name, args) {
    this._check();
    if (!MCP_LOCAL_TOOLS.includes(name)) {
      const e = new Error(`Tool ${name} does not work on vault data (it runs on the server database)`);
      e.code = 'NOT_LOCAL_TOOL';
      throw e;
    }
    await lock.acquire();
    activate(this);
    const before = this.writes;
    try {
      return await getMcp().tools.callTool(this.user.id, name, args);
    } finally {
      if (this.writes > before) this.dirty = true;
      activate(null);
      lock.release();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (ctx.inst === this) activate(null);
    try { this.sqlDb.close(); } catch (_) { /* already closed */ }
    this.sqlDb = null;
  }
}

let providersPatched = false;
function patchProviders() {
  if (providersPatched) return;
  providersPatched = true;
  require('../../services/userAi/providers')._setHttp(aiHttp);
}

async function open({ SQL, bytes = null, user, serverFetch, debug } = {}) {
  if (!SQL || typeof SQL.Database !== 'function') throw new Error('FinmanEngine.open: pass SQL = await initSqlJs(...)');
  if (!user || user.id === undefined || user.id === null) throw new Error('FinmanEngine.open: user.id is required');
  if (debug) globalThis.FINMAN_ENGINE_DEBUG = true;
  patchProviders();
  const fresh = !bytes || !bytes.length;
  const sqlDb = fresh ? new SQL.Database() : new SQL.Database(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const inst = new Engine({ sqlDb, user: null, serverFetch });

  await lock.acquire();
  activate(inst);
  try {
    if (fresh) schema.freshSchema(sqlDb);
    else {
      const ok = sqlDb.exec("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'users'");
      if (!ok.length || !ok[0].values[0][0]) throw new Error('FinmanEngine.open: bytes are not a Finman vault');
      await schema.upgrade(sqlDb, db);
    }
    sqlDb.exec('PRAGMA foreign_keys = ON');
    inst.user = upsertUser(user);
    ctx.user = inst.user;
  } catch (e) {
    activate(null);
    lock.release();
    try { sqlDb.close(); } catch (_) { /* ignore */ }
    throw e;
  }
  activate(null);
  lock.release();
  await seedRates(inst);
  inst.writes = 0;
  inst.dirty = false;
  return inst;
}

module.exports = {
  open,
  isLocal: routes.isLocal,
  LOCAL_PREFIXES: routes.LOCAL_PREFIXES,
  REMOTE_PREFIXES: routes.REMOTE_PREFIXES,
  MCP_LOCAL_TOOLS,
  VAULT_TABLES: VAULT_TABLES.map((t) => t.name),
  VERSION,
};
