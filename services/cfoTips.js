// services/cfoTips.js — AI CFO tips from the user's own numbers.
//
// tips(userId, { now }) -> [{ id, kind, title, body, action: { label, page }, ask, weight }]
// Deterministic rules over the last 90 days + this month (own money only, base
// currency). Each tip names real amounts and points to one screen; `ask` is a
// ready question for the AI chat. The same list goes into the AI chat context
// (services/aiService.js) so the model answers from the same facts.
'use strict';

const { query } = require('../db/database');
const money = require('../lib/money');
const dates = require('../lib/dates');
const fx = require('../lib/fx');
const { isCashflow } = require('../lib/txFilter');
const { detectRecurring } = require('./subscriptionDetector');

const TZ = 'America/Toronto';
const FIXED_CATS = /^(housing|rent|mortgage|utilities|insurance|transfer|investments?|savings|taxes|salary|income|loans?|debt|childcare|education|tuition)$/i;
const FEES = /\b(fee|fees|interest charge|purchase interest|nsf|overdraft|service charge|monthly plan|annual fee|atm)\b/i;

function fmt(n, cur) {
  const v = Math.round(Number(n) || 0);
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur || 'CAD', maximumFractionDigits: 0 }).format(v);
  } catch (_) {
    return `${v} ${cur || ''}`.trim();
  }
}

async function ownRows(userId, start, end) {
  return query(
    `SELECT t.date, t.description, t.type, t.amount, t.category, a.currency AS currency
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND COALESCE(a.is_demo, 0) = 0 AND t.date >= ? AND t.date <= ?`,
    [userId, start, end],
  );
}

