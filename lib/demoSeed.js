// lib/demoSeed.js — demo household for staging / screenshots / grant juries.
//
// Why: the staging host (MMIX-Apps-US, `site-run`) starts the container without a
// persistent volume, so the SQLite file is recreated empty on every deploy. An empty
// finance app is useless to a reviewer. With DEMO_SEED_ON_EMPTY=1 the server seeds
// a realistic Canadian household (6 months of activity) at boot — but ONLY when the
// users table is empty, so a second boot on the same file does nothing and a real
// instance with accounts is never touched.
//
// Everything goes through the model layer (Account.createWithOpeningBalance,
// Transaction.create / createTransfer, Debt.addPayment, ...) so balances, the
// 'opening' ledger row and transfer legs follow the same rules as the UI. The only
// raw INSERT is subscriptions: the app has no Subscription.create (routes/
// subscriptions.js inserts directly) and the seed mirrors that statement.
//
// Dates are relative to today in America/Toronto (lib/dates.js, UTC arithmetic —
// no `new Date().setMonth()` DST trap). Amounts come from a seeded PRNG, so two
// seeds of the same calendar day produce the same ledger (stable tests, stable
// screenshots).
//
// Exports:
//   seedIfEmpty()        -> { seeded, reason?, userId?, counts?, seeded_at? }
//   seedDemo({ force })  -> seeds when the demo user is missing (force ignores other users)
//   bootHook(logger)     -> what server.js calls after initDatabase(); never throws
//   seedInfo()           -> { demo, seed_on_empty, seeded_at, demo_user } for /api/health
//   getState()           -> in-memory boot state (tests)

'use strict';

const { query, get, run } = require('../db/database');
const dates = require('./dates');
const money = require('./money');
const flags = require('./demoFlag');

const User = require('../models/user');
const Account = require('../models/account');
const Transaction = require('../models/transaction');
const Budget = require('../models/budget');
const SavingsGoal = require('../models/savingsGoal');
const Debt = require('../models/debt');
const Investment = require('../models/investment');
const RecurringPayment = require('../models/recurringPayment');
const Subscription = require('../models/subscription');
const CategoryRule = require('../models/categoryRule');
const Family = require('../models/family');
const Currency = require('../models/currency');

const DEMO_TZ = 'America/Toronto';
const BASE_CURRENCY = 'CAD';

// ---------------------------------------------------------------------------
// Deterministic pseudo-random numbers (mulberry32). Same seed -> same ledger.
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Calendar helpers (all 'YYYY-MM-DD', UTC arithmetic via lib/dates).
// ---------------------------------------------------------------------------
function weekday(iso) {
  return dates.parseISO(iso).getUTCDay(); // 0 = Sunday
}

// First date >= iso that falls on `dow` (0..6).
function nextWeekday(iso, dow) {
  const diff = (dow - weekday(iso) + 7) % 7;
  return dates.addDaysISO(iso, diff);
}

// Every `stepDays` from `first` while <= last.
function eachStep(first, last, stepDays) {
  const out = [];
  for (let d = first; d <= last; d = dates.addDaysISO(d, stepDays)) out.push(d);
  return out;
}

