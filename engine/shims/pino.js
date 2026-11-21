// engine/shims/pino.js — logger that never ships anything anywhere. Warnings and errors go
// to console.debug with the message only (objects may hold the user's data; the console of
// the user's own tab is fine, but keep it quiet). FinmanEngine.open({ debug: true }) or
// globalThis.FINMAN_ENGINE_DEBUG = true prints everything.
'use strict';

function make(bindings) {
  const log = (level) => (obj, msg) => {
    const dbg = globalThis.FINMAN_ENGINE_DEBUG;
    if (!dbg && level !== 'error' && level !== 'fatal') return;
    const text = typeof obj === 'string' ? obj : msg || (obj && obj.err && obj.err.message) || '';
    // eslint-disable-next-line no-console
    if (typeof console !== 'undefined') console.debug(`[vault ${level}]`, text, dbg ? obj : '');
  };
  const logger = {
    level: 'info',
    trace: log('trace'), debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), fatal: log('fatal'), silent() {},
    child: (b) => make({ ...bindings, ...b }),
    isLevelEnabled: () => false,
    flush() {},
  };
  return logger;
}

function pino() { return make({}); }
pino.destination = () => ({ write() {} });
pino.stdTimeFunctions = { isoTime: () => '' };
pino.stdSerializers = { err: (e) => e, req: (r) => r, res: (r) => r };
module.exports = pino;
module.exports.default = pino;
module.exports.pino = pino;
