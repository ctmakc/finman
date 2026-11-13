// lib/demoStarter.js — "Explore with demo data" for a brand-new user.
//
// Different from lib/demoSeed.js (a separate demo *user* for staging and
// juries): this loads a small, clearly tagged sample household INTO the
// signed-in user's own workspace, so the empty dashboard turns into a working
// one in a second. Every account it creates has accounts.is_demo = 1 and the
// whole set is removed by removeDemo() (DELETE /api/onboarding/demo).
//
// 90 days ending today (America/Toronto), deterministic per user id + day.

'use strict';

const { query, get, run, transaction } = require('../db/database');
const dates = require('./dates');
const money = require('./money');

const TZ = 'America/Toronto';

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

function isoAddDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Rows for the two demo accounts. Signs: expense < 0, income > 0.
function buildDemoRows(today, seed) {
  const rnd = makeRng(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const amt = (lo, hi) => money.round(lo + rnd() * (hi - lo));
  const start = isoAddDays(today, -89);
  const chq = [];
  const card = [];
  const push = (list, date, description, category, amount) => {
    if (date < start || date > today) return;
    list.push({ date, description, category, amount: money.round(amount), type: amount >= 0 ? 'income' : 'expense' });
  };

  for (let i = 0; i < 90; i += 1) {
    const date = isoAddDays(start, i);
    const d = new Date(`${date}T00:00:00Z`);
    const dom = d.getUTCDate();
    const dow = d.getUTCDay();

    // Paid on the 1st and the 15th, so "this month" always shows income on the
    // dashboard right after loading (a bi-weekly pay day can miss the month so far).
    if (dom === 1 || dom === 15) push(chq, date, 'PAYROLL DEPOSIT — NORTHWIND LTD', 'Salary', 2690);
    if (dom === 1) push(chq, date, 'RENT — MAPLE PROPERTY MGMT', 'Housing', -1850);
    if (dom === 3) push(chq, date, 'HYDRO OTTAWA', 'Utilities', -amt(78, 112));
    if (dom === 5) push(card, date, 'ROGERS WIRELESS', 'Phone & Internet', -85);
    if (dom === 9) push(card, date, 'NETFLIX.COM', 'Subscriptions', -20.99);
    if (dom === 14) push(card, date, 'SPOTIFY P0B2', 'Subscriptions', -11.99);
    if (dom === 18) push(card, date, 'GOODLIFE FITNESS', 'Health', -54.99);
    if (dom === 21) push(chq, date, 'CARD PAYMENT — VISA', 'Transfer', 0); // placeholder, dropped below
    if (dom === 25) push(chq, date, 'TFSA CONTRIBUTION', 'Investments', -300);

    // Groceries twice a week, coffee and lunches on weekdays, gas weekly.
    if (dow === 2 || dow === 6) push(card, date, pick(['LOBLAWS #1123', 'FARM BOY', 'METRO 412', 'COSTCO WHOLESALE']), 'Groceries', -amt(46, 168));
    if (dow >= 1 && dow <= 5 && rnd() < 0.45) push(card, date, pick(['TIM HORTONS #2210', 'BRIDGEHEAD COFFEE', 'STARBUCKS 4471']), 'Food & Dining', -amt(3.4, 9.8));
    if (dow >= 1 && dow <= 5 && rnd() < 0.2) push(card, date, pick(['FRESHII', 'PHO BO GA LA', 'SUBWAY 30122']), 'Food & Dining', -amt(13, 24));
    if (dow === 0) push(card, date, pick(['PETRO-CANADA', 'SHELL C02371', 'ESSO 0912']), 'Fuel', -amt(48, 72));
    if (dow === 6 && rnd() < 0.35) push(card, date, pick(['AMAZON.CA', 'CANADIAN TIRE #233', 'IKEA OTTAWA', 'WINNERS 211']), 'Shopping', -amt(24, 140));
    if (dow === 5 && rnd() < 0.4) push(card, date, pick(['THE ROYAL OAK', 'CINEPLEX ODEON', 'UBER EATS']), 'Entertainment', -amt(22, 74));
    if (rnd() < 0.05) push(card, date, 'SHOPPERS DRUG MART', 'Health', -amt(12, 46));
    if (rnd() < 0.04) push(card, date, 'OC TRANSPO PRESTO', 'Transport', -amt(20, 50));
  }

  return { chq: chq.filter((r) => r.amount !== 0), card };
}

async function hasDemo(userId) {
  const row = await get('SELECT COUNT(*) AS c FROM accounts WHERE user_id = ? AND is_demo = 1 AND is_active = 1', [userId]);
  return Boolean(row && row.c);
}

async function demoAccountIds(userId) {
  const rows = await query('SELECT id FROM accounts WHERE user_id = ? AND is_demo = 1', [userId]);
  return rows.map((r) => r.id);
}

// Idempotent: a second call returns the existing demo accounts.
async function loadDemo(userId, { currency } = {}) {
  const existing = await demoAccountIds(userId);
  if (existing.length) {
    const c = await get(`SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND account_id IN (${existing.map(() => '?').join(',')})`, [userId, ...existing]);
    return { created: false, accountIds: existing, transactions: (c && c.c) || 0 };
  }
  const cur = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'CAD';
  const today = dates.todayISO(TZ);
  const { chq, card } = buildDemoRows(today, (Number(userId) * 2654435761 + Number(today.replace(/-/g, ''))) >>> 0);

  const accountIds = [];
  let inserted = 0;
  await transaction(async () => {
    const plan = [
      { name: 'Demo · Everyday chequing', type: 'checking', opening: 3200, rows: chq },
      { name: 'Demo · Visa card', type: 'credit', opening: 0, rows: card },
    ];
    for (const acc of plan) {
      const balance = money.add(acc.opening, money.sum(acc.rows.map((r) => r.amount)));
      const res = await run(
        `INSERT INTO accounts (user_id, name, bank_name, currency, balance, account_type, is_active, is_demo)
         VALUES (?, ?, 'Demo data', ?, ?, ?, 1, 1)`,
        [userId, acc.name, cur, balance, acc.type]
      );
      accountIds.push(res.id);
      for (const r of acc.rows) {
        await run(
          `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [res.id, userId, r.date, r.description, r.category, r.amount, r.type]
        );
        inserted += 1;
      }
    }
  });
  return { created: true, accountIds, transactions: inserted };
}

// Hard delete: demo rows must not linger in stats, exports or AI context.
// Rows in any table with a foreign key to a demo account go too.
async function removeDemo(userId) {
  const ids = await demoAccountIds(userId);
  if (!ids.length) return { removed: false, accounts: 0, transactions: 0 };
  const ph = ids.map(() => '?').join(',');
  let txCount = 0;
  await transaction(async () => {
    const tables = await query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    for (const { name } of tables) {
      if (name === 'accounts' || name === 'transactions') continue;
      const cols = await query(`PRAGMA foreign_key_list("${name}")`);
      const refCols = new Set(cols.filter((c) => c.table === 'accounts').map((c) => c.from));
      for (const col of refCols) {
        await run(`DELETE FROM "${name}" WHERE "${col}" IN (${ph})`, ids);
      }
    }
    const res = await run(`DELETE FROM transactions WHERE user_id = ? AND account_id IN (${ph})`, [userId, ...ids]);
    txCount = res.changes || 0;
    await run(`DELETE FROM accounts WHERE user_id = ? AND id IN (${ph})`, [userId, ...ids]);
  });
  return { removed: true, accounts: ids.length, transactions: txCount };
}

module.exports = { buildDemoRows, loadDemo, removeDemo, hasDemo, demoAccountIds };
