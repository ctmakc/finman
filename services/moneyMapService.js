// services/moneyMapService.js — "Business & personal": management accounting over the
// person's own transactions (21.11.2026).
//
// Answers four questions for a period:
//   1. How much does each business earn?   income − operating expenses = profit
//   2. Where does the business money go?    expense categories of business accounts
//   3. How much did the owner take home?    owner pay: business → personal transfers and
//                                           business expenses filed under an owner-pay category
//   4. Personal: what came in, where it went, what was left.
//
// An account belongs to a business when accounts.scope = 'business' (migration 031);
// accounts.business_name tells several businesses apart. Everything else is personal.
// Owner pay is NOT an operating expense: profit is counted before it, and the part
// left after it is what stayed in the business.
//
// Runs on the server and inside the Finman Vault engine (same code, sql.js) — it reads
// only through db/database and lib/fx, nothing server-only.
'use strict';

const { query } = require('../db/database');
const money = require('../lib/money');
const dates = require('../lib/dates');
const fx = require('../lib/fx');
const { cashflowOnly } = require('../lib/txFilter');

const CFT = cashflowOnly('t');

// Categories that mean "the owner paid themself" (compared lower-cased in JS: SQLite
// LOWER() does not lower Cyrillic).
const OWNER_PAY_CATEGORIES = new Set([
  'owner pay', "owner's pay", 'owner draw', "owner's draw", 'owner draws', 'owner salary',
  'salary to owner', 'dividends', 'dividend', 'draw',
  'зарплата собственнику', 'выплата собственнику', 'вывод собственнику', 'дивиденды',
  'виплата власнику', 'зарплата власнику', 'дивіденди',
]);

const UNCATEGORISED = new Set(['', 'other', 'uncategorized', 'uncategorised', 'прочее', 'інше', 'без категории', 'без категорії']);

const DEFAULT_BUSINESS_NAME = 'My business';
const TOP_N = 8;

function isOwnerPay(category) {
  return OWNER_PAY_CATEGORIES.has(String(category || '').trim().toLowerCase());
}

function isUncategorised(category) {
  return UNCATEGORISED.has(String(category || '').trim().toLowerCase());
}

function businessKey(name) {
  const n = String(name || '').trim();
  return n || DEFAULT_BUSINESS_NAME;
}

function emptyBusiness(name) {
  return {
    name,
    income: 0,
    expenses: 0,
    profit: 0,
    ownerPay: 0,
    ownerIn: 0,
    kept: 0,
    margin: null,
    accounts: [],
    expenseCategories: new Map(),
    incomeCategories: new Map(),
    uncategorisedExpense: 0,
  };
}

function addTo(map, key, amount) {
  map.set(key, money.add(map.get(key) || 0, amount));
}

