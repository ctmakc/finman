// services/csvImportService.js — generic CSV statement mapper + bank presets.
//
// Pipeline:  text -> detectDelimiter -> parseCsv -> detectHeader -> detectPreset
//            -> resolveMapping -> normalizeRows -> fingerprint/dedupe -> preview
//
// A preview never writes anything. routes/bank-api.js turns a preview into
// transactions inside db.transaction() on /import/commit.
//
// Normalized transaction shape (shared with ofxImportService):
//   { date:'YYYY-MM-DD', description, amount (signed, 2 dp), type:'income'|'expense',
//     category, currency|null, externalId|null, fingerprint, raw }
//
// Presets encode real export layouts. `verified: true` means the header was
// confirmed against a real export or an independent parser of that bank's
// file; `verified: false` means the layout comes from secondary sources and
// the user must check the preview table before committing.

const fs = require('fs');
const crypto = require('crypto');
const money = require('../lib/money');
const { categorizeByMcc, categorizeByDescription } = require('./importCategorizer');

// --------------------------------------------------------------------------
// Low-level CSV
// --------------------------------------------------------------------------

const DELIMITERS = [',', ';', '\t', '|'];

function stripBom(text) {
  return text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Count delimiter occurrences outside quotes on one line.
function countOutsideQuotes(line, ch) {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ch && !inQ) n++;
  }
  return n;
}

// Pick the delimiter whose count is highest and most consistent across lines.
function detectDelimiter(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 20);
  if (lines.length === 0) return ',';
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const nonZero = counts.filter((c) => c > 0).length;
    if (nonZero === 0) continue;
    const mode = counts
      .slice()
      .sort((a, b) => counts.filter((v) => v === b).length - counts.filter((v) => v === a).length)[0];
    const consistency = counts.filter((c) => c === mode).length / counts.length;
    const score = nonZero * 10 + consistency * 5 + Math.min(mode, 10);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

// RFC-4180-ish parser: quotes, doubled quotes, newlines inside quotes, CRLF.
function parseCsv(text, delimiter) {
  const src = stripBom(String(text || ''));
  const d = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQ = true;
    } else if (c === d) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row.map((v) => v.trim()));
      row = [];
    } else {
      cell += c;
    }
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row.map((v) => v.trim()));
  return rows;
}

// --------------------------------------------------------------------------
// Values: dates and amounts
// --------------------------------------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100)) return null;
  // Real calendar check: "31/02/2026" must not become "2026-02-31".
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Parse a date cell into YYYY-MM-DD. `order` disambiguates xx/xx/yyyy:
// 'MDY' (Canada/US), 'DMY' (Europe/Ukraine), 'YMD', or 'auto' (unknown -> MDY).
function parseDate(input, order = 'auto') {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s || s.length > 64) return null; // no date cell is this long
  // Drop a time part: "2026-10-09 14:22:01", "09.10.2026 14:22", "2026-10-09T14:22:01Z"
  s = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i, '').trim();

  let m;
  // YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    return validYmd(+m[1], +m[2], +m[3]);
  }
  // YYYYMMDD (BMO "Date Posted", OFX)
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    return validYmd(+m[1], +m[2], +m[3]);
  }
  // DD.MM.YYYY (dot form is day-first everywhere it is used)
  if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) {
    return validYmd(+m[3], +m[2], +m[1]);
  }
  // xx/xx/yyyy or xx-xx-yyyy — ambiguous
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) {
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    let ord = order;
    if (ord === 'auto' || ord === 'YMD') {
      if (a > 12 && b <= 12) ord = 'DMY';
      else if (b > 12 && a <= 12) ord = 'MDY';
      else ord = 'MDY';
    }
    return ord === 'DMY' ? validYmd(y, b, a) : validYmd(y, a, b);
  }
  // xx/xx/yy two-digit year
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/))) {
    const a = +m[1];
    const b = +m[2];
    const y = 2000 + +m[3];
    let ord = order;
    if (ord === 'auto' || ord === 'YMD') ord = a > 12 ? 'DMY' : 'MDY';
    return ord === 'DMY' ? validYmd(y, b, a) : validYmd(y, a, b);
  }
  // "Jan 5, 2026", "5 Jan 2026", "January 05 2026", "05-Jan-2026"
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? validYmd(+m[3], mon, +m[2]) : null;
  }
  if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-,]+(\d{4})$/))) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mon ? validYmd(+m[3], mon, +m[1]) : null;
  }
  return null;
}

// Infer day/month order from a column of xx/xx/yyyy values.
function inferDateOrder(values) {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = String(v || '').trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
    if (!m) continue;
    if (+m[1] > 12) dmy++;
    if (+m[2] > 12) mdy++;
  }
  if (dmy && !mdy) return 'DMY';
  if (mdy && !dmy) return 'MDY';
  return null;
}