// Day `day` of each month from startMonth (YYYY-MM-01) while <= last.
function eachMonthDay(startMonth, last, day) {
  const out = [];
  for (let m = 0; m < 14; m += 1) {
    const d = dates.addMonthsISO(startMonth, m, day);
    if (d > last) break;
    out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The household plan: builds the list of transactions in memory.
// ---------------------------------------------------------------------------
function buildPlan(today) {
  const rng = makeRng(seedFromString(`finman-demo-${today}`));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const between = (min, max) => money.round(min + rng() * (max - min));
  const chance = (p) => rng() < p;

  const thisMonth = dates.startOfMonthISO(today);
  const start = dates.addMonthsISO(thisMonth, -6); // first day, 6 months back
  const tx = []; // { acc, date, description, category, amount, type }
  const add = (acc, date, description, category, amount, type = 'expense') => {
    if (date > today || date < start) return;
    tx.push({ acc, date, description, category, amount: money.round(amount), type });
  };

  // Payroll: biweekly on Fridays into chequing.
  const payDates = eachStep(nextWeekday(start, 5), today, 14);
  for (const d of payDates) add('chequing', d, 'Payroll — Shopify Inc.', 'Salary', 2480.0, 'income');

  // Weekly groceries on Saturdays, credit card.
  const groceryStores = [
    ['Loblaws', 110, 190],
    ['Farm Boy', 70, 140],
    ['Costco Wholesale', 180, 260],
    ['Metro', 85, 160],
    ['Food Basics', 60, 120],
  ];
  for (const d of eachStep(nextWeekday(start, 6), today, 7)) {
    const [store, lo, hi] = pick(groceryStores);
    add('credit', d, store, 'Groceries', between(lo, hi));
  }

  // Fixed monthly bills.
  for (const d of eachMonthDay(start, today, 1)) add('chequing', d, 'Rent — Minto Apartments', 'Housing', 1950.0);
  for (const d of eachMonthDay(start, today, 15)) add('chequing', d, 'Hydro Ottawa', 'Utilities', between(88, 142));
  for (const d of eachMonthDay(start, today, 20)) add('chequing', d, 'Bell Canada — Fibe Internet', 'Internet', 89.99);
  for (const d of eachMonthDay(start, today, 8)) add('credit', d, 'Rogers Wireless', 'Phone', 65.0);
  for (const d of eachMonthDay(start, today, 1)) add('chequing', d, 'OC Transpo — Presto monthly pass', 'Transport', 128.75);

  // Subscriptions (credit card).
  const subs = [
    ['Netflix', 3, 18.99],
    ['Spotify Premium', 11, 11.99],
    ['Apple iCloud+', 17, 3.99],
    ['GoodLife Fitness', 1, 59.99],
  ];
  for (const [name, day, amount] of subs) {
    for (const d of eachMonthDay(start, today, day)) add('credit', d, name, 'Subscriptions', amount);
  }

  // Dining out: one or two visits a week.
  const dining = [
    ['Tim Hortons', 6, 14],
    ['Starbucks', 7, 12],
    ['Bridgehead Coffee', 5, 10],
    ['Pho Bo Ga La', 25, 45],
    ['Uber Eats', 30, 55],
    ['The Keg Steakhouse', 60, 120],
    ['Shawarma Palace', 14, 28],
  ];
  for (const week of eachStep(start, today, 7)) {
    const visits = chance(0.55) ? 2 : 1;
    for (let i = 0; i < visits; i += 1) {
      const [place, lo, hi] = pick(dining);
      add('credit', dates.addDaysISO(week, Math.floor(rng() * 7)), place, 'Dining out', between(lo, hi));
    }
  }

  // Fuel twice a month, a pharmacy run, a parcel, a movie night.
  for (const d of eachMonthDay(start, today, 6)) add('credit', d, 'Petro-Canada', 'Transport', between(55, 85));
  for (const d of eachMonthDay(start, today, 21)) add('credit', d, 'Shell', 'Transport', between(50, 80));
  for (const d of eachMonthDay(start, today, 12)) add('credit', d, 'Shoppers Drug Mart', 'Health', between(18, 60));
  for (const d of eachMonthDay(start, today, 18)) add('credit', d, 'Amazon.ca', 'Shopping', between(25, 120));
  for (const d of eachMonthDay(start, today, 26)) add('credit', d, 'Cineplex', 'Entertainment', between(28, 45));

  // Irregular events.
  add('chequing', dates.addMonthsISO(start, 1, 9), 'IKEA Ottawa', 'Home', 240.0);
  add('chequing', dates.addMonthsISO(start, 2, 14), 'CRA — income tax refund', 'Other income', 1240.0, 'income');
  add('credit', dates.addMonthsISO(start, 3, 2), 'Alta Vista Animal Hospital', 'Pets', 185.0);
  add('chequing', dates.addMonthsISO(start, 4, 22), 'Freelance invoice — brand design', 'Other income', 650.0, 'income');
  add('credit', dates.addMonthsISO(start, 5, 7), 'Indigo — birthday gift', 'Gifts', 80.0);

  // USD savings earns monthly interest.
  for (const d of eachMonthDay(start, today, 28)) add('usd', d, 'Interest earned', 'Interest', between(5.8, 6.4), 'income');

  // Car loan: 5 monthly payments (day 5) from chequing, linked to the debt.
  const loanDates = eachMonthDay(start, today, 5).slice(-5);
  const loanPayment = 412.3;

  // Credit card payments: two transfers chequing -> credit card.
  const transferDates = [dates.addMonthsISO(start, 2, 25), dates.addMonthsISO(start, 4, 25)].filter((d) => d <= today);
  const transfers = transferDates.map((d, i) => ({ date: d, amount: i === 0 ? 2600.0 : 2400.0 }));

  tx.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { start, thisMonth, tx, payDates, loanDates, loanPayment, transfers };
}

// ---------------------------------------------------------------------------
// Boot state (what /api/health reports).
// ---------------------------------------------------------------------------
const state = {
  enabled: false,
  inProgress: false, // seeding right now: health reports seeded_at only when done
  outcome: null, // 'disabled' | 'seeded' | 'skipped' | 'failed'
  reason: null,
  seededAt: null,
  userId: null,
  error: null,
};

async function findDemoUser() {
  return get('SELECT id, username, created_at FROM users WHERE email = ? OR username = ?', [
    flags.DEMO_USER.email,
    flags.DEMO_USER.username,
  ]);
}

async function usersCount() {
  const row = await get('SELECT COUNT(*) AS n FROM users');
  return row ? Number(row.n) : 0;
}

// ---------------------------------------------------------------------------
// The seed itself.
// ---------------------------------------------------------------------------
async function seedHousehold() {
  const today = dates.todayISO(DEMO_TZ);
  const plan = buildPlan(today);
  const password = flags.demoPassword();
  const counts = { transactions: 0, transfers: 0, accounts: 0 };

  // Users ---------------------------------------------------------------------
  const user = await User.create({ ...flags.DEMO_USER, password });
  const partner = await User.create({ ...flags.DEMO_PARTNER, password });
  for (const u of [user, partner]) {
    await run('UPDATE users SET timezone = ? WHERE id = ?', [DEMO_TZ, u.id]);
    await Currency.getUserSettings(u.id);
    await Currency.updateUserSettings(u.id, {
      baseCurrency: BASE_CURRENCY,
      displayCurrencies: ['CAD', 'USD', 'EUR'],
      autoConvert: true,
    });
  }
  // Offline FX so USD positions convert into the CAD base without a network call.
  await Currency.saveRate('USD', 'CAD', 1.37, 'demo-seed', today);
  await Currency.saveRate('CAD', 'USD', 0.73, 'demo-seed', today);
  await Currency.saveRate('EUR', 'CAD', 1.49, 'demo-seed', today);
  await Currency.saveRate('CAD', 'EUR', 0.67, 'demo-seed', today);

  // Accounts (opening balances dated the day before the window starts) ---------
  const openingDate = dates.addDaysISO(plan.start, -1);
  const accounts = {};
  const accountDefs = [
    ['chequing', { name: 'Everyday Chequing', bankName: 'RBC Royal Bank', currency: 'CAD', accountType: 'checking', balance: 3200.0 }],
    ['credit', { name: 'Cash Back Visa', bankName: 'TD Canada Trust', currency: 'CAD', accountType: 'credit', balance: -850.0 }],
    ['usd', { name: 'USD Savings', bankName: 'Tangerine', currency: 'USD', accountType: 'savings', balance: 4000.0 }],
  ];
  for (const [key, def] of accountDefs) {
    accounts[key] = await Account.createWithOpeningBalance({ ...def, userId: user.id, openingDate });
    counts.accounts += 1;
  }

  // Debt first, so loan payments can link to it ---------------------------------
  const debt = await Debt.create({
    user_id: user.id,
    name: 'Car loan — 2022 Honda Civic',
    description: 'Fixed-rate auto loan, 60 months',
    type: 'loan',
    amount: 18500.0,
    interest_rate: 6.9,
    currency: 'CAD',
    counterparty: 'Scotiabank Auto Finance',
    start_date: dates.addMonthsISO(plan.start, -8),
    due_date: dates.addMonthsISO(today, 36),
  });

  // Transactions ----------------------------------------------------------------
  for (const t of plan.tx) {
    await Transaction.create({
      userId: user.id,
      accountId: accounts[t.acc].id,
      date: t.date,
      description: t.description,
      category: t.category,
      amount: t.amount,
      type: t.type,
    });
    counts.transactions += 1;
  }
  for (const d of plan.loanDates) {
    const row = await Transaction.create({
      userId: user.id,
      accountId: accounts.chequing.id,
      date: d,
      description: 'Scotiabank — auto loan payment',
      category: 'Loan payment',
      amount: plan.loanPayment,
      type: 'expense',
    });
    await Debt.addPayment(debt.id, plan.loanPayment, 'principal', 'Monthly payment', row.id, d);
    counts.transactions += 1;
  }
  for (const tr of plan.transfers) {
    await Transaction.createTransfer({
      userId: user.id,
      fromAccountId: accounts.chequing.id,
      toAccountId: accounts.credit.id,
      amount: tr.amount,
      date: tr.date,
      description: 'Credit card payment',
    });
    counts.transfers += 1;
  }

  // Budgets (current month) -------------------------------------------------------
  const budgetDefs = [
    ['Groceries', 'Groceries', 800.0],
    ['Dining out', 'Dining out', 300.0],
  ];
  for (const [name, category, amount] of budgetDefs) {
    await Budget.create({ userId: user.id, name, category, amount, period: 'monthly', startDate: plan.thisMonth, currency: 'CAD', notifyAtPercent: 80 });
  }
  await Budget.recalculateSpent(user.id);
  counts.budgets = budgetDefs.length;

  // Goals -------------------------------------------------------------------------
  const emergency = await SavingsGoal.create({
    user_id: user.id,
    name: 'Emergency fund',
    description: 'Three months of household expenses',
    target_amount: 15000.0,
    currency: 'CAD',
    target_date: dates.addMonthsISO(today, 12),
    category: 'safety',
    icon: 'shield',
    color: '#2E7D5B',
  });
  for (let i = 0; i < 6; i += 1) await SavingsGoal.addContribution(emergency.id, 500.0, 'Monthly auto-save');
  const trip = await SavingsGoal.create({
    user_id: user.id,
    name: 'Trip to Lisbon',
    description: 'Flights and ten nights in May',
    target_amount: 4500.0,
    currency: 'CAD',
    target_date: dates.addMonthsISO(today, 8),
    category: 'travel',
    icon: 'plane',
    color: '#C96A2B',
  });
  for (let i = 0; i < 3; i += 1) await SavingsGoal.addContribution(trip.id, 350.0, 'Trip fund');
  counts.goals = 2;

  // Investments -------------------------------------------------------------------
  const portfolio = await Investment.createPortfolio({
    user_id: user.id,
    name: 'TFSA — Wealthsimple',
    description: 'Long-term index portfolio',
    currency: 'CAD',
  });
  const holdings = [
    { symbol: 'XEQT', name: 'iShares Core Equity ETF Portfolio', type: 'etf', quantity: 120, buy_price: 28.4, current_price: 31.15, currency: 'CAD', buy_date: dates.addMonthsISO(plan.start, 1, 3) },
    { symbol: 'VFV', name: 'Vanguard S&P 500 Index ETF', type: 'etf', quantity: 45, buy_price: 118.2, current_price: 142.6, currency: 'CAD', buy_date: dates.addMonthsISO(plan.start, 1, 3) },
    { symbol: 'BTC', name: 'Bitcoin', type: 'crypto', quantity: 0.08, buy_price: 61500.0, current_price: 84200.0, currency: 'USD', buy_date: dates.addMonthsISO(plan.start, 2, 19) },
  ];
  for (const h of holdings) await Investment.addInvestment({ ...h, portfolio_id: portfolio.id, fee: 0, notes: null });
  counts.investments = holdings.length;

  // Recurring payments ------------------------------------------------------------
  const recurring = [
    { name: 'Rent', amount: 1950.0, type: 'expense', category: 'Housing', frequency: 'monthly', dayOfMonth: 1, accountId: accounts.chequing.id },
    { name: 'Hydro Ottawa', amount: 115.0, type: 'expense', category: 'Utilities', frequency: 'monthly', dayOfMonth: 15, accountId: accounts.chequing.id },
    { name: 'Bell Fibe Internet', amount: 89.99, type: 'expense', category: 'Internet', frequency: 'monthly', dayOfMonth: 20, accountId: accounts.chequing.id },
    { name: 'Rogers Wireless', amount: 65.0, type: 'expense', category: 'Phone', frequency: 'monthly', dayOfMonth: 8, accountId: accounts.credit.id },
    { name: 'Car loan payment', amount: plan.loanPayment, type: 'expense', category: 'Loan payment', frequency: 'monthly', dayOfMonth: 5, accountId: accounts.chequing.id },
    { name: 'Payroll — Shopify', amount: 2480.0, type: 'income', category: 'Salary', frequency: 'biweekly', accountId: accounts.chequing.id, startDate: plan.payDates[plan.payDates.length - 1] || plan.start },
  ];
  for (const r of recurring) {
    await RecurringPayment.create({ userId: user.id, startDate: plan.start, notifyBefore: 3, autoCreate: false, ...r });
  }
  counts.recurring = recurring.length;

  // Subscriptions (no model-level create exists; mirrors routes/subscriptions.js) -----
  const subDefs = [
    ['Netflix', 'Standard plan', 18.99, 'Entertainment', 'tv', '#E50914', 3, 'https://netflix.com'],
    ['Spotify Premium', 'Duo plan', 11.99, 'Entertainment', 'music', '#1DB954', 11, 'https://spotify.com'],
    ['Apple iCloud+', '200 GB', 3.99, 'Software', 'cloud', '#3B82F6', 17, 'https://icloud.com'],
    ['GoodLife Fitness', 'All-club membership', 59.99, 'Health', 'dumbbell', '#D92D20', 1, 'https://goodlifefitness.com'],
  ];
  for (const [name, description, amount, category, icon, color, day, url] of subDefs) {
    const startDate = dates.addMonthsISO(plan.start, 0, day);
    await run(
      `INSERT INTO subscriptions (user_id, name, description, amount, currency, billing_cycle, category, icon, color, start_date, next_billing_date, reminder_days, auto_renew, account_id, url, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.id, name, description, amount, 'CAD', 'monthly', category, icon, color, startDate, Subscription.firstBillingDate(startDate, 'monthly', today), 3, 1, accounts.credit.id, url, null]
    );
  }
  counts.subscriptions = subDefs.length;

  // Rules -------------------------------------------------------------------------
  await CategoryRule.create(user.id, { priority: 10, match_field: 'description', match_op: 'contains', match_value: 'Loblaws', set_category: 'Groceries' });
  await CategoryRule.create(user.id, { priority: 20, match_field: 'description', match_op: 'contains', match_value: 'Netflix', set_category: 'Subscriptions' });
  counts.rules = 2;

  // Family: owner + partner, partner has a small chequing account ----------------------
  const family = await Family.create({ name: 'Demo household', ownerId: user.id, description: 'Shared budget for two' });
  await Family.joinByCode(family.invite_code, partner.id);
  const partnerAcc = await Account.createWithOpeningBalance({
    userId: partner.id,
    name: 'Partner Chequing',
    bankName: 'Desjardins',
    currency: 'CAD',
    accountType: 'checking',
    balance: 1200.0,
    openingDate,
  });
  const partnerTx = [
    [dates.addMonthsISO(plan.start, 5, 2), 'Payroll — City of Ottawa', 'Salary', 1890.0, 'income'],
    [dates.addMonthsISO(plan.start, 5, 4), 'Shared groceries — Farm Boy', 'Groceries', 96.4, 'expense'],
    [dates.addMonthsISO(plan.start, 5, 16), 'Payroll — City of Ottawa', 'Salary', 1890.0, 'income'],
    [dates.addMonthsISO(plan.start, 5, 19), 'Hydro share', 'Utilities', 60.0, 'expense'],
    [dates.addMonthsISO(plan.start, 6, 2), 'Payroll — City of Ottawa', 'Salary', 1890.0, 'income'],
    [dates.addMonthsISO(plan.start, 6, 3), 'Bus pass', 'Transport', 128.75, 'expense'],
  ];
  for (const [date, description, category, amount, type] of partnerTx) {
    if (date > today) continue;
    await Transaction.create({ userId: partner.id, accountId: partnerAcc.id, date, description, category, amount, type });
  }
  counts.family_members = 2;

  const demoRow = await findDemoUser();
  return { userId: user.id, partnerId: partner.id, seeded_at: demoRow ? demoRow.created_at : null, counts, window: { start: plan.start, end: today } };
}

// Seeds only when the users table is empty (the staging contract).
async function seedIfEmpty() {
  const n = await usersCount();
  if (n > 0) {
    return { seeded: false, reason: 'users_exist', users: n };
  }
  const result = await seedHousehold();
  return { seeded: true, ...result };
}

// CLI variant: seeds when the demo user is missing. Without `force` it still
// refuses to touch a database that already has users.
async function seedDemo({ force = false } = {}) {
  const existing = await findDemoUser();
  if (existing) return { seeded: false, reason: 'demo_exists', userId: existing.id, seeded_at: existing.created_at };
  if (!force) return seedIfEmpty();
  const result = await seedHousehold();
  return { seeded: true, ...result };
}

// Called by server.js after initDatabase() resolved (migrations applied).
// Must never throw: a seed failure is logged, the server keeps serving.
async function bootHook(logger) {
  const log = logger || console;
  state.enabled = flags.isSeedOnEmpty();
  try {
    const existing = await findDemoUser();
    if (existing) {
      state.seededAt = existing.created_at;
      state.userId = existing.id;
    }
    if (!state.enabled) {
      state.outcome = 'disabled';
      return { seeded: false, reason: 'disabled' };
    }
    state.inProgress = true;
    let result;
    try {
      result = await seedIfEmpty();
    } finally {
      state.inProgress = false;
    }
    if (result.seeded) {
      state.outcome = 'seeded';
      state.seededAt = result.seeded_at;
      state.userId = result.userId;
      if (log.info) log.info({ counts: result.counts, window: result.window }, 'demo seed: household created');
    } else {
      state.outcome = 'skipped';
      state.reason = result.reason;
      if (log.info) log.info({ reason: result.reason, users: result.users }, 'demo seed: skipped');
    }
    return result;
  } catch (err) {
    state.outcome = 'failed';
    state.error = err && err.message;
    if (log.error) log.error({ err }, 'demo seed: failed');
    return { seeded: false, reason: 'error', error: state.error };
  }
}

// For /api/health: demo flags + when the demo user was created (null = no demo user).
// Cheap: one lookup, cached once a demo user is known.
async function seedInfo() {
  if (state.inProgress) {
    // The demo user row exists from the first step of the seed; report the
    // household only once every table is in place.
    return { demo: flags.isDemo(), seed_on_empty: flags.isSeedOnEmpty(), seeded_at: null, demo_user: null, seeding: true };
  }
  if (!state.seededAt) {
    try {
      const existing = await findDemoUser();
      if (existing) {
        state.seededAt = existing.created_at;
        state.userId = existing.id;
      }
    } catch (e) {
      /* health must not fail on a DB hiccup */
    }
  }
  return {
    demo: flags.isDemo(),
    seed_on_empty: flags.isSeedOnEmpty(),
    seeded_at: state.seededAt || null,
    demo_user: state.seededAt ? flags.DEMO_USER.username : null,
  };
}

function getState() {
  return { ...state };
}

module.exports = {
  DEMO_TZ,
  BASE_CURRENCY,
  buildPlan,
  seedIfEmpty,
  seedDemo,
  bootHook,
  seedInfo,
  getState,
  _internal: { makeRng, seedFromString, eachStep, eachMonthDay, nextWeekday, findDemoUser, usersCount },
};
