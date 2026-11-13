// lib/assetVersion.js — content-versioned links for the app shell.
//
// The service worker caches by URL. With plain /css/style.css links a deploy
// could paint new markup with an old cached stylesheet (12.11.2026: the sign-in
// screen kept the old mint palette and dark-green button on phones that had
// the previous shell cached). Every /css, /js and /vendor link in index.html
// and every @import in style.css gets ?v=<hash of the shipped files>, so a new
// release is a new URL that no cache has seen.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A hand-written ?v=N on a link is replaced by the content hash.
const LINK_RE = /((?:href|src)=")(\/(?:css|js|vendor)\/[^"?#]+\.(?:css|js))(?:\?v=[^"]*)?(")/g;
const IMPORT_RE = /(@import\s+url\(\s*["']?)(\/css\/[^"'?)]+\.css)(["']?\s*\))/g;

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

function hashFiles(publicDir) {
  const h = crypto.createHash('sha1');
  const files = [path.join(publicDir, 'index.html')];
  for (const sub of ['css', 'js']) walk(path.join(publicDir, sub), files);
  for (const f of files) {
    h.update(path.relative(publicDir, f));
    try { h.update(fs.readFileSync(f)); } catch (_) { /* missing file: name still counts */ }
  }
  return h.digest('hex').slice(0, 10);
}

function stampHtml(html, v) {
  return html.replace(LINK_RE, `$1$2?v=${v}$3`);
}

function stampCss(css, v) {
  return css.replace(IMPORT_RE, `$1$2?v=${v}$3`);
}

// Express wiring: versioned index.html for "/" and the SPA fallback, and
// style.css with versioned @imports. Content is read once (the image is
// immutable); FINMAN_ASSET_V overrides the hash if ever needed.
function create(publicDir) {
  const v = process.env.FINMAN_ASSET_V || hashFiles(publicDir);
  const html = stampHtml(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), v);
  let styleCss = null;
  try { styleCss = stampCss(fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8'), v); } catch (_) { styleCss = null; }

  function sendIndex(req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(html);
  }

  function styleMiddleware(req, res, next) {
    if (!styleCss || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    res.set('Content-Type', 'text/css; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=0');
    return res.send(styleCss);
  }

  return { v, html, sendIndex, styleMiddleware };
}

module.exports = { create, stampHtml, stampCss, hashFiles };
