// services/moneyRecap.js — "Your week in money" / "Your month in money".
//
// recap(userId, { kind: 'week' | 'month', now })
//   week  = the last complete Monday–Sunday week (Toronto)
//   month = the last complete calendar month
// Own money only: demo accounts (accounts.is_demo) are excluded; transfers and
// opening balances are not cash flow (lib/txFilter). Amounts are converted into
// the user's base currency.
'use strict';

const { query, get } = require('../db/database');
const money = require('../lib/money');
const dates = require('../lib/dates');
const fx = require('../lib/fx');
const { isCashflow } = require('../lib/txFilter');
const journey = require('./journey');

const TZ = 'America/Toronto';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fmtDay(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

// { start, end, prevStart, prevEnd, label, key } for the period before `today`.
function periodFor(kind, today) {
  if (kind === 'month') {
    const thisMonth = dates.startOfMonthISO(today);
    const start = dates.addMonthsISO(thisMonth, -1);
    const end = dates.addDaysISO(thisMonth, -1);
    const prevStart = dates.addMonthsISO(start, -1);
    const prevEnd = dates.addDaysISO(start, -1);
    const [y, m] = start.split('-').map(Number);
    return { kind, start, end, prevStart, prevEnd, label: `${MONTHS_LONG[m - 1]} ${y}`, key: start.slice(0, 7) };
  }
  const monday = journey.weekStart(today);
  const start = dates.addDaysISO(monday, -7);
  const end = dates.addDaysISO(monday, -1);
  const prevStart = dates.addDaysISO(start, -7);
  const prevEnd = dates.addDaysISO(start, -1);
  const sameMonth = start.slice(5, 7) === end.slice(5, 7);
  const label = sameMonth ? `${fmtDay(start)}–${Number(end.slice(8))}` : `${fmtDay(start)} – ${fmtDay(end)}`;
  return { kind: 'week', start, end, prevStart, prevEnd, label, key: start };
}

async function rowsBetween(userId, start, end) {
  return query(
    `SELECT t.date, t.description, t.type, t.amount, t.category, a.currency AS currency
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND COALESCE(a.is_demo, 0) = 0 AND t.date >= ? AND t.date <= ?
      ORDER BY t.date ASC`,
    [userId, start, end],
  );
}

async function totals(rows, conv) {
  let income = 0;
  let expense = 0;
  const cats = {};
  const items = [];
  for (const r of rows) {
    if (!isCashflow(r)) continue;
    const amt = await conv.convert(Math.abs(Number(r.amount) || 0), r.currency);
    if (r.type === 'income') {
      income = money.add(income, amt);
    } else {
      expense = money.add(expense, amt);
      const c = r.category || 'Uncategorized';
      cats[c] = money.add(cats[c] || 0, amt);
      items.push({ date: r.date, description: r.description || '', category: c, amount: amt });
    }
  }
  return { income, expense, net: money.sub(income, expense), cats, items, count: rows.length };
}

function pct(now, prev) {
  if (!prev) return null;
  return Math.round(((now - prev) / prev) * 100);
}

async function recap(userId, { kind = 'week', now = new Date() } = {}) {
  const today = dates.todayISO(TZ, now);
  const p = periodFor(kind === 'month' ? 'month' : 'week', today);
  const conv = await fx.converterForUser(userId);
  const [cur, prev] = await Promise.all([
    rowsBetween(userId, p.start, p.end).then((r) => totals(r, conv)),
    rowsBetween(userId, p.prevStart, p.prevEnd).then((r) => totals(r, conv)),
  ]);

  const topCategories = Object.keys(cur.cats)
    .map((c) => ({ category: c, amount: cur.cats[c], prev: prev.cats[c] || 0, delta: pct(cur.cats[c], prev.cats[c] || 0) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
  const biggest = cur.items.slice().sort((a, b) => b.amount - a.amount).slice(0, 3);

  // Budgets: spent this period in the budget's category (month view uses the
  // full month; week view shows month-to-date, because budgets are monthly).
  const budgetRows = await query(
    'SELECT id, name, category, amount FROM budgets WHERE user_id = ? AND is_active = 1 ORDER BY id', [userId],
  ).catch(() => []);
  const mStart = kind === 'month' ? p.start : dates.startOfMonthISO(today);
  const mEnd = kind === 'month' ? p.end : today;
  const monthTotals = budgetRows.length ? await rowsBetween(userId, mStart, mEnd).then((r) => totals(r, conv)) : null;
  const budgets = budgetRows.map((b) => {
    const spent = b.category && monthTotals ? (monthTotals.cats[b.category] || 0) : 0;
    const amount = Number(b.amount) || 0;
    return { name: b.name, category: b.category, amount, spent, percent: amount > 0 ? Math.round((spent / amount) * 100) : 0 };
  });

  const goalRows = await query(
    `SELECT name, target_amount, current_amount, target_date FROM savings_goals
      WHERE user_id = ? AND is_active = 1 AND COALESCE(is_completed, 0) = 0 ORDER BY id`, [userId],
  ).catch(() => []);
  const goals = goalRows.map((g) => {
    const target = Number(g.target_amount) || 0;
    const current = Number(g.current_amount) || 0;
    let monthlyNeeded = null;
    if (g.target_date && target > current) {
      const months = Math.max(1, Math.ceil((dates.diffDays(today, g.target_date) || 0) / 30.4));
      monthlyNeeded = money.round((target - current) / months);
    }
    return { name: g.name, target, current, percent: target > 0 ? Math.round((current / target) * 100) : 0, monthlyNeeded, targetDate: g.target_date };
  });

  const last = await get(
    `SELECT MAX(t.date) AS d FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND COALESCE(a.is_demo, 0) = 0`, [userId],
  ).catch(() => null);

  return {
    kind: p.kind,
    period: { start: p.start, end: p.end, label: p.label, key: p.key },
    currency: conv.baseCurrency,
    income: cur.income,
    expense: cur.expense,
    net: cur.net,
    transactions: cur.count,
    prev: { income: prev.income, expense: prev.expense, net: prev.net },
    expenseDelta: pct(cur.expense, prev.expense),
    savingsRate: cur.income > 0 ? Math.round((cur.net / cur.income) * 100) : null,
    topCategories,
    biggest,
    budgets,
    goals,
    lastDataDate: (last && last.d) || null,
    stale: !last || !last.d || last.d < p.end,
  };
}

module.exports = { recap, periodFor };
