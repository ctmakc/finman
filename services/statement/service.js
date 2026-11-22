// services/statement/service.js — Statement Agent tasks: read, store, show, fix balances, import.
//
// A task is one statement the agent read (statement_tasks). Nothing reaches the ledger until
// the person presses Import (or confirms the import_statement card in the assistant / MCP),
// and Import is refused unless the balance proof holds. Every task keeps how many model calls,
// tokens and milliseconds it took.
'use strict';

const { get, query, run } = require('../../db/database');
const Account = require('../../models/account');
const keys = require('../userAi/keys');
const platform = require('../../lib/ai/provider');
const csvImportService = require('../csvImportService');
const { categorizeByDescription } = require('../importCategorizer');
const importCommit = require('../importCommit');
const agent = require('./agent');
const proof = require('./proof');
const { plan30 } = require('./plan');

const { StatementError } = agent;
const PLATFORM_DAILY = () => parseInt(process.env.STATEMENT_PLATFORM_DAILY, 10) || 15;
const OK = new Set(['proven']);

const parse = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };

function platformReady() {
  try { return platform.isConfigured(process.env.STATEMENT_AI_PROVIDER || undefined) && ['google', 'gemini-oauth'].includes(platform.describe(process.env.STATEMENT_AI_PROVIDER || undefined).provider); } catch (_) { return false; }
}

// The person's own AI first; else the instance's AI (judges' sandbox, demo) with a daily cap.
async function aiFor(userId) {
  try {
    const { row, secret } = await keys.resolve(userId, null);
    return { source: 'user', provider: row.provider, key: secret, model: row.model, baseUrl: row.base_url, keyId: row.id };
  } catch (e) {
    if (e.code !== 'AI_NO_KEY') throw e;
  }
  if (!platformReady()) {
    throw new StatementError('STATEMENT_NO_AI', 'Connect your AI on the My AI page to read PDF and photo statements. CSV, OFX and QFX files import without AI.', 400);
  }
  const used = await get(
    "SELECT COUNT(*) AS n FROM statement_tasks WHERE user_id = ? AND ai_source = 'platform' AND created_at >= datetime('now', '-1 day')",
    [userId]
  );
  if (used && used.n >= PLATFORM_DAILY()) {
    throw new StatementError('STATEMENT_DAILY_LIMIT', `The shared AI reads ${PLATFORM_DAILY()} statements a day per person. Add your own AI key on the My AI page to read more.`, 429);
  }
  return { source: 'platform' };
}

// ---------------------------------------------------------------- Finman Vault
// An encrypted user's data never sits on the server, so the task cannot be stored here.
// With the person's explicit consent for this one file, the server reads it with the
// instance AI and returns the reading; nothing about the file or its rows is written on
// the server (only a 'statement_read' journal event with mode, pages and status, for the
// daily cap). The browser then stores the task inside the vault (createFromReading).
async function readForVault(userId, { buffer, mime, fileName }) {
  if (!platformReady()) {
    throw new StatementError('STATEMENT_NO_AI', 'Reading PDF and photo statements is not available right now. CSV, OFX and QFX files import without AI.', 503);
  }
  const used = await get(
    "SELECT COUNT(*) AS n FROM analytics_events WHERE user_id = ? AND event = 'statement_read' AND created_at >= datetime('now', '-1 day')",
    [userId]
  );
  if (used && used.n >= PLATFORM_DAILY()) {
    throw new StatementError('STATEMENT_DAILY_LIMIT', `Finman AI reads ${PLATFORM_DAILY()} statements a day per person. Try again tomorrow.`, 429);
  }
  const r = await agent.read({ buffer, mime, fileName, ai: { source: 'platform' } });
  return {
    file_name: String(fileName || '').slice(0, 200),
    meta: r.meta, rows: r.rows, proof: r.proof, attempts: r.attempts,
    mode: r.mode, pages: r.pages, sha256: r.sha256, ms: r.ms,
    usage: { calls: r.usage.calls, input: r.usage.input, output: r.usage.output, provider: r.usage.provider || null, model: r.usage.model || null },
  };
}

