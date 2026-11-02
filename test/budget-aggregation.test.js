// test/budget-aggregation.test.js — budget periods and "spent" aggregation
// across month/year boundaries, user time zones and account currencies, plus
// per-user isolation of the /api/budgets routes.
//
// No network: axios is mocked to fail, so any FX lookup that is not served by
// the local currency_rates table would surface as a missing rate, never as a
// real HTTP call.

jest.mock('axios', () => {
  const fail = jest.fn(async () => {
    throw new Error('network disabled in tests');
  });
  const instance = { get: fail, post: fail, request: fail };
  return { ...instance, create: () => instance, default: instance };
});

const { makeApp } = require('./helpers/app');

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

async function makeUser(db, username, timezone = null) {
  const jwt = require('jsonwebtoken');
  const config = require('../config/config');
  const ins = await db.run(
    'INSERT INTO users (username, email, password, full_name, timezone) VALUES (?, ?, ?, ?, ?)',
    [username, `${username}@example.com`, 'x', username, timezone]
  );
  return { id: ins.id, token: jwt.sign({ id: ins.id }, config.jwtSecret, { expiresIn: '1h' }) };
}

async function makeAccount(db, userId, currency) {
  const ins = await db.run(
    'INSERT INTO accounts (user_id, name, currency, balance, account_type) VALUES (?, ?, ?, 0, ?)',
    [userId, `${currency} account`, currency, 'checking']
  );
  return ins.id;
}

async function addTx(db, { userId, accountId, date, amount, type = 'expense', category = 'Groceries' }) {
  const signed = type === 'expense' ? -Math.abs(amount) : Math.abs(amount);
  await db.run(
    'INSERT INTO transactions (account_id, user_id, date, description, category, amount, type) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [accountId, userId, date, 'test', category, signed, type]
  );
}

async function addBudget(db, userId, { name = 'Food', category = 'Groceries', amount = 500, period = 'monthly', currency = 'CAD', startDate = '2025-01-01', endDate = null }) {
  const ins = await db.run(
    `INSERT INTO budgets (user_id, name, category, amount, spent, period, start_date, end_date, currency, notify_at_percent, is_active)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 80, 1)`,
    [userId, name, category, amount, period, startDate, endDate, currency]
  );
  return ins.id;
}

