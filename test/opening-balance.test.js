// test/opening-balance.test.js — wave3b/be-en-semantics: opening balance is an
// explicit ledger kind (type='opening', category/description 'Opening balance'),
// stored once, included in the account balance and excluded from every
// income/expense aggregate (analytics, forecast, widgets, reports, insights,
// digest, anomalies, budgets).
const { makeApp } = require('./helpers/app');
const txFilter = require('../lib/txFilter');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('opening balance semantics', () => {
  let ctx;
  let db;
  let accountId;
  const today = new Date().toISOString().split('T')[0];

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    const res = await ctx.request
      .post('/api/accounts')
      .set(AUTH(ctx.token))
      .send({ name: 'Chequing', balance: 2500, currency: 'CAD' });
    expect(res.status).toBe(201);
    accountId = res.body.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('lib/txFilter exports the opening constants and predicates', () => {
    expect(txFilter.OPENING_TYPE).toBe('opening');
    expect(txFilter.OPENING_CATEGORY).toBe('Opening balance');
    expect(txFilter.OPENING_CATEGORIES).toContain('Начальный баланс');
    expect(txFilter.isOpening({ type: 'opening', category: 'x' })).toBe(true);
    expect(txFilter.isOpening({ type: 'income', category: 'Начальный баланс' })).toBe(true);
    expect(txFilter.isOpening({ type: 'income', category: 'Salary' })).toBe(false);
    expect(txFilter.isCashflow({ type: 'transfer', category: 'Transfer' })).toBe(false);
    expect(txFilter.isCashflow({ type: 'expense', category: 'Groceries' })).toBe(true);
  });

  test('balance 2500 is stored once; exactly one opening row in English', async () => {
    const acc = await ctx.request.get(`/api/accounts/${accountId}`).set(AUTH(ctx.token));
    expect(acc.status).toBe(200);
    expect(acc.body.balance).toBe(2500);

    const rows = await db.query(
      'SELECT type, amount, category, description FROM transactions WHERE account_id = ?',
      [accountId]
    );
    expect(rows).toEqual([
      { type: 'opening', amount: 2500, category: 'Opening balance', description: 'Opening balance' },
    ]);
    // SUM(amount) per account equals the stored balance (reconcile invariant).
    const sum = await db.get('SELECT SUM(amount) AS s FROM transactions WHERE account_id = ?', [accountId]);
    expect(sum.s).toBe(2500);
  });

  test('analytics overview / categories: income 0, expense 0, no opening category', async () => {
    const ov = await ctx.request
      .get(`/api/analytics/overview?startDate=2000-01-01&endDate=${today}`)
      .set(AUTH(ctx.token));
    expect(ov.status).toBe(200);
    expect(ov.body.income).toBe(0);
    expect(ov.body.expense).toBe(0);
    expect(ov.body.transactionCount).toBe(0);
    expect(ov.body.totalBalance).toBe(2500);

    const inc = await ctx.request.get('/api/analytics/income-by-category').set(AUTH(ctx.token));
    expect(inc.status).toBe(200);
    expect(inc.body.map((c) => c.category)).not.toContain('Opening balance');
  });

  test('forecast: avgDailyIncome 0, projected balance stays at 2500 without cash flow', async () => {
    const res = await ctx.request.get('/api/forecast/balance?days=30').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.summary.avgDailyIncome).toBe(0);
    expect(res.body.summary.currentBalance).toBe(2500);
    expect(res.body.summary.projectedBalance).toBe(2500);
  });

  test('widgets cashflow / income / recent: opening excluded from totals', async () => {
    const cf = await ctx.request.get('/api/widgets/cashflow/data?period=year').set(AUTH(ctx.token));
    expect(cf.status).toBe(200);
    expect(cf.body.income).toBe(0);
    expect(cf.body.expense).toBe(0);
    const inc = await ctx.request.get('/api/widgets/income/data?period=year').set(AUTH(ctx.token));
    expect(inc.body.total).toBe(0);
    const bal = await ctx.request.get('/api/widgets/balance/data').set(AUTH(ctx.token));
    expect(bal.body.total).toBe(2500);
  });

  test('reports: monthly / category / tax ignore the opening row', async () => {
    const monthly = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({ report_type: 'monthly', period_start: '2000-01-01', period_end: today });
    expect(monthly.status).toBe(200);
    expect(monthly.body.data.summary.income).toBe(0);
    expect(monthly.body.data.summary.expenses).toBe(0);
    expect(monthly.body.data.transactionCount).toBe(0);

    const tax = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({ report_type: 'tax', period_start: '2000-01-01', period_end: today });
    expect(tax.status).toBe(200);
    expect(tax.body.data.totalIncome).toBe(0);
  });

  test('legacy rows (type income + category "Начальный баланс") are still excluded', async () => {
    const legacy = await ctx.request
      .post('/api/accounts')
      .set(AUTH(ctx.token))
      .send({ name: 'Legacy' });
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, 'Начальный баланс', 'Начальный баланс', 900, 'income')`,
      [legacy.body.id, ctx.userId, today]
    );
    const ov = await ctx.request
      .get(`/api/analytics/overview?startDate=2000-01-01&endDate=${today}`)
      .set(AUTH(ctx.token));
    expect(ov.body.income).toBe(0);
    const anomalyService = require('../services/anomalyService');
    const anomalies = await anomalyService.detectForUser(ctx.userId);
    expect(anomalies.filter((a) => a.type === 'amount_outlier')).toHaveLength(0);
  });

  test('net worth includes the opening balances', async () => {
    const res = await ctx.request.get('/api/networth/current').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.assetsBreakdown.accounts).toBeGreaterThanOrEqual(2500);
  });
});
