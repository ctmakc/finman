// services/invoice/links.js — published invoices for the client page /i/<token> (server only).
//
// The issuer's browser publishes a snapshot of ONE invoice (service.publishSnapshot, built where
// the invoice lives: server tables or the encrypted vault). The server keeps exactly that snapshot
// and nothing else of the account. Payment buttons are derived HERE from the snapshot's template
// data with the same checks as the PDF (https card link, PayPal.me name, e-mail), so a crafted
// snapshot cannot put a javascript: link on the page.
'use strict';

const crypto = require('crypto');
const { query, get, run } = require('../../db/database');
const core = require('./core');

const LINK_RE = /^[A-Za-z0-9_-]{22,64}$/;
const MAX_SNAPSHOT = 4 * 1024 * 1024;
const VIEW_GAP_MIN = 10; // a repeat view within 10 minutes is the same visit
const STATUSES = ['draft', 'sent', 'paid', 'void'];
const IMAGE_RE = /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/;

class LinkError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const bad = (m) => new LinkError(m, 400);

function baseUrl() { return (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, ''); }
function linkUrl(token) { return `${baseUrl()}/i/${token}`; }
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (v === null || v === undefined ? '' : String(v)).slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

// Keeps the fields the page and the PDF use, with types and sizes checked.
function cleanSnapshot(s) {
  if (!isObj(s) || !isObj(s.view)) throw bad('Snapshot is required');
  const v = s.view;
  if (!str(v.number, 40).trim()) throw bad('Snapshot has no invoice number');
  if (!/^[A-Z]{3}$/.test(String(v.currency || ''))) throw bad('Snapshot currency must be a 3-letter code');
  const items = (Array.isArray(v.items) ? v.items : []).slice(0, 200).map((it) => ({
    description: str(it && it.description, 2000), detail: str(it && it.detail, 500), note: str(it && it.note, 500),
    qty: Number(it && it.qty) || 0, price_cents: int(it && it.price_cents), amount_cents: int(it && it.amount_cents),
  }));
  const img = (x) => (x && IMAGE_RE.test(String(x)) && String(x).length < 2.2 * 1024 * 1024 ? String(x) : null);
  const data = isObj(v.data) ? v.data : {};
  const view = {
    layout: v.layout === 'light' ? 'light' : 'classic',
    number: str(v.number, 40).trim(),
    issue_date: core.parseYmd(v.issue_date) ? v.issue_date : core.today(),
    due_date: core.parseYmd(v.due_date) ? v.due_date : null,
    currency: v.currency,
    client_name: str(v.client_name, 300), client_details: str(v.client_details, 2000),
    items,
    subtotal_cents: int(v.subtotal_cents), tax_cents: int(v.tax_cents), total_cents: int(v.total_cents),
    tax_rate: v.tax_rate === null || v.tax_rate === undefined || v.tax_rate === '' ? null : Number(v.tax_rate),
    tax_label: str(v.tax_label, 200), tax_sub: str(v.tax_sub, 300), tax_text: str(v.tax_text, 200),
    terms: str(v.terms, 4000), notes: str(v.notes, 4000),
    data,
    logo: img(v.logo), signature: img(v.signature),
    seller_name: str((isObj(data.seller) && data.seller.name) || v.seller_name, 300),
  };
  const fee = core.cardFeePct(data);
  view.card_fee_pct = fee;
  view.card_fee_cents = core.cardFeeCents(view.total_cents, fee);
  view.card_total_cents = view.total_cents + view.card_fee_cents;
  view.pay_url = core.payUrl(data.pay_online, view.number, view.card_total_cents, view.currency);
  const out = {
    status: STATUSES.includes(s.status) ? s.status : 'sent',
    paid_cents: Math.max(0, Math.min(int(s.paid_cents), view.total_cents)),
    view,
  };
  if (JSON.stringify(out).length > MAX_SNAPSHOT) throw bad('Invoice is too large to publish');
  return out;
}

function stats(row) {
  return {
    invoice_id: row.invoice_id, url: linkUrl(row.token), created_at: row.created_at, updated_at: row.updated_at,
    first_viewed_at: row.first_viewed_at || null, last_viewed_at: row.last_viewed_at || null, view_count: Number(row.view_count) || 0,
  };
}

// Create or refresh the link of one invoice. A link turned off earlier gets a new address.
async function publish(userId, invoiceId, snapshot) {
  const iid = parseInt(invoiceId, 10);
  if (!Number.isInteger(iid) || iid <= 0) throw bad('Invoice id is required');
  const clean = cleanSnapshot(snapshot);
  const snap = JSON.stringify(clean);
  const row = await get('SELECT * FROM invoice_links WHERE user_id = ? AND invoice_id = ?', [userId, iid]);
  if ((!row || row.revoked_at) && clean.status === 'void') throw bad('A void invoice cannot be shared');
  let created = false;
  if (!row) {
    await run('INSERT INTO invoice_links (token, user_id, invoice_id, snapshot) VALUES (?, ?, ?, ?)',
      [crypto.randomBytes(18).toString('base64url'), userId, iid, snap]);
    created = true;
  } else if (row.revoked_at) {
    await run(`UPDATE invoice_links SET token = ?, snapshot = ?, revoked_at = NULL, created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                 first_viewed_at = NULL, last_viewed_at = NULL, view_count = 0 WHERE user_id = ? AND invoice_id = ?`,
    [crypto.randomBytes(18).toString('base64url'), snap, userId, iid]);
    created = true;
  } else {
    await run('UPDATE invoice_links SET snapshot = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND invoice_id = ?', [snap, userId, iid]);
  }
  const now = await get('SELECT * FROM invoice_links WHERE user_id = ? AND invoice_id = ?', [userId, iid]);
  return { link: stats(now), created };
}

