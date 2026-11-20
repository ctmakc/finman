// services/statement/plan.js — the next 30 days, from one proven statement. Plain arithmetic on
// the proven rows (integer cents), no model: income and spending scaled to 30 days, bills that
// repeat (same payee twice, or a known bill / subscription word), the five biggest spending
// categories, and what can go out per day once the repeating bills are paid without going below today's
// balance. Labelled an estimate.
'use strict';

const BILL_WORDS = /\b(rent|mortgage|hydro|electric|utility|utilities|water|gas bill|insurance|rogers|bell|telus|fido|koodo|freedom|virgin|internet|wireless|mobile|phone|netflix|spotify|disney|apple\.com|icloud|google \*|youtube|amazon prime|prime video|crave|gym|fitness|membership|subscription|loan|lease|tuition|daycare|pad|pre-?authorized|monthly (account )?fee|account fee|plan fee)\b/i;

const payee = (d) => String(d || '').toLowerCase().replace(/[#*]?\d[\d\-/.]*/g, ' ').replace(/[^a-z&' ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');

function days(start, end, rows) {
  const ds = rows.map((r) => r.date).filter(Boolean).sort();
  const a = start || ds[0];
  const b = end || ds[ds.length - 1];
  if (!a || !b) return 30;
  const n = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
  return Number.isFinite(n) && n >= 7 ? n : 30;
}

function plan30(rows, { closing_cents: closing, period_start: ps, period_end: pe, statement_type: st, currency }) {
  const list = rows.filter((r) => Number.isInteger(r.cents));
  const span = days(ps, pe, list);
  const scale = (c) => Math.round((c * 30) / span);
  let income = 0;
  let spend = 0;
  const byCat = new Map();
  const groups = new Map();
  for (const r of list) {
    if (r.cents > 0) income += r.cents;
    else {
      spend += -r.cents;
      const c = r.category || 'Other';
      byCat.set(c, (byCat.get(c) || 0) - r.cents);
    }
    if (r.cents < 0) {
      const k = payee(r.description);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
  }
  // A bill = a known bill word, or the same payee with (nearly) the same amount twice.
  const bills = [];
  for (const [k, g] of groups) {
    const word = g.some((r) => BILL_WORDS.test(r.description));
    const amounts = g.map((r) => -r.cents);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    const steady = g.length >= 2 && max - min <= Math.max(100, Math.round(max * 0.05));
    if (!word && !steady) continue;
    if (!word && /uber|tim hortons|starbucks|coffee|grocery|metro|loblaws|walmart|costco|amazon|dollarama|petro|shell|esso/i.test(k)) continue;
    const monthly = scale(amounts.reduce((a, b) => a + b, 0));
    bills.push({ payee: g[0].description, times: g.length, cents_30d: monthly });
  }
  bills.sort((a, b) => b.cents_30d - a.cents_30d);
  const bills30 = bills.reduce((a, b) => a + b.cents_30d, 0);
  const income30 = scale(income);
  const spend30 = scale(spend);
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category, c]) => ({ category, cents_30d: scale(c), share: spend ? Math.round((c * 100) / spend) : 0 }));
  const out = {
    estimate: true,
    basis_days: span,
    currency: currency || null,
    income_30d_cents: income30,
    spending_30d_cents: spend30,
    net_30d_cents: income30 - spend30,
    bills: bills.slice(0, 8),
    bills_30d_cents: bills30,
    top_categories: top,
  };
  if (st !== 'card' && Number.isInteger(closing)) {
    out.start_balance_cents = closing;
    out.projected_balance_cents = closing + income30 - spend30;
    // Per day for everything that is not a repeating bill, if income repeats, without going
    // below today's balance.
    out.flexible_per_day_cents = Math.max(0, Math.floor((income30 - bills30) / 30));
  }
  return out;
}

module.exports = { plan30, payee };
