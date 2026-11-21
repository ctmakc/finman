// engine/shims/path.js — POSIX path helpers (path-browserify subset).
'use strict';

function normalizeArray(parts, allowAboveRoot) {
  const res = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { if (res.length && res[res.length - 1] !== '..') res.pop(); else if (allowAboveRoot) res.push('..'); } else res.push(p);
  }
  return res;
}

function normalize(p) {
  p = String(p);
  const abs = p.startsWith('/');
  const trail = p.endsWith('/');
  let s = normalizeArray(p.split('/'), !abs).join('/');
  if (!s && !abs) s = '.';
  if (s && trail) s += '/';
  return (abs ? '/' : '') + s;
}
function join(...parts) { const s = parts.filter((x) => x !== '' && x != null).map(String).join('/'); return s ? normalize(s) : '.'; }
function resolve(...parts) {
  let out = '';
  for (let i = parts.length - 1; i >= 0 && !out.startsWith('/'); i -= 1) { if (parts[i]) out = String(parts[i]) + (out ? '/' + out : ''); }
  if (!out.startsWith('/')) out = '/' + out;
  const s = normalize(out);
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}
function isAbsolute(p) { return String(p).startsWith('/'); }
function dirname(p) {
  p = String(p);
  if (!p) return '.';
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}
function basename(p, ext) {
  let b = String(p).replace(/\/+$/, '');
  b = b.slice(b.lastIndexOf('/') + 1);
  if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
  return b;
}
function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}
function relative(from, to) {
  const f = resolve(from).split('/').filter(Boolean);
  const t = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i += 1;
  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
}
function parse(p) {
  const base = basename(p);
  const ext = extname(p);
  return { root: isAbsolute(p) ? '/' : '', dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
}
function format(o) { const dir = o.dir || o.root || ''; const base = o.base || (o.name || '') + (o.ext || ''); return dir ? (dir.endsWith('/') ? dir + base : dir + '/' + base) : base; }

const path = { sep: '/', delimiter: ':', normalize, join, resolve, isAbsolute, dirname, basename, extname, relative, parse, format };
path.posix = path;
module.exports = path;