// Parse "1,234.56", "1 234,56", "1.234,56", "(45.00)", "-$45.00", "45.00 CR", "45.00-".
function parseAmount(input) {
  if (input == null) return null;
  let s = String(input).replace(/[  \s]/g, '').trim();
  if (!s) return null;
  let negative = false;
  let positive = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/-$/.test(s)) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (/(CR|C)$/i.test(s) && !/[A-Za-z]{3}$/.test(s)) {
    positive = true;
    s = s.replace(/(CR|C)$/i, '');
  } else if (/(DR|D)$/i.test(s) && !/[A-Za-z]{3}$/.test(s)) {
    negative = true;
    s = s.replace(/(DR|D)$/i, '');
  }
  // Strip currency symbols/codes and anything that is not digit, sign, comma, dot.
  s = s.replace(/[^\d,.\-+]/g, '');
  if (!s || !/\d/.test(s)) return null;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s.includes('-')) return null; // sign in the middle -> not a number

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // The last separator is the decimal one.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = s.split(',');
    // "1,234" or "1,234,567" -> thousands; "12,5" / "12,50" -> decimal comma.
    if (parts.length === 2 && parts[1].length !== 3) {
      s = parts.join('.');
    } else if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) {
      // "1,234" is almost always thousands in bank exports.
      s = parts.join('');
    } else {
      s = parts.join('');
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) s = parts.join(''); // "1.234.567" thousands dots
    // "1.234" stays a decimal: exports with dot-thousands also carry a comma decimal.
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  let v = Math.abs(n);
  if (negative && !positive) v = -v;
  return money.round(v);
}

function looksLikeDate(s) {
  return parseDate(s) !== null;
}

// Longest cell that can still be a money amount ("-1 234 567 890,12 USD" is ~25).
// Anything longer is text; the cap also bounds the regex work on hostile cells.
const MAX_NUMBER_CELL = 64;

// Digit groups are separated by single whitespace runs only, so the pattern has
// no overlapping quantifiers (a "1" + 40k spaces + "!" cell used to take ~9 s).
const NUMBER_CELL = /^[(+-]?\s*(?:[$€£₴A-Z]{1,3}\s*)?[\d.,]+(?:\s+[\d.,]+)*\s*(?:[A-Z]{1,3})?\)?-?$/i;

function looksLikeNumber(s) {
  const t = String(s || '').trim();
  if (!t || t.length > MAX_NUMBER_CELL) return false;
  if (looksLikeDate(t)) return false;
  return NUMBER_CELL.test(t) && parseAmount(t) !== null;
}

// Some exports open with a free-text preamble ("Following data is valid as of
// …:", account titles, blank spacer lines). Drop leading rows that are much
// narrower than the dominant row width.
function skipPreamble(rows) {
  if (rows.length < 2) return rows;
  const counts = rows.map((r) => r.length);
  const freq = new Map();
  for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
  let modeCount = counts[0];
  let best = 0;
  for (const [c, n] of freq) {
    if (n > best || (n === best && c > modeCount)) {
      best = n;
      modeCount = c;
    }
  }
  let start = 0;
  while (start < rows.length - 1 && rows[start].length < modeCount && rows[start].length <= 2) start++;
  return start ? rows.slice(start) : rows;
}

// Header row = no date / money cells, at least one word cell.
function detectHeader(rows) {
  if (!rows.length) return false;
  const first = rows[0];
  const nonEmpty = first.filter((c) => c !== '');
  if (nonEmpty.length === 0) return false;
  const dateOrNum = nonEmpty.filter((c) => looksLikeDate(c) || looksLikeNumber(c)).length;
  const wordy = nonEmpty.filter((c) => /[A-Za-zА-Яа-яЁёІіЇїЄєҐґ]/.test(c)).length;
  if (dateOrNum > 0) return false;
  if (wordy === 0) return false;
  // If a second row exists, it should look different (contain a date or a number).
  if (rows[1]) {
    const second = rows[1].filter((c) => c !== '');
    const secondDataish = second.filter((c) => looksLikeDate(c) || looksLikeNumber(c)).length;
    return secondDataish > 0 || second.length !== nonEmpty.length;
  }
  return true;
}

// --------------------------------------------------------------------------
// Presets
// --------------------------------------------------------------------------

const norm = (h) => String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();

// headersInclude(headers, required): every required token appears in some header.
function headersInclude(headers, required) {
  const hs = headers.map(norm);
  return required.every((req) => hs.some((h) => h === norm(req) || h.includes(norm(req))));
}

