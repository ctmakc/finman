// services/statement/pdfText.js — the text layer of a PDF statement, page by page, as lines.
//
// Uses Mozilla pdf.js (pdfjs-dist legacy build, open source, runs in-process; nothing leaves
// the server). Items of one baseline are joined left to right; a wide horizontal gap
// becomes several spaces so table columns stay apart, the way `pdftotext -layout` keeps them.
// A page with almost no text is a scan or a photo: the agent sends it to the vision path.
'use strict';

const MIN_TEXT_CHARS = 60; // fewer printable characters than this = no usable text layer
const MAX_PAGES = 30;

const path = require('path');
const { spawn } = require('child_process');

const WORKER = path.join(__dirname, 'pdfWorker.mjs');
const TIMEOUT_MS = 20000;

// pdf.js runs in its own short-lived process: a damaged or hostile file cannot block or crash
// the server, and it is killed after TIMEOUT_MS.
function extractItems(buffer) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, String(MAX_PAGES)], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PDF_TIMEOUT')); }, TIMEOUT_MS);
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(Buffer.concat(out).toString('utf8')); } catch (_) { /* fallthrough */ }
      if (!j || !j.ok) return reject(new Error(`PDF_UNREADABLE${j && j.error ? `: ${j.error}` : ''}`));
      resolve(j);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

function linesOf(items) {
  const rows = [];
  let widthSum = 0;
  let charSum = 0;
  for (const it of items) {
    const str = it && typeof it.str === 'string' ? it.str : '';
    if (!str.trim()) continue;
    const [, , , , x, y] = it.transform || [0, 0, 0, 0, 0, 0];
    const h = Math.abs((it.transform && it.transform[3]) || it.height || 10) || 10;
    const w = it.width || str.length * h * 0.5;
    widthSum += w; charSum += str.length;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.45));
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, w, str });
  }
  // Character grid like `pdftotext -layout`: each piece starts at the column of its x, so
  // "Withdrawals" and "Deposits" amounts stay under their own headers on every line.
  const charW = charSum ? Math.max(1, widthSum / charSum) : 5;
  const minX = rows.length ? Math.min(...rows.flatMap((r) => r.parts.map((p) => p.x))) : 0;
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let line = '';
    for (const p of r.parts) {
      const col = Math.round((p.x - minX) / charW);
      if (line.length < col) line += ' '.repeat(col - line.length);
      else if (line && !line.endsWith(' ') && !p.str.startsWith(' ')) line += ' ';
      line += p.str;
    }
    return line.replace(/\s+$/, '');
  });
}

// buffer -> { pageCount, pages: [{ page, text, chars, hasText }] }
async function readPdf(buffer) {
  const j = await extractItems(buffer);
  const pages = j.pages.map((items, i) => {
    const text = linesOf(items || []).join('\n');
    const chars = text.replace(/\s/g, '').length;
    return { page: i + 1, text, chars, hasText: chars >= MIN_TEXT_CHARS };
  });
  return { pageCount: j.pageCount, pages, truncated: j.pageCount > MAX_PAGES };
}

// Every amount-like token on a page, as absolute integer cents: the grounding set. A row the
// model returns from a text page must carry an amount that is printed on that page.
function amountsOnPage(text, toCents) {
  const set = new Set();
  const re = /\(?[-−–]?\s?[$€£]?\s?\d{1,3}(?:[ ,. ]\d{3})*(?:[.,]\d{1,2})?\)?|\d+[.,]\d{1,2}/g;
  for (const m of String(text || '').matchAll(re)) {
    const c = toCents(m[0].replace(/ /g, ' '));
    if (c !== null) set.add(Math.abs(c));
  }
  return set;
}

module.exports = { readPdf, linesOf, amountsOnPage, MIN_TEXT_CHARS, MAX_PAGES };
