// engine/shims/database.js — replaces db/database.js inside the engine.
// Same API as the server module (query / get / run / transaction / initDatabase /
// closeDatabase / db) over the sql.js database of the open vault. sql.js is synchronous;
// the promise wrappers keep the callers' await semantics. Values are normalised the way
// node-sqlite3 binds them (undefined -> NULL, true -> 1, Date -> ms, Buffer -> BLOB),
// BLOB columns come back as Buffer, errors carry node-sqlite3 style codes.
'use strict';

const { ctx, requireOpen } = require('../src/context');

function bindValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime();
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return String(v);
}

function bindParams(params) {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  if (typeof params === 'object' && !(params instanceof Uint8Array) && !(params instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(params)) out[/^[:$@]/.test(k) ? k : '$' + k] = bindValue(v);
    return out;
  }
  return [bindValue(params)];
}

function sqliteError(e, sql) {
  const msg = String((e && e.message) || e);
  let code = 'SQLITE_ERROR';
  if (/constraint failed/i.test(msg)) code = 'SQLITE_CONSTRAINT';
  else if (/database is locked/i.test(msg)) code = 'SQLITE_BUSY';
  else if (/datatype mismatch/i.test(msg)) code = 'SQLITE_MISMATCH';
  const err = new Error(msg.startsWith('SQLITE_') ? msg : `${code}: ${msg}`);
  err.code = code;
  err.errno = code === 'SQLITE_CONSTRAINT' ? 19 : 1;
  err.sql = sql;
  return err;
}

function fixRow(row) {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }
  return row;
}

function bump(n) { if (ctx.inst) ctx.inst.writes += n; }

const WRITE_SQL = /^\s*(insert|update|delete|replace|create|drop|alter)\b/i;

// ---- synchronous core (also used by engine internals) ----
function allSync(sql, params) {
  const db = requireOpen();
  let stmt;
  try {
    stmt = db.prepare(sql);
    stmt.bind(bindParams(params));
    const rows = [];
    while (stmt.step()) rows.push(fixRow(stmt.getAsObject()));
    if (WRITE_SQL.test(sql)) bump(Math.max(db.getRowsModified(), 1));
    return rows;
  } catch (e) {
    throw sqliteError(e, sql);
  } finally {
    if (stmt) stmt.free();
  }
}

function getSync(sql, params) {
  const db = requireOpen();
  let stmt;
  try {
    stmt = db.prepare(sql);
    stmt.bind(bindParams(params));
    const row = stmt.step() ? fixRow(stmt.getAsObject()) : undefined;
    if (WRITE_SQL.test(sql)) bump(Math.max(db.getRowsModified(), 1));
    return row;
  } catch (e) {
    throw sqliteError(e, sql);
  } finally {
    if (stmt) stmt.free();
  }
}

function runSync(sql, params) {
  const db = requireOpen();
  let stmt;
  try {
    stmt = db.prepare(sql);
    stmt.bind(bindParams(params));
    while (stmt.step()) { /* drain (RETURNING / PRAGMA rows) */ }
    const changes = db.getRowsModified();
    let id = 0;
    const r = db.exec('SELECT last_insert_rowid()');
    if (r.length) id = Number(r[0].values[0][0]) || 0;
    if (WRITE_SQL.test(sql)) bump(Math.max(changes, 1));
    return { id, lastID: id, changes };
  } catch (e) {
    throw sqliteError(e, sql);
  } finally {
    if (stmt) stmt.free();
  }
}

const later = (fn) => new Promise((resolve, reject) => {
  try { resolve(fn()); } catch (e) { reject(e); }
});

function query(sql, params = []) { return later(() => allSync(sql, params)); }
function get(sql, params = []) { return later(() => getSync(sql, params)); }
function run(sql, params = []) { return later(() => runSync(sql, params)); }

// transaction(work): one open at a time (queued), BEGIN / COMMIT / ROLLBACK like the server.
let txQueue = Promise.resolve();
function transaction(work) {
  const result = txQueue.then(async () => {
    runSync('BEGIN');
    ctx.inTx = true;
    try {
      const r = await work();
      ctx.inTx = false;
      runSync('COMMIT');
      return r;
    } catch (err) {
      ctx.inTx = false;
      try { runSync('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw err;
    }
  });
  txQueue = result.then(() => undefined, () => undefined);
  return result;
}

function initDatabase() { return Promise.resolve(); }
function closeDatabase() { return Promise.resolve(); }

// Minimal node-sqlite3 Database facade for code that reaches for `db` directly.
const db = {
  all(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    later(() => allSync(sql, params)).then((r) => cb && cb(null, r), (e) => cb && cb(e));
    return db;
  },
  get(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    later(() => getSync(sql, params)).then((r) => cb && cb(null, r), (e) => cb && cb(e));
    return db;
  },
  run(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    later(() => runSync(sql, params)).then((r) => cb && cb.call({ lastID: r.id, changes: r.changes }, null), (e) => cb && cb(e));
    return db;
  },
  exec(sql, cb) {
    later(() => { requireOpen().exec(sql); bump(1); }).then(() => cb && cb(null), (e) => cb && cb(sqliteError(e, sql)));
    return db;
  },
  serialize(fn) { if (fn) fn(); return db; },
  parallelize(fn) { if (fn) fn(); return db; },
  close(cb) { if (cb) cb(null); },
  on() { return db; },
  configure() {},
};

module.exports = {
  initDatabase, closeDatabase, query, get, run, transaction, db,
  // engine internals
  _sync: { all: allSync, get: getSync, run: runSync },
};
