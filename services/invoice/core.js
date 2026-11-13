// services/invoice/core.js — pure helpers for invoices: money, numbering, amount in words,
// online-payment link, placeholders. No DB access here, so everything is unit-testable.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// ---------- money ----------
// "1,500.00" / "1500,5" / 1500.5 -> 150050 (cents). Returns null when not a number.
function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v).trim().replace(/[\s '’]/g, '');
  if (!s) return null;
  // "1.500,25" (EU) vs "1,500.25" (EN): the last separator is the decimal one.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    const decimals = s.length - lastComma - 1;
    s = decimals === 3 && lastDot === -1 && (s.match(/,/g) || []).length >= 1 && !/^-?0,/.test(s)
      ? s.replace(/,/g, '') // "1,500" = thousands
      : s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

// 169500 -> "1,695.00"
function fmtCents(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

function fmtQty(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

// items: [{qty, price_cents}] -> amounts + totals. Tax rounds once on the subtotal.
function computeTotals(items, taxRate) {
  const rows = items.map((it) => {
    const qty = Number(it.qty);
    const amount = Math.round((Number.isFinite(qty) ? qty : 0) * (it.price_cents || 0));
    return { ...it, amount_cents: amount };
  });
  const subtotal = rows.reduce((s, r) => s + r.amount_cents, 0);
  const rate = taxRate === null || taxRate === undefined || taxRate === '' ? null : Number(taxRate);
  const tax = rate === null || !Number.isFinite(rate) ? 0 : Math.round((subtotal * rate) / 100);
  return { items: rows, subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax };
}

// ---------- dates ----------
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 ? d : null;
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function daysBetween(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }
// "2026-11-13" -> "November 13, 2026"
function longDate(s) { const d = parseYmd(s); return d ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` : ''; }
// "2026-11-13" -> "13 November 2026"
function dayMonthYear(s) { const d = parseYmd(s); return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : ''; }
// "2026-11-13" -> "13.11.2026"
function dmy(s) { const d = parseYmd(s); return d ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : ''; }
// Today in the server's business zone (America/Toronto by default).
function today(tz = process.env.INVOICE_TZ || 'America/Toronto') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ---------- numbering ----------
// Tokens: {DD} {MM} {YY} {YYYY} — issue date; {N} — smallest free counter for the rest of the
// pattern (INNOVA style 13-11-26-1, 13-11-26-2 …); {SEQ} {SEQ3} {SEQ4} — the template's running counter.
function renderNumber(format, dateYmd, { n = 1, seq = 1 } = {}) {
  const d = parseYmd(dateYmd) || parseYmd(today());
  const s = ymd(d);
  return String(format || '{SEQ}')
    .replace(/\{DD\}/g, s.slice(8, 10))
    .replace(/\{MM\}/g, s.slice(5, 7))
    .replace(/\{YYYY\}/g, s.slice(0, 4))
    .replace(/\{YY\}/g, s.slice(2, 4))
    .replace(/\{N\}/g, String(n))
    .replace(/\{SEQ(\d)?\}/g, (_, w) => String(seq).padStart(w ? +w : 1, '0'));
}

// existing: Set of numbers already used by the user.
function suggestNumber(format, dateYmd, nextSeq, existing) {
  const fmt = String(format || '{SEQ}');
  const usesN = fmt.includes('{N}');
  const usesSeq = /\{SEQ\d?\}/.test(fmt);
  let n = 1;
  let seq = Math.max(1, nextSeq || 1);
  for (let guard = 0; guard < 10000; guard++) {
    const num = renderNumber(fmt, dateYmd, { n, seq });
    if (!existing.has(num)) return num;
    if (usesN) n++;
    else if (usesSeq) seq++;
    else return `${num}-${guard + 2}`;
  }
  return renderNumber(fmt, dateYmd, { n, seq }) + '-' + Date.now();
}

// After a number is used, the template's next_seq moves past it when the number carries {SEQ}.
function seqFromNumber(format, number) {
  const fmt = String(format || '');
  if (!/\{SEQ\d?\}/.test(fmt)) return null;
  const esc = fmt.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    .replace(/\\?\{SEQ\d?\\?\}/g, '(\\d+)')
    .replace(/\\?\{(DD|MM|YY|N)\\?\}/g, '\\d+')
    .replace(/\\?\{YYYY\\?\}/g, '\\d\\d\\d\\d')
    .replace(/\{/g, '\\{').replace(/\}/g, '\\}');
  const m = new RegExp(`^${esc}$`).exec(String(number));
  return m ? parseInt(m[1], 10) : null;
}

// ---------- amount in words (English) ----------
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n) {
  const out = [];
  if (n >= 100) { out.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) out.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
  else if (n > 0) out.push(ONES[n]);
  return out.join(' ');
}

function numberToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const scales = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  const parts = [];
  for (const [v, name] of scales) {
    if (n >= v) { parts.push(`${below1000(Math.floor(n / v))} ${name}`); n %= v; }
  }
  if (n > 0) parts.push(below1000(n));
  return parts.join(' ');
}

const CURRENCY_WORDS = {
  EUR: { one: 'euro', many: 'euros', minor: 'cents' },
  CAD: { one: 'Canadian dollar', many: 'Canadian dollars', minor: 'cents' },
  USD: { one: 'US dollar', many: 'US dollars', minor: 'cents' },
  GBP: { one: 'pound sterling', many: 'pounds sterling', minor: 'pence' },
  UAH: { one: 'hryvnia', many: 'hryvnias', minor: 'kopiykas' },
};

// 169500, 'CAD' -> "One thousand six hundred ninety-five Canadian dollars 00 cents"
// unit overrides the currency wording (the UK template says "euro … euro cents").
function amountInWords(cents, currency, unit) {
  const u = { ...(CURRENCY_WORDS[String(currency).toUpperCase()] || { one: String(currency), many: String(currency), minor: 'cents' }), ...(unit || {}) };
  const major = Math.floor(Math.abs(cents) / 100);
  const minor = Math.abs(cents) % 100;
  const w = numberToWords(major);
  const name = major === 1 ? u.one : u.many;
  return `${w.charAt(0).toUpperCase()}${w.slice(1)} ${name} ${String(minor).padStart(2, '0')} ${u.minor}`;
}

// ---------- online payment link ----------
// Mirrors innova/tools/pay_link.py: ref regex, EUR/USD/CAD (configurable), amount ≥ 1.00,
// whole amounts without decimals, form-urlencoded values.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;
function payAmount(cents) { return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2); }
function formEncode(v) { return encodeURIComponent(v).replace(/%20/g, '+').replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }

function payUrl(payOnline, number, cents, currency) {
  if (!payOnline || !payOnline.url) return null;
  const cur = String(currency || '').toUpperCase();
  const allowed = Array.isArray(payOnline.currencies) && payOnline.currencies.length
    ? payOnline.currencies.map((c) => String(c).toUpperCase()) : null;
  if (allowed && !allowed.includes(cur)) return null;
  if (!REF_RE.test(String(number))) return null;
  if (!(cents >= 100)) return null;
  const url = String(payOnline.url)
    .replace(/\{ref\}/g, formEncode(number))
    .replace(/\{amount\}/g, formEncode(payAmount(cents)))
    .replace(/\{currency\}/g, formEncode(cur));
  return /^https:\/\/[^\s]+$/i.test(url) ? url : null;
}

// ---------- placeholders in template texts ----------
function fill(text, ctx) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (ctx[k] !== undefined && ctx[k] !== null ? String(ctx[k]) : m));
}

module.exports = {
  MONTHS, toCents, fmtCents, fmtQty, computeTotals,
  parseYmd, ymd, addDays, daysBetween, longDate, dayMonthYear, dmy, today,
  renderNumber, suggestNumber, seqFromNumber,
  numberToWords, amountInWords, CURRENCY_WORDS,
  REF_RE, payAmount, payUrl, fill,
};
