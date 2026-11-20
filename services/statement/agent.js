// services/statement/agent.js — Finman Statement Agent: a PDF or photo statement in, proven rows out.
//
//   read({ buffer, mime, fileName, ai }) -> { meta, rows, proof, attempts, usage, ms, mode, pages }
//
// 1. Look:   a PDF with a text layer is read locally (pdf.js), page by page; a scan or a photo
//            goes to the vision model as the file itself.
// 2. Read:   the model returns strict JSON: opening, closing, rows as printed (never fixed).
// 3. Check:  every amount from a text page must be printed on that page (grounding); then the
//            balance proof in integer cents (proof.js): opening + rows = closing, row by row.
// 4. Retry:  only the page where the chain breaks is read again, at most twice. The model is
//            never told the expected number, so it cannot "make it balance".
// 5. Stop:   proven -> the person sees one line and one button; anything else -> the gap and
//            the row, and nothing can be written until the person decides.
//
// ai: { source: 'user', provider, key, model, baseUrl } | { source: 'platform' }
'use strict';

const crypto = require('crypto');
const proof = require('./proof');
const pdfText = require('./pdfText');
const userProviders = require('../userAi/providers');
const platform = require('../../lib/ai/provider');

const MAX_REREADS = 2;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

class StatementError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

const SYSTEM = [
  'You read bank and credit card statements for Finman, a personal finance app. You return JSON only.',
  'Shape: {"statement_type":"bank"|"card","institution":string|null,"account_ref":string|null,"currency":"ISO 4217 code"|null,',
  '"period_start":"YYYY-MM-DD"|null,"period_end":"YYYY-MM-DD"|null,"opening_balance":string|null,"closing_balance":string|null,',
  '"rows":[{"date":"YYYY-MM-DD","description":string,"amount":string|null,"balance":string|null,"page":integer,"unclear":boolean}],"notes":string|null}',
  'Rules:',
  '- Copy every transaction row exactly as printed, in printed order, page by page. Never skip, merge, split, reorder or invent rows. Opening, closing, subtotal and "balance forward" lines are not rows.',
  '- amount: signed decimal with a dot and no thousands separators, e.g. "-1650.00", from the account holder\'s view: money out (withdrawal, debit, purchase, fee, payment sent) is negative; money in (deposit, credit, refund, payment received) is positive. Decide by the column the number is printed in (Withdrawals/Debits vs Deposits/Credits), by CR/DR marks, minus signs or parentheses.',
  '- Credit card statements: a purchase or fee is negative, a payment to the card or a refund is positive; opening_balance = previous balance and closing_balance = new balance, as printed (amount owed, positive).',
  '- balance: the running balance printed on that row in the same format, or null when the row has none.',
  '- Never correct, round or recompute any number so that totals match. If a digit cannot be read, set amount to null and unclear to true. Do not guess.',
  '- opening_balance and closing_balance: only as printed; null when the statement does not print them. Never compute them.',
  '- date: YYYY-MM-DD; when a row shows only day and month, take the year from the statement period.',
  '- description: the description text of the row; join a description that wraps onto a second line.',
  '- page: the 1-based page where the row is printed.',
  '- A photo may be tilted or curved: follow each printed line across the page so the date, description, amount and balance of a row come from the same line.',
  '- account_ref: the account or card number as printed (masked is fine).',
].join('\n');

function detectKind(buffer, mime, fileName) {
  const head = buffer.subarray(0, 8);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return { kind: 'pdf', mime: 'application/pdf' };
  if (head[0] === 0xff && head[1] === 0xd8) return { kind: 'image', mime: 'image/jpeg' };
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return { kind: 'image', mime: 'image/png' };
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (IMAGE_MIMES.has(mime)) return { kind: 'image', mime };
  throw new StatementError('STATEMENT_TYPE', `Upload a PDF, JPG, PNG or WEBP statement${fileName ? ` ("${String(fileName).slice(0, 80)}" is not one)` : ''}`);
}

function parseJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function calendarDate(s) {
  if (!ISO.test(String(s || ''))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

function normalizeRows(raw, defaultPage) {
  return (Array.isArray(raw) ? raw : []).slice(0, 2000).map((r) => {
    const cents = r && r.amount !== null && r.amount !== undefined ? proof.toCents(r.amount) : null;
    const date = calendarDate(r && r.date);
    return {
      date,
      date_raw: date ? undefined : (r && r.date ? String(r.date).slice(0, 20) : null),
      description: String((r && r.description) || '').replace(/\s+/g, ' ').trim().slice(0, 500) || 'Transaction',
      cents,
      balance_cents: r && r.balance !== null && r.balance !== undefined && r.balance !== '' ? proof.toCents(r.balance) : null,
      page: Number.isInteger(r && r.page) && r.page > 0 ? r.page : (parseInt(r && r.page, 10) || defaultPage || 1),
      unclear: !!(r && r.unclear) || cents === null,
    };
  });
}

function meta(json) {
  const j = json || {};
  const cur = typeof j.currency === 'string' && /^[A-Za-z]{3}$/.test(j.currency.trim()) ? j.currency.trim().toUpperCase() : null;
  // Only the last 4 digits are kept; the full number is never stored.
  const ref = j.account_ref || j.account_last4;
  const last4 = ref ? String(ref).replace(/\D/g, '').slice(-4) || null : null;
  return {
    statement_type: j.statement_type === 'card' ? 'card' : 'bank',
    institution: j.institution ? String(j.institution).slice(0, 120) : null,
    account_last4: last4,
    currency: cur,
    period_start: calendarDate(j.period_start),
    period_end: calendarDate(j.period_end),
    opening_cents: j.opening_balance === null || j.opening_balance === undefined ? null : proof.toCents(j.opening_balance),
    closing_cents: j.closing_balance === null || j.closing_balance === undefined ? null : proof.toCents(j.closing_balance),
    notes: j.notes ? String(j.notes).slice(0, 500) : null,
  };
}

let retryDelayMs = 3000;
// Busy, rate-limited or silent (timeout: the platform error then carries no HTTP status).
const busy = (e) => !!e && (['AI_BUSY', 'AI_RATE_LIMIT', 'AI_TIMEOUT'].includes(e.code) || /HTTP (429|500|502|503|504)\b/.test(String(e.message || '')) || (e.code === 'AI_REQUEST_FAILED' && !/HTTP \d/.test(String(e.message || ''))));

// Instance AI: text pages go to STATEMENT_AI_MODEL; scans and photos to STATEMENT_AI_VISION_MODEL
// (a stronger reader: on tilted photos the light model paired dates with the row below). A busy
// or rate-limited model gets two quiet retries (3 s, 6 s); the vision model hands over to the
// text model on the retry.
function platformModels(vision) {
  const text = process.env.STATEMENT_AI_MODEL || undefined;
  const vis = process.env.STATEMENT_AI_VISION_MODEL || text;
  return vision && vis !== text ? [vis, text] : [text];
}

async function callModel(ai, parts, { vision = false } = {}) {
  const models = ai.source === 'user' ? [ai.model] : platformModels(vision);
  for (let attempt = 0; ; attempt += 1) {
    const model = models[Math.min(attempt, models.length - 1)];
    try { return await callModelOnce(ai, parts, model); } catch (e) {
      if (!busy(e) || attempt >= 2) throw e;
      await new Promise((ok) => setTimeout(ok, retryDelayMs * (attempt + 1)));
    }
  }
}
function _setRetryDelay(ms) { retryDelayMs = ms; }

async function callModelOnce(ai, parts, model) {
  if (ai.source === 'user') {
    return userProviders.generate({ provider: ai.provider, key: ai.key, model: ai.model, baseUrl: ai.baseUrl, system: SYSTEM, parts, json: true });
  }
  return platform.generate({
    system: SYSTEM, parts, json: true, maxTokens: 32768,
    provider: process.env.STATEMENT_AI_PROVIDER || undefined, model,
  });
}

// One model reading -> parsed JSON (one quiet retry when the JSON comes back broken).
async function readOnce(ai, parts, usage, opts) {
  for (let i = 0; i < 2; i += 1) {
    const r = await callModel(ai, parts, opts);
    usage.calls += 1;
    if (r.usage) { usage.input += r.usage.input || 0; usage.output += r.usage.output || 0; }
    if (r.model) usage.model = r.model;
    if (r.provider) usage.provider = r.provider;
    const j = parseJson(r.text);
    if (j && Array.isArray(j.rows)) return j;
  }
  throw new StatementError('STATEMENT_UNREADABLE', 'The AI did not return the statement rows. Try again, or upload a clearer file.', 502);
}

// Text pages: every amount the model returns must be printed on its page.
function ground(rows, pageAmounts) {
  if (!pageAmounts) return [];
  const bad = [];
  rows.forEach((r, i) => {
    if (!Number.isInteger(r.cents)) return;
    const set = pageAmounts.get(r.page);
    if (set && !set.has(Math.abs(r.cents))) { r.ungrounded = true; bad.push(i); }
  });
  return bad;
}

// The balance proof covers amounts, not dates. Dates get their own check: inside the statement
// period (3 days of slack) and in printed order when the statement is chronological.
function dateIssues(m, rows) {
  const bad = new Set();
  const lo = m.period_start ? new Date(Date.parse(`${m.period_start}T00:00:00Z`) - 3 * 86400000).toISOString().slice(0, 10) : null;
  const hi = m.period_end ? new Date(Date.parse(`${m.period_end}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10) : null;
  const dated = rows.map((r, i) => [i, r.date]).filter(([, d]) => d);
  let up = 0; let down = 0;
  for (let k = 1; k < dated.length; k += 1) { if (dated[k][1] > dated[k - 1][1]) up += 1; else if (dated[k][1] < dated[k - 1][1]) down += 1; }
  const ascending = up >= down;
  rows.forEach((r, i) => {
    if (!r.date) { bad.add(i); return; }
    if ((lo && r.date < lo) || (hi && r.date > hi)) bad.add(i);
  });
  // Out of order: a row earlier (ascending) than both neighbours' window = misread day or month.
  for (let k = 1; k < dated.length - 1; k += 1) {
    const [i, d] = dated[k];
    const prev = dated[k - 1][1];
    const next = dated[k + 1][1];
    if (ascending ? (d < prev && prev <= next) || (d > next && prev <= next) : (d > prev && prev >= next) || (d < next && prev >= next)) bad.add(i);
  }
  return [...bad].sort((a, b) => a - b);
}

function check(m, rows, pageAmounts) {
  const d = proof.deriveUnclear(rows, m.opening_cents, m.statement_type);
  // A "row" whose amount would derive to 0.00 is a wrapped line or a repeated balance, not a
  // transaction (a phantom copy of the row above on a photo): it is left out and said so.
  const phantom = d.rows.filter((r) => r.derived && r.cents === 0).length;
  if (phantom) {
    d.rows = d.rows.filter((r) => !(r.derived && r.cents === 0));
    d.derived = d.rows.map((r, i) => (r.derived ? i : -1)).filter((i) => i >= 0);
  }
  // Derived amounts are not printed (that is why they were unreadable): grounding skips them.
  const ungrounded = ground(d.rows.map((r) => (r.derived ? { ...r, cents: null } : r)), pageAmounts);
  d.rows.forEach((r, i) => { if (ungrounded.includes(i)) r.ungrounded = true; });
  const badDates = dateIssues(m, d.rows);
  const p = proof.prove({ opening_cents: m.opening_cents, closing_cents: m.closing_cents, rows: d.rows, kind: m.statement_type });
  p.derived_rows = d.derived;
  p.ungrounded_rows = ungrounded;
  if (ungrounded.length && p.status === 'proven') {
    p.status = 'gap';
    p.line = `${ungrounded.length} amount(s) are not printed on their page; nothing is written`;
  }
  p.date_issue_rows = badDates;
  if (badDates.length && p.status === 'proven') {
    p.status = 'unclear';
    p.line = `Amounts balance, but ${badDates.length} date(s) fall outside the statement period or out of order; nothing is written`;
  }
  const notes = [];
  if (p.opening_inferred) notes.push('opening taken from the first row\'s printed balance');
  if (d.derived.length) notes.push(`${d.derived.length} unreadable amount(s) derived from the printed balances around them, not guessed`);
  if (phantom) notes.push(`${phantom} line(s) without an amount and with an unchanged balance left out`);
  p.notes = notes;
  if (notes.length && p.status === 'proven') p.line += ` (${notes.join('; ')})`;
  p.phantom_rows = phantom;
  return { rows: d.rows, proof: p };
}

// How bad is a reading? Lower is better: proven 0, then fewer breaks / smaller gap.
function score(c) {
  const p = c.proof;
  if (p.status === 'proven') return 0;
  return 1 + p.breaks.length * 1000 + p.unclear_rows.length * 1000 + (p.ungrounded_rows || []).length * 1000 + (p.date_issue_rows || []).length * 1000 + Math.min(999, Math.abs(p.gap_cents || 0) / 100);
}

function pageToReread(c) {
  const p = c.proof;
  if (p.first_break && p.first_break.page) return p.first_break.page;
  const i = [...p.unclear_rows, ...(p.ungrounded_rows || []), ...(p.date_issue_rows || [])][0];
  if (i !== undefined && c.rows[i]) return c.rows[i].page;
  return null;
}

async function read({ buffer, mime, fileName, ai }) {
  if (!buffer || !buffer.length) throw new StatementError('STATEMENT_EMPTY', 'The file is empty');
  const t0 = Date.now();
  const k = detectKind(buffer, mime, fileName);
  const usage = { input: 0, output: 0, calls: 0, provider: ai.provider || null, model: ai.model || null };
  const b64 = buffer.toString('base64');

  let mode;
  let pages = 1;
  let textPages = null;
  let pageAmounts = null;
  if (k.kind === 'pdf') {
    let pdf;
    try { pdf = await pdfText.readPdf(buffer); } catch (e) {
      throw new StatementError('STATEMENT_BAD_PDF', 'This PDF cannot be opened (damaged or password-protected)');
    }
    pages = pdf.pageCount;
    if (pdf.truncated) throw new StatementError('STATEMENT_TOO_LONG', `Statements up to ${pdfText.MAX_PAGES} pages`);
    if (pdf.pages.every((pg) => pg.hasText)) {
      mode = 'text';
      textPages = pdf.pages;
      pageAmounts = new Map(pdf.pages.map((pg) => [pg.page, pdfText.amountsOnPage(pg.text, proof.toCents)]));
    } else mode = 'pdf-vision';
  } else mode = 'photo';

  const wholeParts = (extra) => {
    if (mode === 'text') {
      const body = textPages.map((pg) => `=== Page ${pg.page} of ${pages} ===\n${pg.text}`).join('\n\n');
      return [{ text: `${extra ? `${extra}\n\n` : ''}Statement text layer (columns kept by spacing):\n\n${body}` }];
    }
    return [{ mime: k.mime, data: b64 }, { text: extra || 'Read this statement.' }];
  };

  const vision = { vision: mode !== 'text' };
  const first = await readOnce(ai, wholeParts(), usage, vision);
  const m = meta(first);
  let best = check(m, normalizeRows(first.rows), pageAmounts);
  const attempts = [{ attempt: 1, scope: 'all pages', status: best.proof.status, gap_cents: best.proof.gap_cents, breaks: best.proof.breaks.length }];

  for (let n = 0; n < MAX_REREADS && best.proof.status !== 'proven' && best.proof.status !== 'needs_closing' && best.proof.status !== 'needs_opening'; n += 1) {
    const page = pageToReread(best);
    const ask = page
      ? `Read ONLY page ${page} again, very carefully, digit by digit. A row on this page may have been skipped, read in the wrong column, or an amount or a date misread. Return the same JSON shape with the rows of page ${page} only (page = ${page}), plus opening_balance and closing_balance if they are printed on this page.`
      : 'Read the whole statement again, very carefully, digit by digit. A row may have been skipped, read in the wrong column, or an amount or a date misread.';
    let parts;
    if (page && mode === 'text') {
      const pg = textPages.find((x) => x.page === page);
      parts = [{ text: `${ask}\n\n=== Page ${page} of ${pages} ===\n${pg ? pg.text : ''}` }];
    } else parts = wholeParts(ask);
    let again;
    try { again = await readOnce(ai, parts, usage, vision); } catch (e) { break; }
    const am = meta(again);
    let rows;
    const m2 = { ...m };
    if (page) {
      const fresh = normalizeRows(again.rows, page).map((r) => ({ ...r, page }));
      rows = [];
      let placed = false;
      for (const r of best.rows) {
        if (r.page === page) { if (!placed) { rows.push(...fresh); placed = true; } } else rows.push({ ...r, ungrounded: undefined });
      }
      if (!placed) rows.push(...fresh);
      if (page === 1 && am.opening_cents !== null) m2.opening_cents = am.opening_cents;
      if (page === pages && am.closing_cents !== null) m2.closing_cents = am.closing_cents;
    } else {
      rows = normalizeRows(again.rows);
      Object.assign(m2, { opening_cents: am.opening_cents, closing_cents: am.closing_cents });
    }
    const c = check(m2, rows, pageAmounts);
    attempts.push({ attempt: attempts.length + 1, scope: page ? `page ${page}` : 'all pages', status: c.proof.status, gap_cents: c.proof.gap_cents, breaks: c.proof.breaks.length });
    if (score(c) < score(best)) { best = c; Object.assign(m, m2); }
  }

  return {
    meta: m,
    rows: best.rows,
    proof: best.proof,
    attempts,
    usage,
    ms: Date.now() - t0,
    mode,
    pages,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

// The person typed a balance the statement does not print (or confirms one): prove again, no AI.
function reprove({ meta: m, rows, opening_cents: o, closing_cents: c }) {
  const m2 = { ...m };
  if (Number.isInteger(o)) m2.opening_cents = o;
  if (Number.isInteger(c)) m2.closing_cents = c;
  const p = proof.prove({ opening_cents: m2.opening_cents, closing_cents: m2.closing_cents, rows, kind: m2.statement_type });
  return { meta: m2, proof: p };
}

module.exports = { _setRetryDelay, read, reprove, detectKind, parseJson, normalizeRows, meta, check, dateIssues, SYSTEM, StatementError, MAX_REREADS };
