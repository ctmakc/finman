// services/invoice/service.js — invoices and invoice templates (profiles) in the DB.
//
// A profile is a user's invoice template (seller block, bank block, tax line, terms,
// numbering, optional logo/signature). An invoice freezes its template in `snapshot`
// when it is created, so editing a template later never rewrites an issued invoice
// (drafts take the current template again on save).
'use strict';

const crypto = require('crypto');
const { query, get, run } = require('../../db/database');
const core = require('./core');
const presets = require('./presets');

const LAYOUTS = ['classic', 'light'];
const STATUSES = ['draft', 'sent', 'paid', 'void'];
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_DATA_JSON = 64 * 1024;
const MAX_ITEMS = 200;
const IMAGE_RE = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/;
const SHARE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

class InvoiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const bad = (m) => new InvoiceError(m, 400);
const notFound = (m = 'Not found') => new InvoiceError(m, 404);

function parseJson(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}
const str = (v, max) => (v === null || v === undefined ? '' : String(v)).slice(0, max);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function baseUrl() {
  return (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, '');
}

// ---------- template data ----------
// Defaults of the layout + the template's own data; nested blocks merge one level deep.
function mergeData(layout, data) {
  const def = presets.defaultsFor(layout);
  const d = isObj(data) ? data : {};
  const out = { ...def, ...d };
  for (const k of ['seller', 'tax', 'words']) {
    if (isObj(def[k]) || isObj(d[k])) out[k] = { ...(def[k] || {}), ...(isObj(d[k]) ? d[k] : {}) };
  }
  if (!Array.isArray(out.seller.lines)) out.seller.lines = [];
  return out;
}

function checkImage(v, field) {
  if (v === null || v === '') return null;
  const m = IMAGE_RE.exec(String(v));
  if (!m) throw bad(`${field} must be a PNG or JPEG data URL`);
  const bytes = Buffer.byteLength(m[2].replace(/\s/g, ''), 'base64');
  if (bytes > MAX_IMAGE_BYTES) throw bad(`${field} is larger than 1.5 MB`);
  return String(v).replace(/\s/g, '');
}

function cleanProfileInput(body, partial) {
  const b = isObj(body) ? body : {};
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = str(b.name, 120).trim();
    if (!out.name) throw bad('Template name is required');
  }
  if (!partial || b.layout !== undefined) {
    out.layout = LAYOUTS.includes(b.layout) ? b.layout : 'classic';
  }
  if (!partial || b.currency !== undefined) {
    out.currency = str(b.currency || 'USD', 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(out.currency)) throw bad('Currency must be a 3-letter code');
  }
  if (!partial || b.number_format !== undefined) {
    out.number_format = str(b.number_format || '{SEQ}', 60).trim() || '{SEQ}';
  }
  if (!partial || b.next_seq !== undefined) {
    const n = parseInt(b.next_seq, 10);
    out.next_seq = Number.isFinite(n) && n >= 1 && n < 1e9 ? n : 1;
  }
  if (!partial || b.due_days !== undefined) {
    const n = parseInt(b.due_days, 10);
    out.due_days = Number.isFinite(n) && n >= 0 && n <= 365 ? n : 14;
  }
  if (!partial || b.data !== undefined) {
    const data = isObj(b.data) ? b.data : {};
    const json = JSON.stringify(data);
    if (json.length > MAX_DATA_JSON) throw bad('Template is too large');
    out.data = json;
  }
  if (b.is_default !== undefined) out.is_default = b.is_default ? 1 : 0;
  if (b.logo !== undefined) out.logo = checkImage(b.logo, 'logo');
  if (b.signature !== undefined) out.signature = checkImage(b.signature, 'signature');
  return out;
}

function publicProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    layout: row.layout,
    currency: row.currency,
    number_format: row.number_format,
    next_seq: row.next_seq,
    due_days: row.due_days,
    is_default: row.is_default ? 1 : 0,
    has_logo: !!row.logo,
    has_signature: !!row.signature,
    source_share: row.source_share || null,
    data: parseJson(row.data, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const PROFILE_COLS = 'id, user_id, name, layout, currency, number_format, next_seq, due_days, data, is_default, source_share, created_at, updated_at, logo IS NOT NULL AS has_logo_flag, signature IS NOT NULL AS has_sig_flag';
function liteRow(r) {
  if (!r) return r;
  return { ...r, logo: r.has_logo_flag ? 1 : null, signature: r.has_sig_flag ? 1 : null };
}

async function listProfiles(userId) {
  const rows = await query(`SELECT ${PROFILE_COLS} FROM invoice_profiles WHERE user_id = ? ORDER BY is_default DESC, id`, [userId]);
  return rows.map((r) => publicProfile(liteRow(r)));
}

async function profileRow(userId, id) {
  const row = await get('SELECT * FROM invoice_profiles WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) throw notFound('Template not found');
  return row;
}

async function getProfile(userId, id) { return publicProfile(await profileRow(userId, id)); }

async function clearDefault(userId, exceptId) {
  await run('UPDATE invoice_profiles SET is_default = 0 WHERE user_id = ? AND id != ?', [userId, exceptId || 0]);
}

async function createProfile(userId, body, extra = {}) {
  const p = cleanProfileInput(body, false);
  const count = await get('SELECT COUNT(*) AS n FROM invoice_profiles WHERE user_id = ?', [userId]);
  if (count.n >= 50) throw bad('Too many templates');
  const isDefault = p.is_default !== undefined ? p.is_default : (count.n === 0 ? 1 : 0);
  const r = await run(
    `INSERT INTO invoice_profiles (user_id, name, layout, currency, number_format, next_seq, due_days, data, logo, signature, is_default, source_share)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, p.name, p.layout, p.currency, p.number_format, p.next_seq, p.due_days, p.data,
      p.logo || null, p.signature || null, isDefault, extra.source_share || null],
  );
  if (isDefault) await clearDefault(userId, r.id);
  return getProfile(userId, r.id);
}

async function updateProfile(userId, id, body) {
  await profileRow(userId, id);
  const p = cleanProfileInput(body, true);
  const keys = Object.keys(p);
  if (keys.length) {
    await run(
      `UPDATE invoice_profiles SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
      [...keys.map((k) => p[k]), id, userId],
    );
  }
  if (p.is_default) await clearDefault(userId, id);
  return getProfile(userId, id);
}

async function deleteProfile(userId, id) {
  const row = await profileRow(userId, id);
  await run('DELETE FROM invoice_profiles WHERE id = ? AND user_id = ?', [id, userId]);
  if (row.is_default) {
    const next = await get('SELECT id FROM invoice_profiles WHERE user_id = ? ORDER BY id LIMIT 1', [userId]);
    if (next) await run('UPDATE invoice_profiles SET is_default = 1 WHERE id = ?', [next.id]);
  }
  return { ok: true };
}

async function profileImage(userId, id, kind) {
  if (!['logo', 'signature'].includes(kind)) throw notFound();
  const row = await profileRow(userId, id);
  const v = row[kind];
  const m = v && IMAGE_RE.exec(v);
  if (!m) throw notFound('No image');
  return { type: m[1] === 'png' ? 'image/png' : 'image/jpeg', buffer: Buffer.from(m[2], 'base64') };
}

// ---------- sharing ----------
function newShareCode(len = 10) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += SHARE_ALPHABET[bytes[i] % SHARE_ALPHABET.length];
  return s;
}

function shareUrl(code, inviteCode) {
  const ref = inviteCode ? `&fm_ref=invite-${inviteCode}` : '';
  return `${baseUrl()}/invoices?tpl=${code}&signup${ref}&utm_source=invoice_template&utm_medium=share&utm_campaign=template_share`;
}

async function inviteCodeFor(userId) {
  try { return await require('../referral').codeFor(userId); } catch (_) { return null; }
}

