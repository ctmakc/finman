// test/forecast-sanity.test.js — wave3b/be-en-semantics.
// Repro of the audit case: 8 transactions over 3 weeks produced "+999 % /
// +$72,988 in 30 days" because a one-off salary was averaged per ACTIVE day
// and negative-stored expenses were subtracted (= added). The projection must
// use daily net flow over the observed window, report confidence 'low' with a
// reason, exclude opening balances / transfers and stay within sane bounds.
const { makeApp } = require('./helpers/app');
const dates = require('../lib/dates');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('forecast sanity: short history', () => {
  let ctx;
  let db;
  let accountId;
  const today = dates.todayISO();
  const d = (n) => dates.addDaysISO(today, -n);

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    // Account created through the API: balance 7300 -> one opening row (excluded).
    const acc = await ctx.request
      .post('/api/accounts')
      .set(AUTH(ctx.token))
      .send({ name: 'Chequing', balance: 7300, currency: 'CAD' });
    accountId = acc.body.id;

    // 8 cash-flow transactions over 3 weeks (positive magnitudes, as the stats seed does).
    const rows = [
      [d(20), 'Salary', 'Salary', 5000, 'income'],
      [d(19), 'Rent', 'Housing', 1500, 'expense'],
      [d(17), 'Groceries', 'Groceries', 120, 'expense'],
      [d(14), 'Groceries', 'Groceries', 80, 'expense'],
      [d(10), 'Fuel', 'Transport', 60, 'expense'],
      [d(7), 'Groceries', 'Groceries', 45, 'expense'],
      [d(4), 'Dinner', 'Restaurants', 200, 'expense'],
      [d(1), 'Groceries', 'Groceries', 95, 'expense'],
    ];
    for (const [date, desc, cat, amount, type] of rows) {
      await db.run(
        `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [accountId, ctx.userId, date, desc, cat, amount, type]
      );
    }
    // A transfer pair must not count either.
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type, transfer_id)
       VALUES (?, ?, ?, 'Transfer', 'Transfer', -3000, 'transfer', 'tr-1')`,
      [accountId, ctx.userId, d(2)]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('30-day projection is bounded by the observed daily flow and flagged low confidence', async () => {
    const res = await ctx.request.get('/api/forecast/balance?days=30').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const s = res.body.summary;

    expect(s.currentBalance).toBe(7300);
    expect(s.baseCurrency).toBe('CAD');
    expect(s.model).toBe('flat_average');

    // History facts.
    expect(s.history.transactionCount).toBe(8);
    expect(s.history.observedDays).toBeGreaterThanOrEqual(21);
    expect(s.history.observedDays).toBeLessThanOrEqual(22);
    expect(s.history.totalIncome).toBe(5000);
    expect(s.history.totalExpense).toBe(2100);

    // Daily flow over the window, not per active day (5000/21 ≈ 238, never 5000).
    expect(s.avgDailyIncome).toBeGreaterThan(200);
    expect(s.avgDailyIncome).toBeLessThan(260);
    expect(s.avgDailyExpense).toBeGreaterThan(90);
    expect(s.avgDailyExpense).toBeLessThan(110);

    // Bounds: the 30-day change cannot exceed income * (30 / observedDays).
    const mult = 30 / s.history.observedDays;
    expect(s.change).toBeLessThanOrEqual(5000 * mult + 1);
    expect(s.change).toBeGreaterThanOrEqual(-2100 * mult - 1);
    expect(Math.abs(s.changePercent)).toBeLessThan(100);
    expect(s.projectedBalance).toBeGreaterThan(7300);
    expect(s.projectedBalance).toBeLessThan(7300 + 5000 * mult + 1);

    // Confidence.
    expect(s.confidence.level).toBe('low');
    expect(s.confidence.reason).toMatch(/30 days/);
    expect(s.confidence.reason).toMatch(/20 transactions/);
    expect(s.confidence.reason).not.toMatch(/[А-Яа-я]/);

    // Series shape unchanged (backward compatible).
    expect(res.body.forecast).toHaveLength(31);
    expect(res.body.forecast[0].date).toBe(today);
    for (const pt of res.body.forecast) {
      expect(Number.isFinite(pt.balance)).toBe(true);
      expect(pt.balanceLower).toBeLessThanOrEqual(pt.balance + 0.01);
      expect(pt.balanceUpper).toBeGreaterThanOrEqual(pt.balance - 0.01);
    }
  });

  test('negative-stored expenses (API) reduce the balance, never add to it', async () => {
    const fresh = await makeApp();
    try {
      const acc = await fresh.request
        .post('/api/accounts')
        .set(AUTH(fresh.token))
        .send({ name: 'Card', balance: 1000, currency: 'CAD' });
      for (let i = 1; i <= 5; i++) {
        const r = await fresh.request
          .post('/api/transactions')
          .set(AUTH(fresh.token))
          .send({ accountId: acc.body.id, date: d(i * 3), amount: 100, type: 'expense', category: 'Groceries' });
        expect(r.status).toBe(201);
        expect(r.body.amount).toBe(-100); // stored negative by type
      }
      const res = await fresh.request.get('/api/forecast/balance?days=30').set(AUTH(fresh.token));
      expect(res.status).toBe(200);
      const s = res.body.summary;
      expect(s.avgDailyIncome).toBe(0);
      expect(s.avgDailyExpense).toBeGreaterThan(0);
      expect(s.history.totalExpense).toBe(500);
      expect(s.projectedBalance).toBeLessThan(s.currentBalance);
      expect(s.change).toBeGreaterThanOrEqual(-(500 * (30 / s.history.observedDays)) - 1);
      expect(s.confidence.level).toBe('low');
    } finally {
      await fresh.close();
    }
  });

  test('no history -> flat projection, low confidence with a reason', async () => {
    const fresh = await makeApp();
    try {
      await fresh.request.post('/api/accounts').set(AUTH(fresh.token)).send({ name: 'Empty', balance: 500 });
      const res = await fresh.request.get('/api/forecast/balance?days=14').set(AUTH(fresh.token));
      expect(res.status).toBe(200);
      expect(res.body.summary.projectedBalance).toBe(500);
      expect(res.body.summary.change).toBe(0);
      expect(res.body.summary.confidence.level).toBe('low');
      expect(res.body.summary.confidence.reason).toMatch(/No cash-flow transactions/);
      expect(res.body.summary.history.transactionCount).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  test('/expenses projects per category over the observed window; no opening/transfer rows', async () => {
    const res = await ctx.request.get('/api/forecast/expenses?days=30').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const cats = res.body.categories.map((c) => c.category);
    expect(cats).not.toContain('Opening balance');
    expect(cats).not.toContain('Transfer');
    const housing = res.body.categories.find((c) => c.category === 'Housing');
    expect(housing.total).toBe(1500);
    // 1500 over ~21 days -> ~71/day -> ~2143 for 30 days, never 1500 * 30.
    expect(housing.projected).toBeLessThan(2500);
    expect(housing.projected).toBeGreaterThan(1900);
    expect(res.body.totalProjected).toBeLessThan(2100 * (30 / 20) + 1);
    expect(res.body.confidence).toBe('low');
  });

  test('horizon is capped at 365 days', async () => {
    const res = await ctx.request.get('/api/forecast/balance?days=5000').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.forecast).toHaveLength(366);
  });
});