function topList(map, total) {
  return Array.from(map.entries())
    .map(([category, amount]) => ({
      category,
      amount: money.round(amount),
      share: total > 0 ? Math.round((amount / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, TOP_N);
}

// Core calculation for one period. conv = lib/fx converter (shared across periods).
async function computePeriod(userId, start, end, conv) {
  const accounts = await query(
    `SELECT id, name, bank_name, currency, is_active,
            COALESCE(scope, 'personal') AS scope, COALESCE(business_name, '') AS business_name
       FROM accounts WHERE user_id = ?`,
    [userId]
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const businesses = new Map();
  const business = (name) => {
    const key = businessKey(name);
    if (!businesses.has(key)) businesses.set(key, emptyBusiness(key));
    return businesses.get(key);
  };
  for (const a of accounts) {
    if (a.scope === 'business' && a.is_active) business(a.business_name).accounts.push(a.id);
  }

  const personal = {
    income: 0,
    fromBusiness: 0,
    otherIncome: 0,
    expenses: 0,
    putIntoBusiness: 0,
    left: 0,
    expenseCategories: new Map(),
    incomeCategories: new Map(),
    uncategorisedExpense: 0,
  };

  // 1. Income / expense rows, per account and category.
  const rows = await query(
    `SELECT t.account_id AS account_id, t.type AS type, t.category AS category,
            COALESCE(a.currency, '') AS currency, SUM(ABS(t.amount)) AS total
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND t.date BETWEEN ? AND ?${CFT.sql}
      GROUP BY t.account_id, t.type, t.category, a.currency`,
    [userId, start, end, ...CFT.params]
  );

  for (const r of rows) {
    const amount = await conv.convert(r.total, r.currency || null);
    if (!amount) continue;
    const acct = byId.get(r.account_id);
    const category = String(r.category || '').trim() || 'Uncategorised';
    if (acct && acct.scope === 'business') {
      const b = business(acct.business_name);
      if (r.type === 'income') {
        b.income = money.add(b.income, amount);
        addTo(b.incomeCategories, category, amount);
      } else if (isOwnerPay(category)) {
        b.ownerPay = money.add(b.ownerPay, amount);
      } else {
        b.expenses = money.add(b.expenses, amount);
        addTo(b.expenseCategories, category, amount);
        if (isUncategorised(r.category)) b.uncategorisedExpense = money.add(b.uncategorisedExpense, amount);
      }
    } else if (r.type === 'income') {
      personal.income = money.add(personal.income, amount);
      if (isOwnerPay(category)) personal.fromBusiness = money.add(personal.fromBusiness, amount);
      addTo(personal.incomeCategories, category, amount);
    } else {
      personal.expenses = money.add(personal.expenses, amount);
      addTo(personal.expenseCategories, category, amount);
      if (isUncategorised(r.category)) personal.uncategorisedExpense = money.add(personal.uncategorisedExpense, amount);
    }
  }

  // 2. Transfers between own accounts that cross the business/personal line.
  const legs = await query(
    `SELECT t.transfer_id AS transfer_id, t.account_id AS account_id, t.amount AS amount,
            COALESCE(a.currency, '') AS currency
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND t.type = 'transfer' AND t.transfer_id IS NOT NULL
        AND t.date BETWEEN ? AND ?`,
    [userId, start, end]
  );
  const pairs = new Map();
  for (const l of legs) {
    const p = pairs.get(l.transfer_id) || {};
    if (Number(l.amount) < 0) p.from = l; else p.to = l;
    pairs.set(l.transfer_id, p);
  }
  for (const { from, to } of pairs.values()) {
    if (!from || !to) continue;
    const fa = byId.get(from.account_id);
    const ta = byId.get(to.account_id);
    if (!fa || !ta) continue;
    const fromBiz = fa.scope === 'business';
    const toBiz = ta.scope === 'business';
    if (fromBiz && !toBiz) {
      const amount = await conv.convert(Math.abs(from.amount), from.currency || null);
      const b = business(fa.business_name);
      b.ownerPay = money.add(b.ownerPay, amount);
      personal.income = money.add(personal.income, amount);
      personal.fromBusiness = money.add(personal.fromBusiness, amount);
      addTo(personal.incomeCategories, `Owner pay · ${b.name}`, amount);
    } else if (!fromBiz && toBiz) {
      const amount = await conv.convert(Math.abs(to.amount), to.currency || null);
      const b = business(ta.business_name);
      b.ownerIn = money.add(b.ownerIn, amount);
      personal.putIntoBusiness = money.add(personal.putIntoBusiness, amount);
    }
  }

  // 3. Totals.
  const list = [];
  const total = { income: 0, expenses: 0, profit: 0, ownerPay: 0, ownerIn: 0, kept: 0 };
  for (const b of businesses.values()) {
    b.profit = money.sub(b.income, b.expenses);
    b.kept = money.sub(money.add(b.profit, b.ownerIn), b.ownerPay);
    b.margin = b.income > 0 ? Math.round((b.profit / b.income) * 1000) / 10 : null;
    for (const f of Object.keys(total)) total[f] = money.add(total[f], b[f]);
    list.push({
      name: b.name,
      accounts: b.accounts,
      income: b.income,
      expenses: b.expenses,
      profit: b.profit,
      margin: b.margin,
      ownerPay: b.ownerPay,
      ownerIn: b.ownerIn,
      kept: b.kept,
      uncategorisedExpense: b.uncategorisedExpense,
      expenseCategories: topList(b.expenseCategories, b.expenses),
      incomeCategories: topList(b.incomeCategories, b.income),
    });
  }
  list.sort((a, b) => b.income - a.income || a.name.localeCompare(b.name));
  total.margin = total.income > 0 ? Math.round((total.profit / total.income) * 1000) / 10 : null;

  personal.otherIncome = money.sub(personal.income, personal.fromBusiness);
  personal.left = money.sub(money.sub(personal.income, personal.expenses), personal.putIntoBusiness);

  return {
    accounts,
    businesses: list,
    businessTotal: total,
    personal: {
      income: personal.income,
      fromBusiness: personal.fromBusiness,
      otherIncome: personal.otherIncome,
      expenses: personal.expenses,
      putIntoBusiness: personal.putIntoBusiness,
      left: personal.left,
      uncategorisedExpense: personal.uncategorisedExpense,
      expenseCategories: topList(personal.expenseCategories, personal.expenses),
      incomeCategories: topList(personal.incomeCategories, personal.income),
    },
  };
}

// Public entry: period (default: this month in the user's zone) + monthly series.
async function moneyMap(user, { startDate, endDate, months = 6 } = {}) {
  const userId = user.id;
  const today = dates.todayISO(dates.userTz(user));
  const start = dates.isValidYMD(startDate) ? startDate : dates.startOfMonthISO(today);
  const end = dates.isValidYMD(endDate) ? endDate : today;
  if (start > end) {
    const err = new Error('startDate must not be after endDate');
    err.status = 400;
    throw err;
  }
  const n = Math.max(0, Math.min(24, parseInt(months, 10) || 0));

  const conv = await fx.converterForUser(userId);
  const period = await computePeriod(userId, start, end, conv);

  const series = [];
  if (n > 0) {
    const thisMonth = dates.startOfMonthISO(today);
    for (let i = n - 1; i >= 0; i -= 1) {
      const mStart = dates.addMonthsISO(thisMonth, -i);
      const mEnd = i === 0 ? today : dates.endOfMonthISO(mStart);
      const p = await computePeriod(userId, mStart, mEnd, conv);
      series.push({
        month: mStart.slice(0, 7),
        businessIncome: p.businessTotal.income,
        businessExpenses: p.businessTotal.expenses,
        businessProfit: p.businessTotal.profit,
        ownerPay: p.businessTotal.ownerPay,
        personalIncome: p.personal.income,
        personalExpenses: p.personal.expenses,
        personalLeft: p.personal.left,
      });
    }
  }

  const accounts = period.accounts
    .filter((a) => a.is_active)
    .map((a) => ({
      id: a.id,
      name: a.name,
      bankName: a.bank_name || '',
      currency: a.currency,
      scope: a.scope === 'business' ? 'business' : 'personal',
      businessName: a.business_name || '',
    }));

  return {
    period: { start, end },
    currency: conv.baseCurrency,
    missingRates: conv.missingRates,
    hasBusiness: accounts.some((a) => a.scope === 'business'),
    accounts,
    businesses: period.businesses,
    businessTotal: period.businessTotal,
    personal: period.personal,
    series,
    ownerPayCategories: Array.from(OWNER_PAY_CATEGORIES).slice(0, 6),
  };
}

module.exports = { moneyMap, computePeriod, isOwnerPay, isUncategorised, OWNER_PAY_CATEGORIES, DEFAULT_BUSINESS_NAME };
