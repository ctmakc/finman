// test/money-map.test.js — "Business & personal" (management accounting, 21.11.2026).
//   - accounts carry scope personal|business + business_name (migration 031), API sets them;
//   - /api/analytics/money-map: profit per business before owner pay, owner pay from
//     transfers and owner-pay categories, personal income incl. what came from the business,
//     where the money goes, monthly series, no opening balances, other users invisible.
const { makeApp } = require('./helpers/app');
const dates = require('../lib/dates');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('money map: business vs personal', () => {
  let ctx;
  let db;
  const today = dates.todayISO();
  const monthStart = dates.startOfMonthISO(today);
  const lastMonthMid = dates.addDaysISO(dates.addMonthsISO(monthStart, -1, 1), 9);
  const ids = {};

  async function tx(accountId, date, category, amount, type, transferId = null, userId = ctx.userId) {
    return db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type, transfer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, userId, date, category, category, amount, type, transferId]
    );
  }

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');

    // Accounts through the API: one personal, one business (named), one business without a name.
    const p = await ctx.request.post('/api/accounts').set(AUTH(ctx.token))
      .send({ name: 'Personal chequing', currency: 'CAD', balance: 0 });
    expect(p.status).toBe(201);
    ids.personal = p.body.id;
    const b = await ctx.request.post('/api/accounts').set(AUTH(ctx.token))
      .send({ name: 'Studio account', currency: 'CAD', balance: 1000, scope: 'business', businessName: 'Studio' });
    expect(b.status).toBe(201);
    ids.studio = b.body.id;
    const c = await ctx.request.post('/api/accounts').set(AUTH(ctx.token))
      .send({ name: 'Side gig', currency: 'CAD', balance: 0 });
    ids.side = c.body.id;
    // Turn it into a business afterwards (PUT), no name -> "My business".
    const put = await ctx.request.put(`/api/accounts/${ids.side}`).set(AUTH(ctx.token))
      .send({ scope: 'business' });
    expect(put.status).toBe(200);
    expect(put.body.scope).toBe('business');

    // Studio this month: 5000 income, 1200 rent, 300 software, 800 owner pay by category.
    await tx(ids.studio, monthStart, 'Client payments', 5000, 'income');
    await tx(ids.studio, monthStart, 'Rent', -1200, 'expense');
    await tx(ids.studio, monthStart, 'Software', -300, 'expense');
    await tx(ids.studio, monthStart, 'Owner pay', -800, 'expense');
    // Studio -> personal transfer 1000 (owner pay), personal -> side gig 200 (money put in).
    await tx(ids.studio, monthStart, 'Transfer', -1000, 'transfer', 'tr-pay');
    await tx(ids.personal, monthStart, 'Transfer', 1000, 'transfer', 'tr-pay');
    await tx(ids.personal, monthStart, 'Transfer', -200, 'transfer', 'tr-in');
    await tx(ids.side, monthStart, 'Transfer', 200, 'transfer', 'tr-in');
    // Side gig: 300 income, 50 uncategorised expense.
    await tx(ids.side, monthStart, 'Sales', 300, 'income');
    await tx(ids.side, monthStart, '', -50, 'expense');
    // Personal: 800 owner pay arrives as income, 1500 other income, 900 groceries, 400 rent.
    await tx(ids.personal, monthStart, 'Owner pay', 800, 'income');
    await tx(ids.personal, monthStart, 'Salary', 1500, 'income');
    await tx(ids.personal, monthStart, 'Groceries', -900, 'expense');
    await tx(ids.personal, monthStart, 'Rent', -400, 'expense');
    // Last month: studio 2000 income / 500 expense.
    await tx(ids.studio, lastMonthMid, 'Client payments', 2000, 'income');
    await tx(ids.studio, lastMonthMid, 'Rent', -500, 'expense');

    // Another user's business account and money must stay invisible.
    const other = await db.run(`INSERT INTO users (username, email, password) VALUES (?, ?, ?)`, ['othermm', 'other-mm@finman.test', 'x']);
    const oa = await db.run(
      `INSERT INTO accounts (user_id, name, balance, currency, scope, business_name) VALUES (?, ?, ?, ?, 'business', 'Studio')`,
      [other.id, 'Other studio', 0, 'CAD']
    );
    await tx(oa.id, monthStart, 'Client payments', 99999, 'income', null, other.id);
  });

  afterAll(async () => {
    if (ctx && ctx.close) await ctx.close();
  });

  test('scope is validated and stored', async () => {
    const bad = await ctx.request.put(`/api/accounts/${ids.side}`).set(AUTH(ctx.token)).send({ scope: 'corporate' });
    expect(bad.status).toBe(400);
    const got = await ctx.request.get(`/api/accounts/${ids.studio}`).set(AUTH(ctx.token));
    expect(got.body.scope).toBe('business');
    expect(got.body.business_name).toBe('Studio');
    const personal = await ctx.request.get(`/api/accounts/${ids.personal}`).set(AUTH(ctx.token));
    expect(personal.body.scope).toBe('personal');
  });

  test('business profit is counted before owner pay; owner pay = category + transfers', async () => {
    const res = await ctx.request.get('/api/analytics/money-map').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const m = res.body;
    expect(m.hasBusiness).toBe(true);
    const studio = m.businesses.find((b) => b.name === 'Studio');
    expect(studio.income).toBe(5000); // the 1000 opening balance is not income
    expect(studio.expenses).toBe(1500);
    expect(studio.profit).toBe(3500);
    expect(studio.margin).toBe(70);
    expect(studio.ownerPay).toBe(1800);
    expect(studio.kept).toBe(1700);
    expect(studio.expenseCategories[0]).toMatchObject({ category: 'Rent', amount: 1200, share: 80 });
    expect(studio.expenseCategories.map((c) => c.category)).not.toContain('Owner pay');

    const side = m.businesses.find((b) => b.name === 'My business');
    expect(side.income).toBe(300);
    expect(side.expenses).toBe(50);
    expect(side.ownerIn).toBe(200);
    expect(side.uncategorisedExpense).toBe(50);

    expect(m.businessTotal.profit).toBe(3750);
    expect(m.businessTotal.ownerPay).toBe(1800);
  });

  test('personal side: income incl. owner pay, expenses, money put into the business, what is left', async () => {
    const res = await ctx.request.get('/api/analytics/money-map').set(AUTH(ctx.token));
    const p = res.body.personal;
    expect(p.income).toBe(3300); // 800 + 1500 + 1000 transfer from the studio
    expect(p.fromBusiness).toBe(1800);
    expect(p.otherIncome).toBe(1500);
    expect(p.expenses).toBe(1300);
    expect(p.putIntoBusiness).toBe(200);
    expect(p.left).toBe(1800);
    expect(p.expenseCategories[0]).toMatchObject({ category: 'Groceries', amount: 900 });
  });

  test('monthly series covers the last months; custom range works; bad range = 400', async () => {
    const res = await ctx.request.get('/api/analytics/money-map?months=3').set(AUTH(ctx.token));
    expect(res.body.series).toHaveLength(3);
    const last = res.body.series[res.body.series.length - 1];
    expect(last.businessProfit).toBe(3750);
    const prev = res.body.series[res.body.series.length - 2];
    expect(prev.businessProfit).toBe(1500);

    const lm = dates.addMonthsISO(monthStart, -1, 1);
    const range = await ctx.request
      .get(`/api/analytics/money-map?startDate=${lm}&endDate=${dates.endOfMonthISO(lm)}&months=0`)
      .set(AUTH(ctx.token));
    expect(range.status).toBe(200);
    expect(range.body.series).toHaveLength(0);
    expect(range.body.businesses.find((b) => b.name === 'Studio').profit).toBe(1500);

    const bad = await ctx.request
      .get(`/api/analytics/money-map?startDate=${today}&endDate=${lm}`)
      .set(AUTH(ctx.token));
    expect(bad.status).toBe(400);
  });

  test('MCP / in-app assistant tool get_business_and_personal returns the same numbers', async () => {
    const { TX_TOOLS } = require('../services/mcp/txTools');
    const tool = TX_TOOLS.find((t) => t.name === 'get_business_and_personal');
    expect(tool.annotations.readOnlyHint).toBe(true);
    const out = await tool.run(ctx.userId, { months: 2 });
    expect(out.has_business).toBe(true);
    const studio = out.businesses.find((b) => b.name === 'Studio');
    expect(studio).toMatchObject({ income: 5000, expenses: 1500, profit: 3500, owner_pay: 1800, stayed_in_business: 1700 });
    expect(out.personal).toMatchObject({ income: 3300, from_business: 1800, left: 1800 });
    expect(out.by_month).toHaveLength(2);
    await expect(tool.run(ctx.userId, { start_date: today, end_date: '2000-01-01' })).rejects.toThrow(/start_date/);
    const list = TX_TOOLS.find((t) => t.name === 'list_accounts');
    const accts = await list.run(ctx.userId);
    expect(accts.accounts.find((a) => a.id === ids.studio)).toMatchObject({ scope: 'business', business_name: 'Studio' });
  });

  test('requires auth', async () => {
    const res = await ctx.request.get('/api/analytics/money-map');
    expect(res.status).toBe(401);
  });
});
