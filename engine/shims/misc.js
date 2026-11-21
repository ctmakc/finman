// engine/shims/misc.js — small pass-through modules: express-rate-limit (the vault serves one
// person in one tab), dotenv, async_hooks.
'use strict';

function rateLimit() { return (req, res, next) => next(); }
rateLimit.rateLimit = rateLimit;
rateLimit.default = rateLimit;
rateLimit.ipKeyGenerator = (ip) => ip;

class AsyncLocalStorage {
  constructor() { this.store = undefined; }
  getStore() { return this.store; }
  run(store, fn, ...args) { const prev = this.store; this.store = store; try { return fn(...args); } finally { this.store = prev; } }
  enterWith(store) { this.store = store; }
}

module.exports = {
  rateLimit,
  dotenv: { config: () => ({ parsed: {} }), parse: () => ({}) },
  asyncHooks: { AsyncLocalStorage },
};