describe('Budget.getPeriodDates — calendar edges', () => {
  let ctx;
  let Budget;
  beforeAll(async () => {
    ctx = await makeApp();
    Budget = require('../models/budget');
  });
  afterAll(async () => ctx && ctx.close());

  test('monthly: February in leap and common years, 31-day months', () => {
    expect(Budget.getPeriodDates({ period: 'monthly' }, '2028-02-15')).toEqual({ startDate: '2028-02-01', endDate: '2028-02-29' });
    expect(Budget.getPeriodDates({ period: 'monthly' }, '2026-02-28')).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
    expect(Budget.getPeriodDates({ period: 'monthly' }, '2026-10-31')).toEqual({ startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(Budget.getPeriodDates({ period: 'monthly' }, '2026-12-01')).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31' });
  });

  test('weekly: Monday..Sunday, including a week that spans New Year', () => {
    // 2026-01-01 is a Thursday.
    expect(Budget.getPeriodDates({ period: 'weekly' }, '2026-01-01')).toEqual({ startDate: '2025-12-29', endDate: '2026-01-04' });
    // Sunday belongs to the week that started the previous Monday.
    expect(Budget.getPeriodDates({ period: 'weekly' }, '2026-11-01')).toEqual({ startDate: '2026-10-26', endDate: '2026-11-01' });
    // Monday starts a new week.
    expect(Budget.getPeriodDates({ period: 'weekly' }, '2026-11-02')).toEqual({ startDate: '2026-11-02', endDate: '2026-11-08' });
  });

  test('daily / yearly / custom', () => {
    expect(Budget.getPeriodDates({ period: 'daily' }, '2026-03-08')).toEqual({ startDate: '2026-03-08', endDate: '2026-03-08' });
    expect(Budget.getPeriodDates({ period: 'yearly' }, '2026-07-04')).toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(Budget.getPeriodDates({ period: 'custom', start_date: '2026-05-10', end_date: '2026-06-09' }, '2026-05-20'))
      .toEqual({ startDate: '2026-05-10', endDate: '2026-06-09' });
    // Open-ended custom budget runs until "today".
    expect(Budget.getPeriodDates({ period: 'custom', start_date: '2026-05-10', end_date: null }, '2026-05-20'))
      .toEqual({ startDate: '2026-05-10', endDate: '2026-05-20' });
  });

  test('nextPeriodStart walks months without day drift', () => {
    expect(Budget.nextPeriodStart('monthly', '2026-01-01')).toBe('2026-02-01');
    expect(Budget.nextPeriodStart('monthly', '2026-12-01')).toBe('2027-01-01');
    expect(Budget.nextPeriodStart('yearly', '2026-01-01')).toBe('2027-01-01');
    expect(Budget.nextPeriodStart('weekly', '2026-12-28')).toBe('2027-01-04');
  });
});

describe('lib/dates.todayISO — the user\'s calendar day, not UTC', () => {
  const dates = require('../lib/dates');

  test('the same instant is a different day in Toronto, Kyiv and Auckland', () => {
    const instant = new Date('2026-11-01T03:30:00Z');
    expect(dates.todayISO('America/Toronto', instant)).toBe('2026-10-31');
    expect(dates.todayISO('Europe/Kyiv', instant)).toBe('2026-11-01');
    expect(dates.todayISO('UTC', instant)).toBe('2026-11-01');
    const noon = new Date('2026-10-31T12:00:00Z');
    expect(dates.todayISO('Pacific/Auckland', noon)).toBe('2026-11-01');
    expect(dates.todayISO('America/Los_Angeles', noon)).toBe('2026-10-31');
  });

  test('DST end in Toronto (2026-11-01 06:00Z) does not shift the day', () => {
    expect(dates.todayISO('America/Toronto', new Date('2026-11-01T03:59:00Z'))).toBe('2026-10-31');
    expect(dates.todayISO('America/Toronto', new Date('2026-11-01T04:00:00Z'))).toBe('2026-11-01');
    expect(dates.todayISO('America/Toronto', new Date('2026-11-01T06:30:00Z'))).toBe('2026-11-01');
    expect(dates.todayISO('America/Toronto', new Date('2026-11-02T04:59:00Z'))).toBe('2026-11-01');
    expect(dates.todayISO('America/Toronto', new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-02');
  });

  test('a bogus timezone falls back to the default zone instead of throwing', () => {
    const instant = new Date('2026-06-15T12:00:00Z');
    expect(dates.todayISO('Not/AZone', instant)).toBe(dates.todayISO(dates.DEFAULT_TZ, instant));
    expect(dates.userTz({ timezone: 'Not/AZone' })).toBe(dates.DEFAULT_TZ);
    expect(dates.userTz({ timezone: 'Europe/Kyiv' })).toBe('Europe/Kyiv');
  });
});

describe('Budget.recalculateSpent — which transactions count', () => {
  let ctx;
  let db;
  let Budget;
  let alice;
  let bob;
  let aliceCad;
  let aliceUah;
  let bobCad;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    Budget = require('../models/budget');
    alice = await makeUser(db, 'alice', 'America/Toronto');
    bob = await makeUser(db, 'bob', 'Europe/Kyiv');
    aliceCad = await makeAccount(db, alice.id, 'CAD');
    aliceUah = await makeAccount(db, alice.id, 'UAH');
    bobCad = await makeAccount(db, bob.id, 'CAD');

    // October (previous month)
    await addTx(db, { userId: alice.id, accountId: aliceCad, date: '2026-10-31', amount: 50 });
    // November
    await addTx(db, { userId: alice.id, accountId: aliceCad, date: '2026-11-01', amount: 20.1 });
    await addTx(db, { userId: alice.id, accountId: aliceCad, date: '2026-11-30', amount: 0.2 });
    // Not counted: other category, income, next month, and another user's spending.
    await addTx(db, { userId: alice.id, accountId: aliceCad, date: '2026-11-05', amount: 999, category: 'Rent' });
    await addTx(db, { userId: alice.id, accountId: aliceCad, date: '2026-11-05', amount: 777, type: 'income' });
    await addTx(db, { userId: alice.id, accountId: aliceCad, date: '2026-12-01', amount: 33 });
    await addTx(db, { userId: bob.id, accountId: bobCad, date: '2026-11-02', amount: 400 });
  });
  afterAll(async () => ctx && ctx.close());

  test('monthly budget only sums its own month, category, type and user', async () => {
    const id = await addBudget(db, alice.id, { name: 'Food' });
    await Budget.recalculateSpent(alice.id, null, '2026-11-15');
    let b = await Budget.findById(id, alice.id);
    expect(b.spent).toBe(20.3);
    expect(b.remaining).toBe(479.7);

    // Seen from 31 Oct (e.g. Toronto evening while UTC is already November).
    await Budget.recalculateSpent(alice.id, null, '2026-10-31');
    b = await Budget.findById(id, alice.id);
    expect(b.spent).toBe(50);
  });

  test('yearly and weekly budgets aggregate across the month boundary', async () => {
    const yearly = await addBudget(db, alice.id, { name: 'Food year', period: 'yearly' });
    const weekly = await addBudget(db, alice.id, { name: 'Food week', period: 'weekly' });
    await Budget.recalculateSpent(alice.id, null, '2026-11-01'); // Sunday: week 26 Oct .. 1 Nov
    expect((await Budget.findById(yearly, alice.id)).spent).toBe(50 + 20.1 + 0.2 + 33);
    expect((await Budget.findById(weekly, alice.id)).spent).toBe(70.1);
  });

  test('a budget without category counts every expense of the user only', async () => {
    const all = await addBudget(db, alice.id, { name: 'Everything', category: null, amount: 5000 });
    await Budget.recalculateSpent(alice.id, null, '2026-11-15');
    // 20.10 + 0.20 + 999 (Rent); Bob's 400 must not leak in.
    expect((await Budget.findById(all, alice.id)).spent).toBe(1019.3);
  });

  test('expenses on a foreign-currency account are converted to the budget currency', async () => {
    await db.run(
      'INSERT INTO currency_rates (from_currency, to_currency, rate, date) VALUES (?, ?, ?, ?)',
      ['UAH', 'CAD', 0.033, '2026-01-01']
    );
    await addTx(db, { userId: alice.id, accountId: aliceUah, date: '2026-11-10', amount: 3000, category: 'Travel' });
    const travel = await addBudget(db, alice.id, { name: 'Travel', category: 'Travel', amount: 200 });
    await Budget.recalculateSpent(alice.id, null, '2026-11-15');
    expect((await Budget.findById(travel, alice.id)).spent).toBe(99);
  });

  test('a budget that ended or has not started yet is not recalculated', async () => {
    const ended = await addBudget(db, alice.id, { name: 'Old', endDate: '2026-09-30' });
    const future = await addBudget(db, alice.id, { name: 'Later', startDate: '2027-01-01' });
    await Budget.recalculateSpent(alice.id, null, '2026-11-15');
    expect((await Budget.findById(ended, alice.id)).spent).toBe(0);
    expect((await Budget.findById(future, alice.id)).spent).toBe(0);
  });
});

describe('/api/budgets — per-user isolation', () => {
  let ctx;
  let db;
  let owner;
  let stranger;
  let budgetId;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    owner = { id: ctx.userId, token: ctx.token };
    stranger = await makeUser(db, 'stranger');
    budgetId = await addBudget(db, owner.id, { name: 'Private' });
  });
  afterAll(async () => ctx && ctx.close());

  test('every route requires a token', async () => {
    expect((await ctx.request.get('/api/budgets')).status).toBe(401);
    expect((await ctx.request.get(`/api/budgets/${budgetId}`)).status).toBe(401);
    expect((await ctx.request.post('/api/budgets').send({ name: 'x', amount: 1 })).status).toBe(401);
    expect((await ctx.request.delete(`/api/budgets/${budgetId}`)).status).toBe(401);
  });

  test('another user cannot read, change, recalculate or delete the budget', async () => {
    const h = AUTH(stranger.token);
    expect((await ctx.request.get(`/api/budgets/${budgetId}`).set(h)).status).toBe(404);
    expect((await ctx.request.put(`/api/budgets/${budgetId}`).set(h).send({ amount: 1 })).status).toBe(404);
    expect((await ctx.request.post(`/api/budgets/${budgetId}/recalculate`).set(h)).status).toBe(404);
    expect((await ctx.request.delete(`/api/budgets/${budgetId}?hard=true`).set(h)).status).toBe(404);

    const list = await ctx.request.get('/api/budgets').set(h);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    const row = await db.get('SELECT amount, is_active FROM budgets WHERE id = ?', [budgetId]);
    expect(row).toEqual({ amount: 500, is_active: 1 });
  });

  test('the owner still sees it', async () => {
    const res = await ctx.request.get(`/api/budgets/${budgetId}`).set(AUTH(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Private');
  });
});