// Turning a link off also drops the published copy: the server keeps no invoice text it no longer shows.
async function revoke(userId, invoiceId) {
  await run(`UPDATE invoice_links SET revoked_at = CURRENT_TIMESTAMP, snapshot = '{}' WHERE user_id = ? AND invoice_id = ? AND revoked_at IS NULL`,
    [userId, parseInt(invoiceId, 10)]);
  return { ok: true };
}

async function rekey(userId, map) {
  let moved = 0;
  if (!isObj(map)) return { moved };
  // { oldId: { to, number } }: a link moves only if its published snapshot is that invoice
  // (the vault may already have its own invoice with the old id, with its own link).
  const pairs = [];
  for (const [a, v] of Object.entries(map).slice(0, 1000)) {
    const from = parseInt(a, 10); const to = parseInt(v && v.to, 10);
    if (!(from > 0 && to > 0 && from !== to) || !v || typeof v.number !== 'string') continue;
    const row = await get('SELECT snapshot FROM invoice_links WHERE user_id = ? AND invoice_id = ?', [userId, from]);
    let num = null;
    try { num = JSON.parse(row.snapshot).view.number; } catch (_) { num = null; }
    if (row && num === v.number) pairs.push([from, to]);
  }
  // Two passes through negative ids, so a chain (1 -> 2, 2 -> 3) never hits the unique index.
  for (const [a] of pairs) moved += (await run('UPDATE invoice_links SET invoice_id = ? WHERE user_id = ? AND invoice_id = ?', [-a, userId, a])).changes || 0;
  for (const [a, b] of pairs) await run('UPDATE invoice_links SET invoice_id = ? WHERE user_id = ? AND invoice_id = ?', [b, userId, -a]);
  return { moved };
}

async function list(userId) {
  const rows = await query('SELECT token, invoice_id, created_at, updated_at, first_viewed_at, last_viewed_at, view_count FROM invoice_links WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  return rows.map(stats);
}

async function rowByToken(token) {
  if (!LINK_RE.test(String(token || ''))) return null;
  return get('SELECT * FROM invoice_links WHERE token = ?', [String(token)]);
}

// What the client page needs. null = no such link; { gone: true } = turned off.
async function byToken(token) {
  const row = await rowByToken(token);
  if (!row) return null;
  if (row.revoked_at) return { gone: true };
  let s;
  try { s = cleanSnapshot(JSON.parse(row.snapshot)); } catch (_) { return null; }
  const view = s.view;
  const d = view.data || {};
  const total = view.total_cents;
  const paid = s.status === 'paid' ? total : s.paid_cents;
  const due = s.status === 'paid' ? 0 : Math.max(0, total - paid);
  const status = s.status === 'sent' && view.due_date && view.due_date < core.today() ? 'overdue' : s.status;
  const fee = core.cardFeeCents(due, view.card_fee_pct);
  const bank = isObj(d.bank) && (Array.isArray(d.bank.key) || Array.isArray(d.bank.rest)) ? d.bank : null;
  return {
    token: row.token,
    user_id: row.user_id,
    status,
    view,
    paid_cents: paid,
    balance_cents: due,
    pay: {
      card_url: due > 0 ? core.payUrl(d.pay_online, view.number, due + fee, view.currency) : null,
      paypal_url: due > 0 ? core.paypalUrl(d.pay_paypal, due + fee, view.currency) : null,
      etransfer: core.etransferEmail(d.pay_etransfer),
      bank,
      reference: core.fill(d.payment_reference || '', { number: view.number }).trim() || view.number,
      fee_pct: view.card_fee_pct,
      fee_cents: fee,
      card_total_cents: due + fee,
    },
    filename: require('./service').fileName(view),
  };
}

async function recordView(token) {
  if (!LINK_RE.test(String(token || ''))) return { ok: false };
  const r = await run(
    `UPDATE invoice_links SET first_viewed_at = COALESCE(first_viewed_at, CURRENT_TIMESTAMP),
            view_count = view_count + CASE WHEN last_viewed_at IS NULL OR last_viewed_at < datetime('now', ?) THEN 1 ELSE 0 END,
            last_viewed_at = CURRENT_TIMESTAMP
      WHERE token = ? AND revoked_at IS NULL`, [`-${VIEW_GAP_MIN} minutes`, String(token)]);
  return { ok: r.changes > 0 };
}

async function pdf(token) {
  const p = await byToken(token);
  if (!p || p.gone) return null;
  return { buffer: await require('./service').renderPdf(p.view, p.user_id), filename: p.filename };
}

module.exports = { LinkError, cleanSnapshot, publish, revoke, list, rekey, byToken, recordView, pdf, linkUrl };