// Inserts a share row (createdBy may be null for templates seeded by the team).
async function insertShare(createdBy, profileId, p) {
  for (let i = 0; i < 5; i += 1) {
    const code = newShareCode();
    try {
      await run(
        `INSERT INTO invoice_template_shares (code, created_by, profile_id, name, layout, currency, number_format, due_days, data, logo, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [code, createdBy, profileId, p.name, p.layout, p.currency, p.number_format, p.due_days,
          typeof p.data === 'string' ? p.data : JSON.stringify(p.data || {}), p.logo || null, p.signature || null],
      );
      return code;
    } catch (e) {
      if (!/UNIQUE|PRIMARY/i.test(e.message)) throw e;
    }
  }
  throw new Error('could not allocate a share code');
}

async function shareProfile(userId, id) {
  const row = await profileRow(userId, id);
  const code = await insertShare(userId, row.id, row);
  return { code, url: shareUrl(code, await inviteCodeFor(userId)) };
}

async function shareRow(code) {
  if (!/^[a-z0-9]{6,16}$/i.test(String(code || ''))) throw notFound('Template link not found');
  const row = await get('SELECT * FROM invoice_template_shares WHERE code = ?', [String(code).toLowerCase()]);
  if (!row) throw notFound('Template link not found');
  return row;
}

async function getShared(code) {
  const row = await shareRow(code);
  const data = parseJson(row.data, {});
  return {
    template: {
      code: row.code,
      name: row.name,
      layout: row.layout,
      currency: row.currency,
      seller_name: (data.seller && data.seller.name) || '',
      has_logo: !!row.logo,
    },
  };
}

// Copies a shared template into the user's templates; a second import returns the same copy.
async function importShared(userId, code) {
  const row = await shareRow(code);
  const existing = await get('SELECT id FROM invoice_profiles WHERE user_id = ? AND source_share = ?', [userId, row.code]);
  if (existing) return { profile: await getProfile(userId, existing.id), created: false };
  const profile = await createProfile(userId, {
    name: row.name, layout: row.layout, currency: row.currency, number_format: row.number_format,
    next_seq: 1, due_days: row.due_days, data: parseJson(row.data, {}), logo: row.logo, signature: row.signature,
  }, { source_share: row.code });
  await run('UPDATE invoice_template_shares SET uses = uses + 1 WHERE code = ?', [row.code]);
  return { profile, created: true };
}

function listPresets() {
  return Object.values(presets.BLANKS).map((p) => ({
    key: p.key, name: p.name, layout: p.layout, currency: p.currency,
    number_format: p.number_format, due_days: p.due_days, data: p.data,
  }));
}

// ---------- invoices ----------
function toQty(v) {
  if (v === null || v === undefined || v === '') return 1;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw bad('Quantity must be a number');
  return Math.round(n * 1000) / 1000;
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  if (items.length > MAX_ITEMS) throw bad('Too many lines');
  const out = [];
  for (const it of items) {
    if (!isObj(it)) continue;
    const description = str(it.description, 2000).trim();
    const detail = str(it.detail, 500).trim();
    const note = str(it.note, 500).trim();
    let price = 0;
    if (it.price !== undefined && it.price !== null && it.price !== '') price = core.toCents(it.price);
    else if (it.price_cents !== undefined && it.price_cents !== null) price = Number(it.price_cents);
    if (price === null || !Number.isFinite(price)) throw bad(`Price "${it.price}" is not a number`);
    if (!description && !price) continue;
    const row = { description, qty: toQty(it.qty), price_cents: Math.round(price) };
    if (detail) row.detail = detail;
    if (note) row.note = note;
    out.push(row);
  }
  return out;
}

function taxRate(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.').replace('%', ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('Tax rate must be 0–100');
  return n;
}

function snapshotOf(profileRowFull) {
  return {
    profile_id: profileRowFull.id,
    name: profileRowFull.name,
    layout: profileRowFull.layout,
    data: mergeData(profileRowFull.layout, parseJson(profileRowFull.data, {})),
    logo: profileRowFull.logo || null,
    signature: profileRowFull.signature || null,
  };
}

async function usedNumbers(userId, exceptId) {
  const rows = await query('SELECT number FROM invoices WHERE user_id = ? AND id != ?', [userId, exceptId || 0]);
  return new Set(rows.map((r) => r.number));
}

async function nextNumber(userId, profileId, date) {
  const p = await profileRow(userId, profileId);
  const d = core.parseYmd(date) ? date : core.today();
  return core.suggestNumber(p.number_format, d, p.next_seq, await usedNumbers(userId));
}

// Builds the stored fields from the request body, a template snapshot and (on update) the old row.
async function compose(userId, body, { prev = null, snapshot, profile }) {
  const b = isObj(body) ? body : {};
  const data = snapshot.data;
  const pick = (k, fallback) => (b[k] !== undefined ? b[k] : (prev ? prev[k] : fallback));

  let issue = pick('issue_date', core.today());
  if (!core.parseYmd(issue)) throw bad('Issue date must be YYYY-MM-DD');
  const dueDays = profile ? profile.due_days : (prev && prev.due_date ? core.daysBetween(prev.issue_date, prev.due_date) : 14);
  let due = b.due_date !== undefined ? b.due_date : (prev && b.issue_date === undefined ? prev.due_date : core.addDays(issue, dueDays));
  if (due === '' || due === null) due = null;
  if (due && !core.parseYmd(due)) throw bad('Due date must be YYYY-MM-DD');

  const currency = str(pick('currency', profile ? profile.currency : 'USD'), 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('Currency must be a 3-letter code');

  let number = str(b.number !== undefined ? b.number : (prev ? prev.number : ''), 40).trim();
  const used = await usedNumbers(userId, prev && prev.id);
  if (!number) {
    number = core.suggestNumber(profile ? profile.number_format : '{SEQ}', issue, profile ? profile.next_seq : 1, used);
  } else if (used.has(number)) {
    throw bad(`Invoice number ${number} is already used`);
  }

  const items = b.items !== undefined ? cleanItems(b.items) : parseJson(prev && prev.items, []);
  const rate = b.tax_rate !== undefined ? taxRate(b.tax_rate) : (prev ? prev.tax_rate : taxRate(data.tax && data.tax.rate));
  const totals = core.computeTotals(items, rate);
  const tax = data.tax || {};

  return {
    number,
    issue_date: issue,
    due_date: due,
    currency,
    client_name: str(pick('client_name', ''), 300).trim(),
    client_details: str(pick('client_details', ''), 2000),
    items: JSON.stringify(totals.items),
    tax_rate: rate,
    tax_label: str(pick('tax_label', tax.label || ''), 200),
    tax_sub: str(pick('tax_sub', tax.sub || ''), 300),
    tax_text: str(pick('tax_text', tax.text || ''), 200),
    subtotal_cents: totals.subtotal_cents,
    tax_cents: totals.tax_cents,
    total_cents: totals.total_cents,
    terms: str(pick('terms', data.terms || ''), 4000),
    notes: str(pick('notes', ''), 4000),
    snapshot: JSON.stringify(snapshot),
  };
}

function publicInvoice(row, { withSnapshot = false } = {}) {
  if (!row) return null;
  const snap = parseJson(row.snapshot, {});
  const items = parseJson(row.items, []);
  const out = {
    id: row.id,
    profile_id: row.profile_id,
    profile_name: snap.name || null,
    layout: snap.layout || 'classic',
    number: row.number,
    status: row.status,
    issue_date: row.issue_date,
    due_date: row.due_date,
    currency: row.currency,
    client_name: row.client_name,
    client_details: row.client_details,
    items,
    tax_rate: row.tax_rate,
    tax_label: row.tax_label,
    tax_sub: row.tax_sub,
    tax_text: row.tax_text,
    subtotal_cents: row.subtotal_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    terms: row.terms,
    notes: row.notes,
    pay_url: core.payUrl(snap.data && snap.data.pay_online, row.number, row.total_cents, row.currency),
    sent_at: row.sent_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (withSnapshot) out.snapshot = snap;
  return out;
}

async function invoiceRow(userId, id) {
  const row = await get('SELECT * FROM invoices WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) throw notFound('Invoice not found');
  return row;
}

async function bumpSeq(userId, profile, number) {
  if (!profile) return;
  const seq = core.seqFromNumber(profile.number_format, number);
  if (seq && seq >= profile.next_seq) {
    await run('UPDATE invoice_profiles SET next_seq = ? WHERE id = ? AND user_id = ?', [seq + 1, profile.id, userId]);
  }
}

async function resolveProfile(userId, profileId) {
  if (profileId === undefined || profileId === null || profileId === '') {
    const def = await get('SELECT * FROM invoice_profiles WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1', [userId]);
    if (!def) throw bad('Create an invoice template first');
    return def;
  }
  return profileRow(userId, parseInt(profileId, 10));
}

async function createInvoice(userId, body) {
  const b = isObj(body) ? body : {};
  const profile = await resolveProfile(userId, b.profile_id);
  const fields = await compose(userId, b, { snapshot: snapshotOf(profile), profile });
  const cols = Object.keys(fields);
  let r;
  try {
    r = await run(
      `INSERT INTO invoices (user_id, profile_id, status, ${cols.join(', ')}) VALUES (?, ?, 'draft', ${cols.map(() => '?').join(', ')})`,
      [userId, profile.id, ...cols.map((k) => fields[k])],
    );
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw bad(`Invoice number ${fields.number} is already used`);
    throw e;
  }
  await bumpSeq(userId, profile, fields.number);
  return publicInvoice(await invoiceRow(userId, r.id));
}

async function updateInvoice(userId, id, body) {
  const prev = await invoiceRow(userId, id);
  if (prev.status === 'void') throw bad('A void invoice cannot be edited');
  const b = isObj(body) ? body : {};
  let profile = null;
  let snapshot = parseJson(prev.snapshot, {});
  const wantProfile = b.profile_id !== undefined && b.profile_id !== null && String(b.profile_id) !== String(prev.profile_id);
  if (wantProfile || (prev.status === 'draft' && prev.profile_id)) {
    try {
      profile = await profileRow(userId, parseInt(wantProfile ? b.profile_id : prev.profile_id, 10));
      snapshot = snapshotOf(profile);
    } catch (e) {
      if (wantProfile) throw e;
    }
  }
  if (!snapshot.data) snapshot = { ...snapshot, layout: snapshot.layout || 'classic', data: mergeData('classic', {}) };
  const fields = await compose(userId, b, { prev, snapshot, profile: wantProfile ? profile : null });
  const cols = Object.keys(fields);
  try {
    await run(
      `UPDATE invoices SET ${cols.map((k) => `${k} = ?`).join(', ')}, profile_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
      [...cols.map((k) => fields[k]), profile ? profile.id : prev.profile_id, id, userId],
    );
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw bad(`Invoice number ${fields.number} is already used`);
    throw e;
  }
  if (profile) await bumpSeq(userId, profile, fields.number);
  return publicInvoice(await invoiceRow(userId, id));
}

async function setStatus(userId, id, status) {
  if (!STATUSES.includes(status)) throw bad('Unknown status');
  const prev = await invoiceRow(userId, id);
  const sets = ['status = ?'];
  const args = [status];
  if (status === 'sent' && !prev.sent_at) sets.push('sent_at = CURRENT_TIMESTAMP');
  if (status === 'paid') { sets.push('paid_at = CURRENT_TIMESTAMP'); if (!prev.sent_at) sets.push('sent_at = CURRENT_TIMESTAMP'); }
  if (status !== 'paid') sets.push('paid_at = NULL');
  await run(`UPDATE invoices SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [...args, id, userId]);
  return publicInvoice(await invoiceRow(userId, id));
}

async function duplicateInvoice(userId, id) {
  const prev = await invoiceRow(userId, id);
  let profile = null;
  if (prev.profile_id) profile = await get('SELECT * FROM invoice_profiles WHERE id = ? AND user_id = ?', [prev.profile_id, userId]);
  if (!profile) profile = await get('SELECT * FROM invoice_profiles WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1', [userId]);
  if (!profile) throw bad('Create an invoice template first');
  const body = {
    profile_id: profile.id,
    issue_date: core.today(),
    currency: prev.currency,
    client_name: prev.client_name,
    client_details: prev.client_details,
    items: parseJson(prev.items, []).map((it) => ({ description: it.description, detail: it.detail, note: it.note, qty: it.qty, price_cents: it.price_cents })),
    tax_rate: prev.tax_rate,
    tax_label: prev.tax_label,
    tax_sub: prev.tax_sub,
    tax_text: prev.tax_text,
    terms: prev.terms,
    notes: prev.notes,
  };
  return createInvoice(userId, body);
}

async function deleteInvoice(userId, id) {
  await invoiceRow(userId, id);
  await run('DELETE FROM invoices WHERE id = ? AND user_id = ?', [id, userId]);
  return { ok: true };
}

async function listInvoices(userId, { status, q } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (status && STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  if (q) {
    where.push('(number LIKE ? OR client_name LIKE ?)');
    const like = `%${String(q).slice(0, 100).replace(/[%_]/g, '')}%`;
    args.push(like, like);
  }
  const rows = await query(
    `SELECT id, user_id, profile_id, number, status, issue_date, due_date, currency, client_name, client_details, items,
            tax_rate, tax_label, tax_sub, tax_text, subtotal_cents, tax_cents, total_cents, terms, notes,
            json_object('name', json_extract(snapshot, '$.name'), 'layout', json_extract(snapshot, '$.layout'),
                        'data', json_object('pay_online', json_extract(snapshot, '$.data.pay_online'))) AS snapshot,
            sent_at, paid_at, created_at, updated_at
       FROM invoices WHERE ${where.join(' AND ')} ORDER BY issue_date DESC, id DESC LIMIT 500`,
    args,
  );
  const all = await query('SELECT status, currency, total_cents FROM invoices WHERE user_id = ?', [userId]);
  const totals = {};
  for (const r of all) {
    const t = totals[r.currency] || (totals[r.currency] = { outstanding_cents: 0, paid_cents: 0 });
    if (r.status === 'sent') t.outstanding_cents += r.total_cents;
    if (r.status === 'paid') t.paid_cents += r.total_cents;
  }
  return { invoices: rows.map((r) => publicInvoice(r)), totals };
}

async function getInvoice(userId, id) { return publicInvoice(await invoiceRow(userId, id)); }

// ---------- PDF ----------
async function footerFor(userId) {
  const code = await inviteCodeFor(userId);
  const ref = code ? `&fm_ref=invite-${code}` : '';
  return { url: `${baseUrl()}/?signup${ref}&utm_source=invoice&utm_medium=pdf&utm_campaign=invoice_footer` };
}

function viewOf(row, snap) {
  const data = snap.data || mergeData(snap.layout || 'classic', {});
  return {
    layout: snap.layout || 'classic',
    number: row.number,
    issue_date: row.issue_date,
    due_date: row.due_date,
    currency: row.currency,
    client_name: row.client_name,
    client_details: row.client_details,
    items: typeof row.items === 'string' ? parseJson(row.items, []) : row.items,
    subtotal_cents: row.subtotal_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    tax_rate: row.tax_rate,
    tax_label: row.tax_label,
    tax_sub: row.tax_sub,
    tax_text: row.tax_text,
    terms: row.terms,
    notes: row.notes,
    data,
    logo: snap.logo || null,
    signature: snap.signature || null,
    seller_name: (data.seller && data.seller.name) || '',
    pay_url: core.payUrl(data.pay_online, row.number, row.total_cents, row.currency),
  };
}

function fileName(view) {
  const clean = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const seller = clean(view.seller_name.split(/\s+/)[0]) || 'Invoice';
  return `Invoice_${seller}_${clean(view.number) || 'draft'}.pdf`;
}

async function renderPdf(view, userId) {
  const { renderInvoicePdf } = require('./pdf');
  return renderInvoicePdf(view, await footerFor(userId));
}

async function invoicePdf(userId, id) {
  const row = await invoiceRow(userId, id);
  const view = viewOf(row, parseJson(row.snapshot, {}));
  return { buffer: await renderPdf(view, userId), filename: fileName(view) };
}

// Unsaved preview of the editor state.
async function previewPdf(userId, body) {
  const b = isObj(body) ? body : {};
  const profile = await resolveProfile(userId, b.profile_id);
  const snap = snapshotOf(profile);
  const fields = await compose(userId, { ...b, number: b.number || undefined }, { snapshot: snap, profile }).catch((e) => {
    if (/already used/.test(e.message)) return compose(userId, { ...b, number: '' }, { snapshot: snap, profile });
    throw e;
  });
  if (b.number) fields.number = str(b.number, 40).trim();
  const view = viewOf(fields, snap);
  return { buffer: await renderPdf(view, userId), filename: fileName(view) };
}

module.exports = {
  InvoiceError,
  mergeData,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile, profileImage,
  shareProfile, insertShare, shareUrl, getShared, importShared, listPresets,
  nextNumber, createInvoice, updateInvoice, setStatus, duplicateInvoice, deleteInvoice,
  listInvoices, getInvoice, invoicePdf, previewPdf,
};
