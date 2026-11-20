// services/statement/proof.js — the balance proof of the Statement Agent.
//
// Integer cents only. A statement is "proven" when
//   bank account:  opening + Σ rows = closing
//   card account:  opening − Σ rows = closing   (the balance is money owed; a purchase is a
//                                               negative row in the holder's view and raises it)
// and every printed running balance matches the chain row by row. The first row where the
// chain breaks is reported with its page, so the agent re-reads only that page and the
// person sees exactly where the gap is. Nothing here guesses a number.
'use strict';

const CURRENCY_JUNK = /[^\d.,()\-+−–]/g;

// "1,234.56" | "1.234,56" | "(12.30)" | "12.30-" | "12.30 CR" | "−5" | 12.3 -> integer cents, or null.
function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Math.round(v * 100);
  }
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/\bDR\b|\bDB\b/i.test(s)) neg = true;
  const cr = /\bCR\b/i.test(s);
  s = s.replace(CURRENCY_JUNK, '');
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); }
  if (/[-−–]$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart; let frac = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    intPart = s.slice(0, dec).replace(/[.,]/g, '');
    frac = s.slice(dec + 1);
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const at = sep === ',' ? lastComma : lastDot;
    const tail = s.slice(at + 1);
    const count = s.split(sep).length - 1;
    // One separator followed by 1–2 digits is the decimal point; "1,234" / "1.234.567" are thousands.
    if (count === 1 && tail.length >= 1 && tail.length <= 2) { intPart = s.slice(0, at); frac = tail; } else { intPart = s.split(sep).join(''); }
  } else intPart = s;
  if (frac.length > 2 || !/^\d*$/.test(intPart) || !/^\d*$/.test(frac)) return null;
  const cents = Number(intPart || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return (neg && !cr ? -1 : 1) * cents;
}

const fmt = (c) => {
  if (c === null || c === undefined) return '—';
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (c < 0 ? '-' : '') + s;
};

// rows: [{ cents, balance_cents?, page?, unclear? }]
// -> { status, kind, opening_cents, closing_cents, sum_cents, computed_closing_cents, gap_cents,
//      rows_checked, running_checked, breaks: [...], first_break, unclear_rows, opening_inferred, line }
// status: proven | gap | needs_closing | needs_opening | unclear
function prove({ opening_cents: opening, closing_cents: closing, rows, kind = 'bank' }) {
  const sign = kind === 'card' ? -1 : 1;
  const list = Array.isArray(rows) ? rows : [];
  const unclear = [];
  let sum = 0;
  list.forEach((r, i) => {
    if (r.unclear || r.cents === null || r.cents === undefined || !Number.isInteger(r.cents)) unclear.push(i);
    else sum += r.cents;
  });

  let openingInferred = false;
  let open = Number.isInteger(opening) ? opening : null;
  if (open === null && list.length && Number.isInteger(list[0].balance_cents) && Number.isInteger(list[0].cents)) {
    open = list[0].balance_cents - sign * list[0].cents;
    openingInferred = true;
  }

  // Running balance chain: resync on every printed balance so one break is reported once.
  const breaks = [];
  let runningChecked = 0;
  let prev = open;
  list.forEach((r, i) => {
    const amt = Number.isInteger(r.cents) && !r.unclear ? r.cents : null;
    const expected = prev !== null && amt !== null ? prev + sign * amt : null;
    if (Number.isInteger(r.balance_cents)) {
      if (expected !== null && !(openingInferred && i === 0)) {
        runningChecked += 1;
        if (expected !== r.balance_cents) {
          breaks.push({ index: i, page: r.page || null, expected_balance_cents: expected, printed_balance_cents: r.balance_cents, diff_cents: r.balance_cents - expected });
        }
      }
      prev = r.balance_cents;
    } else prev = expected;
  });

  const out = {
    kind,
    opening_cents: open,
    opening_inferred: openingInferred,
    closing_cents: Number.isInteger(closing) ? closing : null,
    sum_cents: sum,
    rows_checked: list.length - unclear.length,
    running_checked: runningChecked,
    breaks,
    first_break: breaks[0] || null,
    unclear_rows: unclear,
    computed_closing_cents: null,
    gap_cents: null,
  };

  if (open === null) {
    out.status = 'needs_opening';
  } else {
    out.computed_closing_cents = open + sign * sum;
    if (unclear.length) out.status = 'unclear';
    else if (out.closing_cents === null) out.status = 'needs_closing';
    else {
      out.gap_cents = out.closing_cents - out.computed_closing_cents;
      out.status = out.gap_cents === 0 && breaks.length === 0 ? 'proven' : 'gap';
    }
  }
  out.line = proofLine(out, list.length);
  return out;
}

// One line a person can read: "3,240.00 − 45 rows (−2,975.94) = 6,215.94 ✓ matches the printed closing to the cent"
function proofLine(p, n) {
  const op = p.kind === 'card' ? '−' : '+';
  const head = `${fmt(p.opening_cents)} ${op} ${n} rows (${fmt(p.sum_cents)}) = ${fmt(p.computed_closing_cents)}`;
  switch (p.status) {
    case 'proven': return `${head} — matches the printed closing ${fmt(p.closing_cents)} to the cent`;
    case 'gap': {
      const b = p.first_break;
      const where = b ? `; the balance chain first breaks at row ${b.index + 1}${b.page ? ` (page ${b.page})` : ''}` : '';
      return `${head} — printed closing is ${fmt(p.closing_cents)}, gap ${fmt(p.gap_cents)}${where}`;
    }
    case 'needs_closing': return `${head} — no closing balance on the statement; type it to finish the check`;
    case 'needs_opening': return 'No opening balance on the statement and no running balance to infer it; type the opening balance';
    case 'unclear': return `${p.unclear_rows.length} row amount(s) could not be read; nothing is guessed`;
    default: return head;
  }
}

// One unreadable amount can be DERIVED (never guessed) when the printed running balances on
// both sides of it pin it down. The totals check then stays an independent second source.
function deriveUnclear(rows, opening, kind = 'bank') {
  const sign = kind === 'card' ? -1 : 1;
  const out = rows.map((r) => ({ ...r }));
  const derived = [];
  out.forEach((r, i) => {
    if (!(r.unclear || !Number.isInteger(r.cents))) return;
    if (!Number.isInteger(r.balance_cents)) return;
    let prevBal = null;
    if (i === 0) prevBal = Number.isInteger(opening) ? opening : null;
    else if (Number.isInteger(out[i - 1].balance_cents)) prevBal = out[i - 1].balance_cents;
    if (prevBal === null) return;
    const cents = sign * (r.balance_cents - prevBal);
    out[i] = { ...r, cents, unclear: false, derived: true };
    derived.push(i);
  });
  return { rows: out, derived };
}

module.exports = { toCents, prove, proofLine, deriveUnclear, fmt };