const DEBIT_WORDS = ['debit', 'dr', 'withdrawal', 'withdrawals', 'payment', 'purchase', 'pos', 'card_payment', 'fee', 'atm', 'transfer_out'];
const CREDIT_WORDS = ['credit', 'cr', 'deposit', 'deposits', 'refund', 'topup', 'top-up', 'transfer_in', 'interest'];

const PRESETS = {
  rbc: {
    id: 'rbc',
    name: 'RBC Royal Bank (CSV)',
    bankId: 'rbc',
    verified: false,
    hasHeader: true,
    dateOrder: 'MDY',
    signature: (ctx) => ctx.hasHeader && headersInclude(ctx.headers, ['account type', 'transaction date', 'description 1', 'cad$']),
    mapping: {
      date: 'Transaction Date',
      description: ['Description 1', 'Description 2'],
      amount: 'CAD$',
      amountAlt: 'USD$',
      accountType: 'Account Type',
      accountNumber: 'Account Number'
    },
    notes: 'Signed amount: negative = money out. USD accounts use the USD$ column.'
  },
  td: {
    id: 'td',
    name: 'TD Canada Trust (CSV, no header)',
    bankId: 'td_canada',
    verified: false,
    hasHeader: false,
    dateOrder: 'MDY',
    signature: (ctx) =>
      !ctx.hasHeader &&
      ctx.columnCount === 5 &&
      ctx.colStats[0].dateShare > 0.8 &&
      ctx.colStats[2].numShare + ctx.colStats[3].numShare > 0.8 &&
      ctx.colStats[2].exclusiveWith3 &&
      ctx.colStats[4].numShare > 0.8 &&
      ctx.colStats[0].ymdShare < 0.5,
    mapping: { date: 0, description: 1, debit: 2, credit: 3, balance: 4 },
    notes: 'Columns: date, description, money out, money in, running balance.'
  },
  cibc: {
    id: 'cibc',
    name: 'CIBC (CSV, no header)',
    bankId: 'cibc',
    verified: false,
    hasHeader: false,
    dateOrder: 'YMD',
    signature: (ctx) =>
      !ctx.hasHeader &&
      (ctx.columnCount === 4 || ctx.columnCount === 5) &&
      ctx.colStats[0].dateShare > 0.8 &&
      ctx.colStats[0].ymdShare > 0.8 &&
      ctx.colStats[2].exclusiveWith3 &&
      (ctx.columnCount === 4 || ctx.colStats[4].numShare < 0.5 || ctx.colStats[4].longDigits),
    mapping: { date: 0, description: 1, debit: 2, credit: 3 },
    notes: 'Columns: date (YYYY-MM-DD), description, debit, credit[, card number].'
  },
  scotiabank: {
    id: 'scotiabank',
    name: 'Scotiabank (CSV, no header)',
    bankId: 'scotiabank',
    verified: false,
    hasHeader: false,
    dateOrder: 'MDY',
    signature: (ctx) =>
      !ctx.hasHeader &&
      ctx.columnCount === 5 &&
      ctx.colStats[0].dateShare > 0.8 &&
      ctx.colStats[1].numShare > 0.8 &&
      ctx.colStats[2].starShare > 0.8,
    mapping: { date: 0, amount: 1, description: 4 },
    notes: 'Columns: date, signed amount, "*", empty, description.'
  },
  bmo: {
    id: 'bmo',
    name: 'BMO Bank of Montreal (CSV)',
    bankId: 'bmo',
    verified: false,
    hasHeader: true,
    dateOrder: 'YMD',
    signature: (ctx) => ctx.hasHeader && headersInclude(ctx.headers, ['first bank card', 'transaction type', 'date posted', 'transaction amount']),
    mapping: { date: 'Date Posted', amount: 'Transaction Amount', description: 'Description', typeColumn: 'Transaction Type' },
    notes: 'Date Posted is YYYYMMDD; Transaction Type DEBIT/CREDIT fixes the sign.'
  },
  tangerine: {
    id: 'tangerine',
    name: 'Tangerine (CSV)',
    bankId: 'tangerine',
    verified: false,
    hasHeader: true,
    dateOrder: 'MDY',
    signature: (ctx) => ctx.hasHeader && headersInclude(ctx.headers, ['date', 'transaction', 'name', 'memo', 'amount']),
    mapping: { date: 'Date', description: ['Name', 'Memo'], amount: 'Amount', typeColumn: 'Transaction' },
    notes: 'Transaction column is DEBIT/CREDIT (or OTHER); amount is signed.'
  },
  wealthsimple: {
    id: 'wealthsimple',
    name: 'Wealthsimple Cash (CSV)',
    bankId: 'wealthsimple_cash',
    verified: false,
    hasHeader: true,
    dateOrder: 'YMD',
    signature: (ctx) => ctx.hasHeader && headersInclude(ctx.headers, ['date', 'transaction', 'description', 'amount', 'balance']) && !headersInclude(ctx.headers, ['memo']),
    mapping: { date: 'date', description: ['description', 'transaction'], amount: 'amount', balance: 'balance', currency: 'currency' },
    notes: 'Activity export: date, transaction, description, amount, balance, currency.'
  },
  eqbank: {
    id: 'eqbank',
    name: 'EQ Bank (CSV)',
    bankId: 'eq_bank',
    verified: false,
    hasHeader: true,
    dateOrder: 'MDY',
    signature: (ctx) => ctx.hasHeader && headersInclude(ctx.headers, ['date', 'description', 'amount', 'balance']) && ctx.headers.length <= 5 && !headersInclude(ctx.headers, ['transaction']),
    mapping: { date: 'date', description: 'description', amount: 'amount', balance: 'balance' },
    notes: 'Columns: date, description, signed amount, balance.'
  },
  monobank: {
    id: 'monobank',
    name: 'Monobank statement (CSV)',
    bankId: 'monobank',
    verified: false,
    hasHeader: true,
    dateOrder: 'DMY',
    signature: (ctx) =>
      ctx.hasHeader &&
      (headersInclude(ctx.headers, ['дата i час операції', 'деталі операції', 'mcc']) ||
        headersInclude(ctx.headers, ['дата і час операції', 'деталі операції', 'mcc']) ||
        headersInclude(ctx.headers, ['date and time', 'description', 'mcc', 'card currency amount'])),
    mapping: {
      date: ['Дата i час операції', 'Дата і час операції', 'Date and time'],
      description: ['Деталі операції', 'Description'],
      mcc: 'MCC',
      amount: ['Сума в валюті картки', 'Card currency amount'],
      currencyFromHeader: ['Сума в валюті картки', 'Card currency amount']
    },
    notes: 'Signed amount in the card currency; MCC drives the category.'
  },
  revolut: {
    id: 'revolut',
    name: 'Revolut (CSV)',
    bankId: 'revolut',
    verified: true,
    hasHeader: true,
    dateOrder: 'YMD',
    signature: (ctx) => ctx.hasHeader && headersInclude(ctx.headers, ['type', 'product', 'started date', 'completed date', 'description', 'amount', 'fee', 'currency', 'state']),
    mapping: {
      date: ['Completed Date', 'Started Date'],
      description: 'Description',
      amount: 'Amount',
      fee: 'Fee',
      currency: 'Currency',
      stateColumn: 'State',
      typeHint: 'Type'
    },
    skipRow: (cells, idx) => {
      const state = idx.stateColumn != null ? norm(cells[idx.stateColumn]) : 'completed';
      return state && state !== 'completed' ? `state ${state}` : null;
    },
    notes: 'Only COMPLETED rows are imported; Fee is subtracted from Amount.'
  },
  wise: {
    id: 'wise',
    name: 'Wise (CSV)',
    bankId: 'wise',
    verified: true,
    hasHeader: true,
    dateOrder: 'DMY',
    signature: (ctx) => ctx.hasHeader && (headersInclude(ctx.headers, ['transferwise id', 'date', 'amount', 'currency', 'description']) || headersInclude(ctx.headers, ['wise id', 'date', 'amount', 'currency', 'description'])),
    mapping: {
      externalId: ['TransferWise ID', 'Wise ID', 'ID'],
      date: 'Date',
      amount: 'Amount',
      currency: 'Currency',
      description: ['Description', 'Payment Reference'],
      balance: 'Running Balance'
    },
    notes: 'Dates are DD-MM-YYYY; amount is signed and already net of fees.'
  }
};

