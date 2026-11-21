// engine/shims/fs.js — a tiny in-memory file system. Only temporary upload files live here
// (multer diskStorage -> csvImportService reads req.file.path -> route unlinks it).
// Nothing is persisted; nothing outside the vault is reachable.
'use strict';

const files = new Map();
const dirs = new Set(['/']);

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
function enoent(p, op) {
  const e = new Error(`ENOENT: no such file or directory, ${op} '${p}'`);
  e.code = 'ENOENT'; e.errno = -2; e.path = p; e.syscall = op;
  return e;
}
function toBuf(data, enc) {
  if (typeof data === 'string') return Buffer.from(data, typeof enc === 'string' ? enc : (enc && enc.encoding) || 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data);
  return Buffer.from(String(data));
}
function out(buf, opt) {
  const enc = typeof opt === 'string' ? opt : opt && opt.encoding;
  return enc ? buf.toString(enc) : Buffer.from(buf);
}

function existsSync(p) { p = norm(p); return files.has(p) || dirs.has(p); }
function mkdirSync(p) { dirs.add(norm(p)); return undefined; }
function writeFileSync(p, data, enc) { files.set(norm(p), toBuf(data, enc)); }
function appendFileSync(p, data, enc) { p = norm(p); files.set(p, Buffer.concat([files.get(p) || Buffer.alloc(0), toBuf(data, enc)])); }
function readFileSync(p, opt) { const k = norm(p); if (!files.has(k)) throw enoent(p, 'open'); return out(files.get(k), opt); }
function unlinkSync(p) { const k = norm(p); if (!files.delete(k)) throw enoent(p, 'unlink'); }
function readdirSync(p) {
  const base = norm(p).replace(/\/$/, '') + '/';
  const names = new Set();
  for (const k of [...files.keys(), ...dirs]) if (k.startsWith(base) && k !== base) names.add(k.slice(base.length).split('/')[0]);
  return [...names].sort();
}
function statSync(p) {
  const k = norm(p);
  if (files.has(k)) return { size: files.get(k).length, isFile: () => true, isDirectory: () => false, mtime: new Date(), mtimeMs: Date.now() };
  if (dirs.has(k)) return { size: 0, isFile: () => false, isDirectory: () => true, mtime: new Date(), mtimeMs: Date.now() };
  throw enoent(p, 'stat');
}

const cbify = (fn) => (...args) => {
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  let r; let err = null;
  try { r = fn(...args); } catch (e) { err = e; }
  if (cb) setTimeout(() => cb(err, r), 0);
};
const promisify = (fn) => (...args) => new Promise((resolve, reject) => { try { resolve(fn(...args)); } catch (e) { reject(e); } });

function notAvailable(name) {
  return () => { const e = new Error(`NOT_AVAILABLE_IN_VAULT: fs.${name}`); e.code = 'NOT_AVAILABLE_IN_VAULT'; throw e; };
}

const promises = {
  readFile: promisify(readFileSync),
  writeFile: promisify(writeFileSync),
  appendFile: promisify(appendFileSync),
  unlink: promisify(unlinkSync),
  mkdir: promisify(mkdirSync),
  readdir: promisify(readdirSync),
  stat: promisify(statSync),
  access: promisify((p) => { if (!existsSync(p)) throw enoent(p, 'access'); }),
  rm: promisify((p) => { files.delete(norm(p)); }),
};

module.exports = {
  existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, unlinkSync, readdirSync, statSync,
  lstatSync: statSync,
  readFile: cbify(readFileSync), writeFile: cbify(writeFileSync), appendFile: cbify(appendFileSync),
  unlink: cbify(unlinkSync), mkdir: cbify(mkdirSync), readdir: cbify(readdirSync), stat: cbify(statSync),
  access: cbify((p) => { if (!existsSync(p)) throw enoent(p, 'access'); }),
  rmSync: (p) => { files.delete(norm(p)); },
  createReadStream: notAvailable('createReadStream'),
  createWriteStream: notAvailable('createWriteStream'),
  watch: notAvailable('watch'),
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  promises,
  _files: files,
};
