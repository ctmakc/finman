// engine/src/context.js — the one piece of mutable state the engine shares with its shims.
// One engine instance is open at a time per bundle copy (one user's vault in one tab, or
// one consent-MCP call in Node). The shims (db adapter, network, AI provider) read from here.
'use strict';

const ctx = {
  sql: null,          // sql.js Database
  user: null,         // local users row (req.user)
  serverFetch: null,  // optional fn(url, init) -> Response-like
  inst: null,         // the engine whose vault is active (its .writes counts changes)
  inTx: false,        // a transaction() is open
  lock: null,         // request mutex (see engine/src/lock.js)
};

class EngineUnavailable extends Error {
  constructor(what) {
    super(`NOT_AVAILABLE_IN_VAULT: ${what} is not available inside the encrypted vault`);
    this.name = 'EngineUnavailable';
    this.code = 'NOT_AVAILABLE_IN_VAULT';
    this.status = 501;
  }
}

function requireOpen() {
  if (!ctx.sql) throw new Error('FinmanEngine: vault is not open');
  return ctx.sql;
}

module.exports = { ctx, EngineUnavailable, requireOpen };