const PRESET_ORDER = ['revolut', 'wise', 'monobank', 'rbc', 'bmo', 'tangerine', 'wealthsimple', 'eqbank', 'td', 'cibc', 'scotiabank'];

function listPresets() {
  return PRESET_ORDER.map((id) => {
    const p = PRESETS[id];
    return { id: p.id, name: p.name, bankId: p.bankId, verified: p.verified, hasHeader: p.hasHeader, dateOrder: p.dateOrder, notes: p.notes || null };
  });
}

// Per-column statistics used by headerless signatures and auto-mapping.
function columnStats(dataRows) {
  const sample = dataRows.slice(0, 50);
  const columnCount = Math.max(0, ...sample.map((r) => r.length));
  const stats = [];
  for (let c = 0; c < columnCount; c++) {
    const vals = sample.map((r) => r[c] ?? '');
    const filled = vals.filter((v) => v !== '');
    const n = Math.max(1, filled.length);
    const dateShare = filled.filter(looksLikeDate).length / n;
    const ymdShare = filled.filter((v) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(v)).length / n;
    const numShare = filled.filter(looksLikeNumber).length / n;
    const starShare = filled.filter((v) => v === '*').length / n;
    const longDigits = filled.length > 0 && filled.every((v) => /^\d{8,}$/.test(v.replace(/\s/g, '')));
    const avgLen = filled.reduce((a, v) => a + v.length, 0) / n;
    const fillShare = filled.length / Math.max(1, sample.length);
    const hasNeg = filled.some((v) => parseAmount(v) != null && parseAmount(v) < 0);
    stats.push({ dateShare, ymdShare, numShare, starShare, longDigits, avgLen, fillShare, hasNeg, filled: filled.length });
  }
  for (let c = 0; c < columnCount; c++) {
    const next = c + 1;
    stats[c].exclusiveWith3 = false;
    if (next < columnCount) {
      const pairs = sample.map((r) => [(r[c] ?? '') !== '', (r[next] ?? '') !== '']);
      const exclusive = pairs.every(([a, b]) => a !== b || (!a && !b));
      const anyFilled = pairs.some(([a, b]) => a || b);
      stats[c].exclusiveWith3 = exclusive && anyFilled;
    }
  }
  return { columnCount, stats };
}

