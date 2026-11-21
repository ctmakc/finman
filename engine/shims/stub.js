// engine/shims/stub.js — stand-in for server-only packages (bcrypt, stripe, web-push,
// node-cron, pdfkit, qrcode, tesseract.js, maxmind, sqlite3…). Loading works; any call or
// `new` throws Error('NOT_AVAILABLE_IN_VAULT') so callers fail loudly and clearly.
'use strict';

function makeStub(name) {
  const fail = () => {
    const e = new Error(`NOT_AVAILABLE_IN_VAULT: ${name} does not run inside the encrypted vault`);
    e.code = 'NOT_AVAILABLE_IN_VAULT';
    throw e;
  };
  const target = function stub() { return fail(); };
  return new Proxy(target, {
    apply: fail,
    construct: fail,
    get(t, prop) {
      if (prop === '__esModule') return false;
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === 'default') return makeStub(name);
      if (prop === 'name') return name;
      if (prop === 'toString') return () => `[stub ${name}]`;
      return makeStub(`${name}.${String(prop)}`);
    },
  });
}

module.exports = makeStub;