async function tips(userId, { now = new Date(), limit = 5 } = {}) {
  const today = dates.todayISO(TZ, now);
  const conv = await fx.converterForUser(userId);
  const cur = conv.baseCurrency;
  const monthStart = dates.startOfMonthISO(today);
  const histStart = dates.addMonthsISO(monthStart, -3);
  const rows = await ownRows(userId, histStart, today);
  if (!rows.length) return [];

  // Per-month category totals (expenses) and income/expense per month.
  const byMonth = {};
  const fees = [];
  const expenses = [];
  for (const r of rows) {
    if (!isCashflow(r)) continue;
    const m = r.date.slice(0, 7);
    const amt = await conv.convert(Math.abs(Number(r.amount) || 0), r.currency);
    const b = byMonth[m] || (byMonth[m] = { income: 0, expense: 0, cats: {}, cnt: {} });
    if (r.type === 'income') { b.income = money.add(b.income, amt); continue; }
    b.expense = money.add(b.expense, amt);
    const c = r.category || 'Uncategorized';
    b.cats[c] = money.add(b.cats[c] || 0, amt);
    b.cnt[c] = (b.cnt[c] || 0) + 1;
    expenses.push({ ...r, amt });
    if (FEES.test(String(r.description || '')) || /^(bank )?fees?/i.test(String(r.category || ''))) fees.push(amt);
  }
  const thisKey = monthStart.slice(0, 7);
  const pastKeys = Object.keys(byMonth).filter((k) => k < thisKey).sort().slice(-3);
  const dayOfMonth = Number(today.slice(8));
  const daysInMonth = Number(dates.endOfMonthISO(today).slice(8));
  const share = dayOfMonth / daysInMonth;
  const out = [];

  // 1. A category running ahead of its usual month.
  const thisMonth = byMonth[thisKey];
  if (thisMonth && pastKeys.length && dayOfMonth >= 6) {
    let best = null;
    for (const c of Object.keys(thisMonth.cats)) {
      const usual = pastKeys.reduce((s, k) => s + ((byMonth[k].cats[c]) || 0), 0) / pastKeys.length;
      // Rent, insurance and other once-a-month payments land in one go;
      // projecting them by day of month would invent an overspend.
      if (usual < 50 || FIXED_CATS.test(c) || (thisMonth.cnt[c] || 0) < 2) continue;
      const pace = thisMonth.cats[c] / share;
      const over = pace - usual;
      if (pace > usual * 1.25 && over > 40 && (!best || over > best.over)) best = { c, pace, usual, spent: thisMonth.cats[c], over };
    }
    if (best) {
      out.push({
        id: `pace:${best.c}`, kind: 'pace', weight: 90 + Math.min(10, best.over / 50),
        title: `${best.c} is running ahead`,
        body: `${fmt(best.spent, cur)} so far this month, on pace for ${fmt(best.pace, cur)}. Your usual month is ${fmt(best.usual, cur)}.`,
        action: { label: 'See transactions', page: 'transactions' },
        ask: `Why is my ${best.c} spending higher this month and where can I cut it?`,
      });
    }
  }

  // 2. Recurring charges found in the statements.
  try {
    const rec = await detectRecurring(userId, { now });
    // Subscriptions and plans only: rent, savings transfers and loan payments repeat too,
    // but "cancel or downgrade" is the wrong advice for them.
    const list = (rec.candidates || []).filter((c) => c.billingCycle !== 'weekly'
      && !FIXED_CATS.test(String(c.category || ''))
      && !/\b(rent|mortgage|tfsa|rrsp|resp|fhsa|contrib\w*|transfer|loan|payment - thank you)\b/i.test(String(c.description || '')));
    const monthly = money.sum(list.map((c) => c.monthlyCost));
    if (list.length >= 2 && monthly >= 15) {
      const names = list.slice(0, 3).map((c) => `${String(c.description).slice(0, 22).trim()} ${fmt(c.monthlyCost, cur)}`).join(', ');
      out.push({
        id: 'recurring', kind: 'recurring', weight: 80,
        title: `${list.length} repeating charges: ${fmt(monthly, cur)} a month`,
        body: `That is ${fmt(monthly * 12, cur)} a year. Biggest: ${names}.`,
        action: { label: 'Review subscriptions', page: 'subscriptions' },
        ask: 'Which of my repeating charges could I cancel or downgrade?',
      });
    }
  } catch (_) { /* detector is best-effort */ }

  // 3. Fees and interest.
  const feeTotal = money.sum(fees);
  if (feeTotal >= 10) {
    out.push({
      id: 'fees', kind: 'fees', weight: 75 + Math.min(15, feeTotal / 20),
      title: `${fmt(feeTotal, cur)} in fees and interest`,
      body: `Bank fees, card interest and service charges since ${histStart.slice(0, 7)}. A no-fee account or paying the card in full stops most of it.`,
      action: { label: 'Find them', page: 'transactions' },
      ask: 'List my bank fees and interest charges and how to avoid them.',
    });
  }

  // 4. Budgets at risk this month.
  const budgets = await query('SELECT name, category, amount FROM budgets WHERE user_id = ? AND is_active = 1', [userId]).catch(() => []);
  for (const b of budgets) {
    const spent = (thisMonth && b.category && thisMonth.cats[b.category]) || 0;
    const amount = Number(b.amount) || 0;
    if (!amount) continue;
    if (spent / amount > share + 0.15 && spent / amount >= 0.5) {
      const left = Math.max(0, amount - spent);
      out.push({
        id: `budget:${b.name}`, kind: 'budget', weight: 85,
        title: `${b.name}: ${Math.round((spent / amount) * 100)}% used`,
        body: `${fmt(spent, cur)} of ${fmt(amount, cur)} with ${daysInMonth - dayOfMonth} days left. That leaves ${fmt(left / Math.max(1, (daysInMonth - dayOfMonth) / 7), cur)} a week.`,
        action: { label: 'Open budgets', page: 'budgets' },
        ask: `How do I keep my ${b.name} budget for the rest of the month?`,
      });
      break;
    }
  }

  // 5. No budget yet: offer one for the biggest flexible category.
  const FIXED = /^(housing|rent|mortgage|utilities|insurance|transfer|investments|taxes|salary|income)$/i;
  if (!budgets.length && pastKeys.length) {
    const avg = {};
    for (const k of pastKeys) for (const [c, v] of Object.entries(byMonth[k].cats)) avg[c] = (avg[c] || 0) + v / pastKeys.length;
    const top = Object.entries(avg).filter(([c]) => !FIXED.test(c)).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 80) {
      const target = Math.round((top[1] * 0.9) / 10) * 10;
      out.push({
        id: 'first-budget', kind: 'budget_suggest', weight: 70,
        title: `Budget ${top[0]} at ${fmt(target, cur)}`,
        body: `You spend about ${fmt(top[1], cur)} a month on ${top[0]}. A budget 10% under that is ${fmt(target, cur)} a month.`,
        action: { label: 'Create budget', page: 'budgets' },
        ask: `Is ${fmt(target, cur)} a month a realistic budget for ${top[0]}?`,
      });
    }
  }

  // 6. Savings rate of the last full month + goals.
  const lastKey = pastKeys[pastKeys.length - 1];
  const goals = await query(
    `SELECT name, target_amount, current_amount, target_date FROM savings_goals
      WHERE user_id = ? AND is_active = 1 AND COALESCE(is_completed, 0) = 0`, [userId],
  ).catch(() => []);
  if (lastKey && byMonth[lastKey].income > 0) {
    const m = byMonth[lastKey];
    const net = m.income - m.expense;
    const rate = Math.round((net / m.income) * 100);
    const [y, mo] = lastKey.split('-').map(Number);
    const monthName = new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-CA', { month: 'long', timeZone: 'UTC' });
    const g = goals.find((x) => x.target_date && Number(x.target_amount) > Number(x.current_amount || 0));
    if (g) {
      const monthsLeft = Math.max(1, Math.ceil((dates.diffDays(today, g.target_date) || 0) / 30.4));
      const need = (Number(g.target_amount) - Number(g.current_amount || 0)) / monthsLeft;
      out.push({
        id: `goal:${g.name}`, kind: 'goal', weight: net >= need ? 60 : 82,
        title: net >= need ? `${g.name} is on track` : `${g.name} needs ${fmt(need, cur)} a month`,
        body: `In ${monthName} you kept ${fmt(net, cur)} (${rate}% of income). The goal needs ${fmt(need, cur)} a month until ${g.target_date}.`,
        action: { label: 'Open goals', page: 'goals' },
        ask: `How can I reach my ${g.name} goal on time?`,
      });
    } else {
      out.push({
        id: 'savings-rate', kind: 'savings', weight: net < 0 ? 88 : 55,
        title: net < 0 ? `${monthName}: ${fmt(-net, cur)} more out than in` : `${monthName}: you kept ${rate}% of income`,
        body: net < 0
          ? `Income ${fmt(m.income, cur)}, spending ${fmt(m.expense, cur)}. The top category was ${Object.entries(m.cats).sort((a, b) => b[1] - a[1])[0][0]}.`
          : `${fmt(net, cur)} left after spending. A savings goal gives that money a job.`,
        action: net < 0 ? { label: 'See categories', page: 'reports' } : { label: 'Set a goal', page: 'goals' },
        ask: net < 0 ? `Why did I spend more than I earned in ${monthName}?` : 'What savings goal fits my numbers?',
      });
    }
  }

  // 7. One unusually large expense in the last 30 days.
  const since30 = dates.addDaysISO(today, -30);
  const recent = expenses.filter((e) => e.date >= since30 && !FIXED.test(String(e.category || '')));
  if (recent.length >= 8) {
    const sorted = recent.map((e) => e.amt).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const big = recent.slice().sort((a, b) => b.amt - a.amt)[0];
    if (big && big.amt > Math.max(150, median * 8)) {
      out.push({
        id: `big:${big.date}:${Math.round(big.amt)}`, kind: 'large', weight: 50,
        title: `One large payment: ${fmt(big.amt, cur)}`,
        body: `${String(big.description || '').slice(0, 40)} on ${big.date}, ${Math.round(big.amt / median)}× your typical purchase.`,
        action: { label: 'See transactions', page: 'transactions' },
        ask: `Was the ${fmt(big.amt, cur)} payment on ${big.date} a one-off? How does it change my month?`,
      });
    }
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

// Plain text for the AI chat context.
function toContext(list) {
  if (!list || !list.length) return '';
  return 'Facts already computed from the user\'s own transactions (use the numbers as given):\n'
    + list.map((t) => `- ${t.title}. ${t.body}`).join('\n');
}

module.exports = { tips, toContext, fmt };