function detectPreset(ctx) {
  for (const id of PRESET_ORDER) {
    const p = PRESETS[id];
    try {
      if (p.signature(ctx)) return p;
    } catch (_) {
      /* a signature that throws just does not match */
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Mapping resolution
// --------------------------------------------------------------------------

const ROLE_KEYS = ['date', 'description', 'amount', 'amountAlt', 'debit', 'credit', 'fee', 'balance', 'category', 'currency', 'externalId', 'mcc', 'typeColumn', 'stateColumn', 'typeHint', 'accountType', 'accountNumber'];

// Turn header names / indices into column indices. Arrays of names mean
// "first that exists" for scalar roles and "all that exist" for description.
function resolveMapping(mapping, headers, columnCount) {
  const hs = (headers || []).map(norm);
  const findIdx = (ref) => {
    if (ref == null) return null;
    if (typeof ref === 'number') return ref < columnCount ? ref : null;
    const target = norm(ref);
    let i = hs.indexOf(target);
    if (i === -1) i = hs.findIndex((h) => h.includes(target));
    return i === -1 ? null : i;
  };
  const resolved = {};
  for (const role of ROLE_KEYS) {
    const ref = mapping[role];
    if (ref == null) continue;
    if (Array.isArray(ref)) {
      if (role === 'description') {
        const idxs = ref.map(findIdx).filter((i) => i != null);
        resolved.description = idxs.length ? idxs : null;
      } else {
        const first = ref.map(findIdx).find((i) => i != null);
        resolved[role] = first == null ? null : first;
      }
    } else {
      const i = findIdx(ref);
      resolved[role] = role === 'description' ? (i == null ? null : [i]) : i;
    }
  }
  if (Array.isArray(mapping.description) === false && typeof mapping.description === 'number') {
    resolved.description = [mapping.description];
  }
  // Currency from the amount header, e.g. "Сума в валюті картки (UAH)".
  if (mapping.currencyFromHeader && resolved.amount != null && headers && headers[resolved.amount]) {
    const m = String(headers[resolved.amount]).match(/\(([A-Z]{3})\)/);
    if (m) resolved.fixedCurrency = m[1];
  }
  if (mapping.fixedCurrency) resolved.fixedCurrency = mapping.fixedCurrency;
  resolved.sign = mapping.sign || 'signed';
  return resolved;
}

const HEADER_HINTS = {
  date: ['transaction date', 'posted date', 'post date', 'date posted', 'completed date', 'trans date', 'booking date', 'value date', 'date', 'дата', 'datum'],
  description: ['description', 'details', 'memo', 'narrative', 'particulars', 'payee', 'merchant', 'name', 'reference', 'деталі', 'описание', 'опис', 'назначение', 'призначення'],
  amount: ['amount', 'сумма', 'сума', 'betrag', 'montant', 'value'],
  debit: ['debit', 'withdrawal', 'money out', 'paid out', 'outflow', 'расход', 'витрат', 'списання', 'списание'],
  credit: ['credit', 'deposit', 'money in', 'paid in', 'inflow', 'приход', 'надходж', 'зарахування', 'зачисление'],
  balance: ['balance', 'running balance', 'баланс', 'залишок', 'остаток'],
  category: ['category', 'категор'],
  currency: ['currency', 'валюта', 'ccy'],
  externalId: ['transaction id', 'reference number', 'ref', 'id'],
  mcc: ['mcc']
};

// Generic mapping from headers and content.
function autoMapping(headers, dataRows, hasHeader) {
  const { columnCount, stats } = columnStats(dataRows);
  const mapping = {};
  const used = new Set();
  const hs = (headers || []).map(norm);

  if (hasHeader) {
    const pick = (role, exact = false) => {
      for (const hint of HEADER_HINTS[role]) {
        const h = norm(hint);
        let i = hs.findIndex((x, idx) => !used.has(idx) && (x === h || (!exact && x.includes(h))));
        if (i !== -1) {
          // "amount" must not grab "fee amount" / "transaction amount" when a plain amount exists.
          if (role === 'amount' && hs.includes('amount')) i = hs.indexOf('amount');
          if (role === 'description' && h === 'name' && hs.some((x) => x.includes('description'))) continue;
          if (role === 'externalId' && hs[i].includes('card')) continue;
          used.add(i);
          return i;
        }
      }
      return null;
    };
    mapping.date = pick('date');
    mapping.debit = pick('debit');
    mapping.credit = pick('credit');
    mapping.amount = pick('amount');
    if (mapping.amount != null && hs[mapping.amount].includes('fee')) {
      used.delete(mapping.amount);
      mapping.amount = null;
    }
    mapping.balance = pick('balance');
    mapping.currency = pick('currency');
    mapping.category = pick('category');
    mapping.mcc = pick('mcc');
    const d1 = pick('description');
    const descIdx = [];
    if (d1 != null) descIdx.push(d1);
    // Also append "Description 2"/"Memo"-like companions.
    hs.forEach((x, idx) => {
      if (!used.has(idx) && (x.startsWith('description') || x === 'memo' || x === 'payment reference' || x === 'details')) {
        descIdx.push(idx);
        used.add(idx);
      }
    });
    if (descIdx.length) mapping.description = descIdx;
  }

  // Content-based fallbacks (headerless, or header words we did not recognise).
  const free = (i) => !used.has(i);
  if (mapping.date == null) {
    let best = null;
    for (let c = 0; c < columnCount; c++) {
      if (free(c) && stats[c].dateShare > 0.7 && (best == null || stats[c].dateShare > stats[best].dateShare)) best = c;
    }
    if (best != null) {
      mapping.date = best;
      used.add(best);
    }
  }
  if (mapping.amount == null && mapping.debit == null && mapping.credit == null) {
    const numeric = [];
    for (let c = 0; c < columnCount; c++) if (free(c) && stats[c].numShare > 0.7) numeric.push(c);
    if (numeric.length === 1) {
      mapping.amount = numeric[0];
    } else if (numeric.length >= 2) {
      const [a, b] = numeric;
      if (stats[a].exclusiveWith3 && b === a + 1) {
        mapping.debit = a;
        mapping.credit = b;
        if (numeric[2] != null) mapping.balance = numeric[2];
      } else {
        // Signed amount first; the last fully-filled numeric column is a running balance.
        const signed = numeric.find((c) => stats[c].hasNeg);
        mapping.amount = signed != null ? signed : numeric[0];
        const last = numeric[numeric.length - 1];
        if (last !== mapping.amount && stats[last].fillShare > 0.9) mapping.balance = last;
      }
    }
    [mapping.amount, mapping.debit, mapping.credit, mapping.balance].forEach((i) => i != null && used.add(i));
  }
  if (!mapping.description) {
    let best = null;
    for (let c = 0; c < columnCount; c++) {
      if (!free(c)) continue;
      const s = stats[c];
      if (s.numShare > 0.5 || s.dateShare > 0.5 || s.starShare > 0.5) continue;
      if (best == null || s.avgLen > stats[best].avgLen) best = c;
    }
    if (best != null) mapping.description = [best];
  }
  mapping.sign = 'signed';
  return mapping;
}

// --------------------------------------------------------------------------
// Normalisation
// --------------------------------------------------------------------------

function cleanDescription(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const t = String(p || '').replace(/\s+/g, ' ').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.join(' · ');
}

function normalizeDescription(desc) {
  return String(desc || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Stable identity of a statement line: (date, amount, description).
function fingerprintOf(date, amount, description) {
  const amt = money.round(amount).toFixed(2);
  return crypto.createHash('sha1').update(`${date}|${amt}|${normalizeDescription(description)}`).digest('hex').slice(0, 20);
}

function normalizeRow(cells, idx, options, rowIndex) {
  const out = { index: rowIndex, raw: cells, error: null, skipped: null };
  const cell = (i) => (i == null ? '' : cells[i] ?? '');

  if (options.skipRow) {
    const reason = options.skipRow(cells, idx);
    if (reason) {
      out.skipped = reason;
      return out;
    }
  }

  const dateRaw = cell(idx.date);
  const amountRaw = cell(idx.amount);
  const debitRaw = cell(idx.debit);
  const creditRaw = cell(idx.credit);
  if (!dateRaw && !amountRaw && !debitRaw && !creditRaw) {
    out.skipped = 'blank';
    return out;
  }

  const date = parseDate(dateRaw, options.dateOrder || 'auto');
  if (!date) {
    out.error = dateRaw ? `Unrecognised date "${dateRaw}"` : 'Missing date';
    return out;
  }

  let amount = null;
  if (idx.amount != null) {
    amount = parseAmount(amountRaw);
    if (amount == null && idx.amountAlt != null) amount = parseAmount(cell(idx.amountAlt));
  }
  if (amount == null && (idx.debit != null || idx.credit != null)) {
    const debit = parseAmount(debitRaw);
    const credit = parseAmount(creditRaw);
    if (debit == null && credit == null) {
      out.error = 'Missing amount';
      return out;
    }
    amount = money.sub(credit == null ? 0 : Math.abs(credit), debit == null ? 0 : Math.abs(debit));
  }
  if (amount == null) {
    out.error = amountRaw ? `Unrecognised amount "${amountRaw}"` : 'Missing amount';
    return out;
  }
  if (idx.fee != null) {
    const fee = parseAmount(cell(idx.fee));
    if (fee) amount = money.sub(amount, Math.abs(fee));
  }
  if (idx.sign === 'debit-positive') amount = -amount;
  if (idx.typeColumn != null) {
    const t = norm(cell(idx.typeColumn)).replace(/\s+/g, '_');
    if (DEBIT_WORDS.includes(t)) amount = -Math.abs(amount);
    else if (CREDIT_WORDS.includes(t)) amount = Math.abs(amount);
  }
  amount = money.round(amount);

  const descParts = (idx.description || []).map((i) => cells[i]);
  const description = cleanDescription(descParts) || 'Transaction';

  let category = null;
  if (idx.category != null && cell(idx.category)) category = cell(idx.category);
  else if (idx.mcc != null && cell(idx.mcc)) category = categorizeByMcc(cell(idx.mcc));
  else category = categorizeByDescription(description);

  const currency = idx.fixedCurrency || (idx.currency != null ? cell(idx.currency).toUpperCase() || null : null);
  const externalId = idx.externalId != null ? cell(idx.externalId) || null : null;
  const balance = idx.balance != null ? parseAmount(cell(idx.balance)) : null;

  Object.assign(out, {
    date,
    description,
    amount,
    type: amount >= 0 ? 'income' : 'expense',
    category,
    currency,
    externalId,
    balance,
    fingerprint: fingerprintOf(date, amount, description)
  });
  return out;
}

// Mark in-file and existing duplicates. existing = Set of fingerprints already in the DB.
function markDuplicates(rows, existing) {
  const seen = new Set();
  for (const r of rows) {
    r.duplicate = null;
    if (!r.fingerprint) continue;
    if (existing && existing.has(r.fingerprint)) r.duplicate = 'existing';
    else if (seen.has(r.fingerprint)) r.duplicate = 'file';
    seen.add(r.fingerprint);
  }
  return rows;
}

function summarize(rows) {
  const stats = { total: rows.length, valid: 0, duplicates: 0, skipped: 0, errors: 0, sum: 0, income: 0, expense: 0, minDate: null, maxDate: null };
  for (const r of rows) {
    if (r.error) stats.errors++;
    else if (r.skipped) stats.skipped++;
    else if (r.duplicate) stats.duplicates++;
    else {
      stats.valid++;
      stats.sum = money.add(stats.sum, r.amount);
      if (r.amount >= 0) stats.income = money.add(stats.income, r.amount);
      else stats.expense = money.add(stats.expense, r.amount);
      if (!stats.minDate || r.date < stats.minDate) stats.minDate = r.date;
      if (!stats.maxDate || r.date > stats.maxDate) stats.maxDate = r.date;
    }
  }
  return stats;
}

// --------------------------------------------------------------------------
// Preview
// --------------------------------------------------------------------------

// options: { presetId, hasHeader, delimiter, mapping, dateOrder, existingFingerprints }
function previewCsv(text, options = {}) {
  const src = stripBom(String(text || ''));
  const delimiter = options.delimiter || detectDelimiter(src);
  const rows = skipPreamble(parseCsv(src, delimiter));
  if (rows.length === 0) throw new Error('The file is empty');

  const forcedPreset = options.presetId && options.presetId !== 'generic' && options.presetId !== 'auto' ? PRESETS[options.presetId] : null;
  if (options.presetId && options.presetId !== 'generic' && options.presetId !== 'auto' && !forcedPreset) {
    throw new Error(`Unknown preset "${options.presetId}"`);
  }

  let hasHeader;
  if (typeof options.hasHeader === 'boolean') hasHeader = options.hasHeader;
  else if (forcedPreset) hasHeader = forcedPreset.hasHeader;
  else hasHeader = detectHeader(rows);

  const headers = hasHeader ? rows[0] : [];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const { columnCount, stats } = columnStats(dataRows);
  const ctx = { hasHeader, headers, columnCount, colStats: stats, dataRows };

  const preset = forcedPreset || detectPreset(ctx);
  let mappingSource = 'auto';
  let baseMapping;
  if (options.mapping && typeof options.mapping === 'object' && Object.keys(options.mapping).length) {
    baseMapping = options.mapping;
    mappingSource = 'manual';
  } else if (preset) {
    baseMapping = preset.mapping;
    mappingSource = 'preset';
  } else {
    baseMapping = autoMapping(headers, dataRows, hasHeader);
  }
  const idx = resolveMapping(baseMapping, headers, columnCount);
  if (idx.date == null || (idx.amount == null && idx.debit == null && idx.credit == null)) {
    // A preset whose columns moved -> fall back to auto so the user can still map by hand.
    if (mappingSource === 'preset') {
      const auto = autoMapping(headers, dataRows, hasHeader);
      Object.assign(idx, resolveMapping(auto, headers, columnCount));
      mappingSource = 'auto';
    }
  }

  let dateOrder = options.dateOrder || (preset && preset.dateOrder) || null;
  if (!dateOrder && idx.date != null) dateOrder = inferDateOrder(dataRows.map((r) => r[idx.date])) || 'MDY';

  const normOpts = { dateOrder, skipRow: preset && preset.skipRow ? preset.skipRow : null };
  const normalized = dataRows.map((cells, i) => normalizeRow(cells, idx, normOpts, hasHeader ? i + 2 : i + 1));
  markDuplicates(normalized, options.existingFingerprints);

  return {
    kind: 'csv',
    delimiter,
    hasHeader,
    headers,
    columnCount,
    columnNames: headers.length ? headers : Array.from({ length: columnCount }, (_, i) => `Column ${i + 1}`),
    sampleRows: dataRows.slice(0, 5),
    preset: preset ? { id: preset.id, name: preset.name, bankId: preset.bankId, verified: preset.verified, notes: preset.notes || null } : null,
    detected: !!preset && !forcedPreset,
    mappingSource,
    mapping: {
      date: idx.date,
      description: idx.description || [],
      amount: idx.amount,
      debit: idx.debit,
      credit: idx.credit,
      fee: idx.fee,
      balance: idx.balance,
      category: idx.category,
      currency: idx.currency,
      externalId: idx.externalId,
      mcc: idx.mcc,
      typeColumn: idx.typeColumn,
      stateColumn: idx.stateColumn,
      fixedCurrency: idx.fixedCurrency || null,
      sign: idx.sign
    },
    dateOrder,
    rows: normalized,
    stats: summarize(normalized)
  };
}

// --------------------------------------------------------------------------
// Compatibility: routes/transactions.js POST /import (file on disk)
// --------------------------------------------------------------------------

async function processCSVFile(filePath, options = {}) {
  const { userId, accountId, bankType } = options;
  const text = await fs.promises.readFile(filePath, 'utf8');
  const presetId = bankType && bankType !== 'generic' && PRESETS[bankType] ? bankType : null;
  const preview = previewCsv(text, { presetId });
  return preview.rows
    .filter((r) => !r.error && !r.skipped && r.duplicate !== 'file')
    .map((r) => ({
      date: r.date,
      description: r.description,
      amount: r.amount,
      category: r.category,
      type: r.type,
      accountId,
      userId
    }));
}

module.exports = {
  // parsing primitives
  detectDelimiter,
  parseCsv,
  skipPreamble,
  detectHeader,
  parseDate,
  parseAmount,
  inferDateOrder,
  // presets / mapping
  PRESETS,
  listPresets,
  detectPreset,
  autoMapping,
  resolveMapping,
  // normalisation
  normalizeRow,
  fingerprintOf,
  markDuplicates,
  summarize,
  // entry points
  previewCsv,
  processCSVFile
};
