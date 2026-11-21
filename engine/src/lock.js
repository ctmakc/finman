// engine/src/lock.js — one request runs app code at a time.
// The server's db module keeps writes out of a foreign BEGIN..COMMIT with AsyncLocalStorage;
// browsers have no ALS, so the engine instead lets one request touch the DB at a time and
// releases the lock only while that request waits on the network (AI provider, rates) with
// no transaction open. Requests that wait on nothing finish in a few milliseconds anyway.
'use strict';

class Lock {
  constructor() { this.held = false; this.waiters = []; }
  acquire() {
    if (!this.held) { this.held = true; return Promise.resolve(); }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next(); else this.held = false;
  }
}

module.exports = { Lock };
