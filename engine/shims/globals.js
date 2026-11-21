// engine/shims/globals.js — injected into every bundled module (esbuild `inject`):
// `process`, `Buffer`, `setImmediate` resolve to these instead of Node globals, in the
// browser and in the Node build alike, so the engine never reads the server's env.
import { Buffer } from 'buffer';

// middleware/error.js calls Error.captureStackTrace (V8 only); Safari has none.
if (typeof Error.captureStackTrace !== 'function') Error.captureStackTrace = function captureStackTrace() {};

const env = { NODE_ENV: 'production', FINMAN_VAULT: '1' };
const proc = {
  env,
  platform: 'browser',
  browser: true,
  version: 'v20.0.0',
  versions: {},
  argv: [],
  pid: 1,
  cwd: () => '/vault',
  nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
  hrtime: Object.assign((prev) => {
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6;
    const s = Math.floor(t / 1e9); const n = Math.floor(t % 1e9);
    return prev ? [s - prev[0], n - prev[1]] : [s, n];
  }, { bigint: () => BigInt(Math.floor((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6)) }),
  memoryUsage: () => ({ rss: 0, heapUsed: 0, heapTotal: 0 }),
  uptime: () => 0,
  on() { return proc; },
  once() { return proc; },
  off() { return proc; },
  emit() { return false; },
  exit() { throw new Error('process.exit is not available inside the vault'); },
  emitWarning() {},
  stdout: { write() { return true; } },
  stderr: { write() { return true; } },
};

const setImmediateShim = (fn, ...args) => setTimeout(fn, 0, ...args);
const clearImmediateShim = (t) => clearTimeout(t);

export { proc as process, Buffer, setImmediateShim as setImmediate, clearImmediateShim as clearImmediate };