// Inside the vault engine: store a reading from readForVault as a task. The arithmetic is
// proved again here; a reading the server did not prove stays unproven, so a doctored
// reading can only make the result stricter, never pass a failed check.
async function createFromReading(userId, reading) {
  const rd = reading && typeof reading === 'object' ? reading : null;
  if (!rd || !Array.isArray(rd.rows) || !rd.rows.length || !rd.meta || !rd.proof) {
    throw new StatementError('STATEMENT_NO_ROWS', 'The reading has no rows');
  }
  if (rd.rows.length > 2000) throw new StatementError('STATEMENT_TOO_MANY', 'At most 2000 rows per statement');
  const m = agent.meta({
    statement_type: rd.meta.statement_type, institution: rd.meta.institution, account_last4: rd.meta.account_last4,
    currency: rd.meta.currency, period_start: rd.meta.period_start, period_end: rd.meta.period_end,
    opening_balance: Number.isInteger(rd.meta.opening_cents) ? rd.meta.opening_cents / 100 : null,
    closing_balance: Number.isInteger(rd.meta.closing_cents) ? rd.meta.closing_cents / 100 : null,
  });
  const rows = rd.rows.map((r) => ({ ...r }));
  const local = proof.prove({ opening_cents: m.opening_cents, closing_cents: m.closing_cents, rows, kind: m.statement_type });
  const serverProof = rd.proof;
  const p = serverProof.status === 'proven' && local.status === 'proven' ? { ...serverProof, ...local, notes: serverProof.notes || [] }
    : (serverProof.status === 'proven' ? local : serverProof);
  const ins = await run(
    `INSERT INTO statement_tasks (user_id, source, file_name, file_sha256, file_kind, mode, pages, ai_source, ai_provider, ai_model,
       status, statement_type, institution, account_last4, currency, period_start, period_end, opening_cents, closing_cents,
       rows_json, proof_json, attempts_json, model_calls, tokens_in, tokens_out, ms)
     VALUES (?, 'upload', ?, ?, ?, ?, ?, 'platform', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, String(rd.file_name || '').slice(0, 200), /^[a-f0-9]{64}$/.test(String(rd.sha256 || '')) ? rd.sha256 : null,
      rd.mode === 'photo' ? 'image' : 'pdf', ['text', 'pdf-vision', 'photo'].includes(rd.mode) ? rd.mode : 'text', parseInt(rd.pages, 10) || 1,
      rd.usage && rd.usage.provider ? String(rd.usage.provider).slice(0, 40) : null, rd.usage && rd.usage.model ? String(rd.usage.model).slice(0, 80) : null,
      p.status, m.statement_type, m.institution, m.account_last4, m.currency, m.period_start, m.period_end,
      Number.isInteger(p.opening_cents) ? p.opening_cents : m.opening_cents, m.closing_cents,
      JSON.stringify(rows), JSON.stringify(p), JSON.stringify(Array.isArray(rd.attempts) ? rd.attempts.slice(0, 5) : []),
      rd.usage ? parseInt(rd.usage.calls, 10) || 0 : 0, rd.usage ? parseInt(rd.usage.input, 10) || 0 : 0, rd.usage ? parseInt(rd.usage.output, 10) || 0 : 0,
      parseInt(rd.ms, 10) || 0]
  );
  return ins.id;
}

async function create(userId, { buffer, mime, fileName }) {
  const ai = await aiFor(userId);
  let r;
  try {
    r = await agent.read({ buffer, mime, fileName, ai });
    if (ai.keyId) await keys.markUsed(ai.keyId, null);
  } catch (e) {
    if (ai.keyId) await keys.markUsed(ai.keyId, e.message || 'error');
    throw e;
  }
  const m = r.meta;
  const ins = await run(
    `INSERT INTO statement_tasks (user_id, source, file_name, file_sha256, file_kind, mode, pages, ai_source, ai_provider, ai_model,
       status, statement_type, institution, account_last4, currency, period_start, period_end, opening_cents, closing_cents,
       rows_json, proof_json, attempts_json, model_calls, tokens_in, tokens_out, ms)
     VALUES (?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, String(fileName || '').slice(0, 200), r.sha256, r.mode === 'photo' ? 'image' : 'pdf', r.mode, r.pages,
      ai.source, r.usage.provider || ai.provider || null, r.usage.model || ai.model || null,
      r.proof.status, m.statement_type, m.institution, m.account_last4, m.currency, m.period_start, m.period_end,
      r.proof.opening_cents, m.closing_cents, JSON.stringify(r.rows), JSON.stringify(r.proof), JSON.stringify(r.attempts),
      r.usage.calls, r.usage.input, r.usage.output, r.ms]
  );
  return ins.id;
}

// Rows an outside AI already read (MCP / assistant): Finman only proves them, no model call.
async function createFromRows(userId, { statement_type: st, opening_balance: o, closing_balance: c, currency, rows, period_start: ps, period_end: pe, label }) {
  if (!Array.isArray(rows) || !rows.length) throw new StatementError('STATEMENT_NO_ROWS', 'rows must be a non-empty array');
  if (rows.length > 2000) throw new StatementError('STATEMENT_TOO_MANY', 'At most 2000 rows per statement');
  const norm = agent.normalizeRows(rows.map((r, i) => ({ ...r, page: r.page || 1, _i: i })));
  const kind = st === 'card' ? 'card' : 'bank';
  const m = { statement_type: kind, opening_cents: proof.toCents(o), closing_cents: proof.toCents(c) };
  const checked = agent.check(m, norm, null);
  const t0 = Date.now();
  const ins = await run(
    `INSERT INTO statement_tasks (user_id, source, file_name, mode, pages, ai_source, status, statement_type, currency, period_start, period_end,
       opening_cents, closing_cents, rows_json, proof_json, attempts_json, ms)
     VALUES (?, 'mcp', ?, 'rows', 1, 'outside', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    [userId, label ? String(label).slice(0, 200) : 'Rows from the assistant', checked.proof.status, kind,
      currency && /^[A-Za-z]{3}$/.test(String(currency)) ? String(currency).toUpperCase() : null,
      agent.normalizeRows([{ date: ps }])[0].date, agent.normalizeRows([{ date: pe }])[0].date,
      checked.proof.opening_cents, m.closing_cents, JSON.stringify(checked.rows), JSON.stringify(checked.proof), Date.now() - t0]
  );
  return ins.id;
}

async function taskFor(userId, id) {
  const t = await get('SELECT * FROM statement_tasks WHERE id = ? AND user_id = ?', [parseInt(id, 10) || 0, userId]);
  if (!t) throw new StatementError('STATEMENT_NOT_FOUND', 'Statement not found', 404);
  return t;
}

function rowsOf(t) {
  return parse(t.rows_json, []).map((r, i) => ({
    index: i,
    date: r.date,
    date_raw: r.date_raw || null,
    description: r.description,
    cents: r.cents,
    amount: Number.isInteger(r.cents) ? r.cents / 100 : null,
    balance_cents: r.balance_cents,
    page: r.page,
    unclear: !!r.unclear,
    derived: !!r.derived,
    ungrounded: !!r.ungrounded,
    category: Number.isInteger(r.cents) ? categorizeByDescription(r.description) || 'Other' : null,
  }));
}

async function view(userId, id, { accountId } = {}) {
  const t = await taskFor(userId, id);
  const rows = rowsOf(t);
  const p = parse(t.proof_json, {});
  let account = null;
  if (accountId) {
    account = await Account.findById(accountId, userId);
    if (!account) throw new StatementError('ACCOUNT_NOT_FOUND', 'Account not found', 404);
    const existing = await importCommit.loadExistingFingerprints(account.id, userId);
    for (const r of rows) {
      if (!r.date || !Number.isInteger(r.cents)) continue;
      const fp = csvImportService.fingerprintOf(r.date, r.cents / 100, r.description);
      if (importCommit.consumeExisting(existing, fp)) r.duplicate = 'existing';
    }
  }
  const badDates = rows.filter((r) => !r.date).length;
  const dup = rows.filter((r) => r.duplicate).length;
  const currencyMismatch = !!(account && t.currency && account.currency && account.currency !== t.currency);
  return {
    id: t.id,
    source: t.source,
    file_name: t.file_name,
    mode: t.mode,
    pages: t.pages,
    status: t.status,
    statement_type: t.statement_type,
    institution: t.institution,
    account_last4: t.account_last4,
    currency: t.currency,
    period: { start: t.period_start, end: t.period_end },
    opening_cents: t.opening_cents,
    closing_cents: t.closing_cents,
    balances_typed: !!t.balances_typed,
    proof: p,
    attempts: parse(t.attempts_json, []),
    rows,
    counts: { rows: rows.length, duplicates: dup, new: rows.length - dup, bad_dates: badDates },
    usage: { ai: t.ai_source, provider: t.ai_provider, model: t.ai_model, calls: t.model_calls, tokens_in: t.tokens_in, tokens_out: t.tokens_out, ms: t.ms },
    plan: OK.has(t.status) ? plan30(rows, { closing_cents: t.closing_cents, period_start: t.period_start, period_end: t.period_end, statement_type: t.statement_type, currency: t.currency }) : null,
    account: account ? { id: account.id, name: account.name, currency: account.currency } : null,
    currency_mismatch: currencyMismatch,
    can_import: OK.has(t.status) && !t.committed_at && badDates === 0,
    committed: t.committed_at ? { at: t.committed_at, account_id: t.account_id, inserted: t.inserted, skipped: t.skipped } : null,
    created_at: t.created_at,
  };
}

async function list(userId) {
  const rows = await query(
    `SELECT id, source, file_name, status, statement_type, institution, account_last4, currency, period_start, period_end,
            opening_cents, closing_cents, committed_at, inserted, created_at, proof_json
       FROM statement_tasks WHERE user_id = ? ORDER BY id DESC LIMIT 30`,
    [userId]
  );
  return rows.map((r) => {
    const p = parse(r.proof_json, {});
    return {
      id: r.id, source: r.source, file_name: r.file_name, status: r.status, statement_type: r.statement_type,
      institution: r.institution, account_last4: r.account_last4, currency: r.currency,
      period: { start: r.period_start, end: r.period_end }, proof_line: p.line || null,
      rows: (p.rows_checked || 0) + ((p.unclear_rows || []).length), committed: !!r.committed_at, inserted: r.inserted, created_at: r.created_at,
    };
  });
}

// The person types the opening and/or closing balance the statement does not print.
async function setBalances(userId, id, { opening_balance: o, closing_balance: c }) {
  const t = await taskFor(userId, id);
  if (t.committed_at) throw new StatementError('STATEMENT_DONE', 'This statement is already imported', 409);
  const oc = o === undefined || o === null || o === '' ? null : proof.toCents(o);
  const cc = c === undefined || c === null || c === '' ? null : proof.toCents(c);
  if ((o !== undefined && o !== null && o !== '' && oc === null) || (c !== undefined && c !== null && c !== '' && cc === null)) {
    throw new StatementError('STATEMENT_BAD_AMOUNT', 'Type the balance as a number, e.g. 1234.56');
  }
  if (oc === null && cc === null) throw new StatementError('STATEMENT_BAD_AMOUNT', 'Type the opening or the closing balance');
  const rows = parse(t.rows_json, []);
  const m = { statement_type: t.statement_type, opening_cents: t.opening_cents, closing_cents: t.closing_cents };
  const r = agent.reprove({ meta: m, rows, opening_cents: oc, closing_cents: cc });
  r.proof.typed = { opening: oc !== null, closing: cc !== null };
  if (r.proof.status === 'proven') r.proof.line += ' (balance typed by you)';
  await run(
    'UPDATE statement_tasks SET status = ?, opening_cents = ?, closing_cents = ?, balances_typed = 1, proof_json = ? WHERE id = ?',
    [r.proof.status, r.proof.opening_cents, r.meta.closing_cents, JSON.stringify(r.proof), t.id]
  );
  return t.id;
}

// Import the proven rows into one account. categories: { [rowIndex]: 'Groceries' } (optional edits).
async function commit(userId, id, { accountId, categories, allowCurrencyMismatch } = {}) {
  const t = await taskFor(userId, id);
  if (t.committed_at) throw new StatementError('STATEMENT_DONE', 'This statement is already imported', 409);
  if (!OK.has(t.status)) {
    const p = parse(t.proof_json, {});
    throw new StatementError('STATEMENT_NOT_PROVEN', `Not imported: the balance check did not pass. ${p.line || ''}`.trim(), 409);
  }
  if (!accountId) throw new StatementError('ACCOUNT_REQUIRED', 'Choose the account to import into');
  const account = await Account.findById(accountId, userId);
  if (!account) throw new StatementError('ACCOUNT_NOT_FOUND', 'Account not found', 404);
  if (t.currency && account.currency && t.currency !== account.currency && !allowCurrencyMismatch) {
    throw new StatementError('STATEMENT_CURRENCY', `The statement is in ${t.currency} and the account "${account.name}" is in ${account.currency}. Choose a ${t.currency} account.`, 409);
  }
  const rows = rowsOf(t);
  if (rows.some((r) => !r.date)) throw new StatementError('STATEMENT_BAD_DATES', 'Some rows have no readable date; nothing is written', 409);
  const cats = categories && typeof categories === 'object' ? categories : {};
  const { prepared, errors } = importCommit.prepareRows(rows.map((r) => ({
    date: r.date, description: r.description, amount: r.cents / 100,
    category: typeof cats[r.index] === 'string' && cats[r.index].trim() ? cats[r.index] : r.category,
  })));
  if (errors.length) throw new StatementError('STATEMENT_BAD_ROWS', errors[0].message, 409);
  // Claim the task first so a double click cannot import twice.
  const claim = await run("UPDATE statement_tasks SET committed_at = CURRENT_TIMESTAMP, account_id = ? WHERE id = ? AND committed_at IS NULL", [account.id, t.id]);
  if (!claim.changes) throw new StatementError('STATEMENT_DONE', 'This statement is already imported', 409);
  let out;
  try {
    out = await importCommit.commitPrepared(account, userId, prepared, { skipDuplicates: true, updateBalance: true });
  } catch (e) {
    await run('UPDATE statement_tasks SET committed_at = NULL, account_id = NULL WHERE id = ?', [t.id]);
    throw e;
  }
  await run('UPDATE statement_tasks SET inserted = ?, skipped = ? WHERE id = ?', [out.inserted, out.skipped, t.id]);
  const refreshed = await Account.findById(account.id, userId);
  return { id: t.id, account_id: account.id, account: account.name, inserted: out.inserted, skipped: out.skipped, balance_delta: out.delta, new_balance: refreshed ? refreshed.balance : null };
}

async function remove(userId, id) {
  const t = await taskFor(userId, id);
  await run('DELETE FROM statement_tasks WHERE id = ?', [t.id]);
  return { deleted: true };
}

module.exports = { create, createFromRows, readForVault, createFromReading, view, list, setBalances, commit, remove, aiFor, platformReady, StatementError };
