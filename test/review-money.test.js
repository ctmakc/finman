// test/review-money.test.js — money defects closed in the pre-merge review of
// feat/finman-wave3-1010 (goals, debts, investments, transfers between
// currencies, opening rows, transaction validation, recurring schedule).
const { makeApp } = require('./helpers/app');

const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('review: money', () => {
  let ctx, db, request;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    request = ctx.request;
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  async function account(name, currency, balance = 0) {
    const r = await db.run(
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [ctx.userId, name, currency, balance, 'checking']);
    return r.id;
  }

  test('goal contribution sent as a string adds, does not concatenate', async () => {
    const SavingsGoal = require('../models/savingsGoal');
    const g = await db.run(`INSERT INTO savings_goals (user_id,name,target_amount,current_amount) VALUES (?,?,?,?)`,
      [ctx.userId, 'Trip', 1000, 50]);
    const after = await SavingsGoal.addContribution(g.id, '100');
    expect(after.current_amount).toBe(150);
    expect(after.is_completed).toBe(0);
    await expect(SavingsGoal.withdraw(g.id, '500')).rejects.toThrow('Insufficient funds');
    const w = await SavingsGoal.withdraw(g.id, '20.10');
    expect(w.current_amount).toBe(129.9);
  });

  test('debt amount cannot drop below the paid amount; is_paid follows the amount', async () => {
    const d = await db.run(
      `INSERT INTO debts (user_id,name,type,amount,paid_amount,start_date) VALUES (?,?,?,?,?,?)`,
      [ctx.userId, 'Loan', 'loan', 1000, 800, '2026-01-01']);
    const low = await request.put(`/api/debts/${d.id}`).set(auth(ctx.token)).send({ amount: 500 });
    expect(low.status).toBe(400);
    const exact = await request.put(`/api/debts/${d.id}`).set(auth(ctx.token)).send({ amount: 800 });
    expect(exact.status).toBe(200);
    const row = await db.get('SELECT amount, is_paid FROM debts WHERE id = ?', [d.id]);
    expect(row.amount).toBe(800);
    expect(row.is_paid).toBe(1);
    const over = await request.post(`/api/debts/${d.id}/payment`).set(auth(ctx.token)).send({ amount: 5 });
    expect(over.status).toBe(400);
  });

  test('selling part of a fractional position keeps the remainder', async () => {
    const Investment = require('../models/investment');
    const p = await db.run(`INSERT INTO investment_portfolios (user_id,name) VALUES (?,?)`, [ctx.userId, 'Crypto']);
    const i = await db.run(
      `INSERT INTO investments (portfolio_id,symbol,name,type,quantity,buy_price,buy_date) VALUES (?,?,?,?,?,?,?)`,
      [p.id, 'BTC', 'Bitcoin', 'crypto', 0.00512, 60000, '2026-01-01']);
    const after = await Investment.sell(i.id, 0.001, 70000);
    expect(after.quantity).toBeCloseTo(0.00412, 8);
    expect(after.is_active).toBe(1);
    await expect(Investment.sell(i.id, -1, 70000)).rejects.toThrow('Quantity must be positive');
  });

  test('transfer between currencies credits the converted amount', async () => {
    const cad = await account('CAD acc', 'CAD', 1000);
    const uah = await account('UAH acc', 'UAH', 0);
    const r = await request.post('/api/transactions/transfer').set(auth(ctx.token))
      .send({ fromAccountId: cad, toAccountId: uah, amount: 100, date: '2026-10-01' });
    expect(r.status).toBe(201);
    const c = await db.get('SELECT balance FROM accounts WHERE id = ?', [cad]);
    const u = await db.get('SELECT balance FROM accounts WHERE id = ?', [uah]);
    expect(c.balance).toBe(900);
    expect(u.balance).toBeGreaterThan(1000); // ~3000 UAH, not 100
    // Explicit toAmount wins.
    const r2 = await request.post('/api/transactions/transfer').set(auth(ctx.token))
      .send({ fromAccountId: cad, toAccountId: uah, amount: 10, toAmount: 301.5, date: '2026-10-01' });
    expect(r2.status).toBe(201);
    expect(r2.body.to.amount).toBe(301.5);
    // Editing the amount of an FX transfer is refused (one number cannot fit both legs).
    const ed = await request.put(`/api/transactions/${r2.body.from.id}`).set(auth(ctx.token)).send({ amount: 20 });
    expect(ed.status).toBe(400);
  });

  test('opening row keeps its type and sign; create rejects foreign types and bad input', async () => {
    const card = await account('Card', 'CAD', -500);
    const op = await db.run(
      `INSERT INTO transactions (account_id,user_id,date,description,category,amount,type) VALUES (?,?,?,?,?,?,?)`,
      [card, ctx.userId, '2026-01-01', 'Opening balance', 'Opening balance', -500, 'opening']);
    const flip = await request.put(`/api/transactions/${op.id}`).set(auth(ctx.token))
      .send({ description: 'Opening', type: 'income', amount: 500 });
    expect(flip.status).toBe(400);
    const desc = await request.put(`/api/transactions/${op.id}`).set(auth(ctx.token)).send({ description: 'Opening' });
    expect(desc.status).toBe(200);
    const row = await db.get('SELECT amount, type FROM transactions WHERE id = ?', [op.id]);
    expect(row).toEqual({ amount: -500, type: 'opening' });
    const acc = await db.get('SELECT balance FROM accounts WHERE id = ?', [card]);
    expect(acc.balance).toBe(-500);

    for (const body of [
      { type: 'opening', amount: 5, date: '2026-10-01' },
      { type: 'foo', amount: 5, date: '2026-10-01' },
      { type: 'expense', amount: 'abc', date: '2026-10-01' },
      { type: 'expense', amount: 5, date: '2026-02-31' },
    ]) {
      const r = await request.post('/api/transactions').set(auth(ctx.token)).send({ accountId: card, ...body });
      expect(r.status).toBe(400);
    }
  });

  test('recurring: paying early advances from the due date; Sunday survives', async () => {
    const RecurringPayment = require('../models/recurringPayment');
    const dates = require('../lib/dates');
    const acc = await account('Bills', 'CAD', 0);
    const today = dates.todayISO();
    const due = dates.addDaysISO(today, 5);
    const r = await db.run(
      `INSERT INTO recurring_payments (user_id,account_id,name,amount,type,frequency,start_date,next_payment_date)
       VALUES (?,?,?,?,?,?,?,?)`,
      [ctx.userId, acc, 'Rent', 100, 'expense', 'monthly', due, due]);
    const paid = await RecurringPayment.markAsPaid(r.id, ctx.userId, false);
    expect(paid.nextPaymentDate).toBe(dates.addMonthsISO(due, 1));

    const sun = await RecurringPayment.create({
      userId: ctx.userId, accountId: acc, name: 'Market', amount: 20, type: 'expense',
      frequency: 'weekly', dayOfWeek: 0, startDate: '2026-10-07',
    });
    expect(sun.day_of_week).toBe(0);
    // Weekly on a weekday: the next occurrence after Wed 2026-10-14 is Wed 2026-10-21.
    expect(RecurringPayment._calculateNextPaymentDateRaw('2026-10-14', 'weekly', null, 3, true)).toBe('2026-10-21');
    expect(RecurringPayment._calculateNextPaymentDateRaw('2026-10-07', 'weekly', null, 0, false)).toBe('2026-10-11');
  });

  test('POST /transactions is idempotent by clientTxId / Idempotency-Key', async () => {
    const acc = await account('Idem', 'CAD', 0);
    const body = { accountId: acc, amount: 12.5, type: 'expense', date: '2026-10-02', description: 'coffee' };
    const a = await request.post('/api/transactions').set(auth(ctx.token)).send({ ...body, clientTxId: 'c-1' });
    expect(a.status).toBe(201);
    const b = await request.post('/api/transactions').set(auth(ctx.token)).send({ ...body, clientTxId: 'c-1' });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    const c = await request.post('/api/transactions').set({ ...auth(ctx.token), 'Idempotency-Key': 'c-1' }).send(body);
    expect(c.body.id).toBe(a.body.id);
    const [d, e] = await Promise.all([
      request.post('/api/transactions').set(auth(ctx.token)).send({ ...body, clientTxId: 'c-2' }),
      request.post('/api/transactions').set(auth(ctx.token)).send({ ...body, clientTxId: 'c-2' }),
    ]);
    expect(d.body.id).toBe(e.body.id);
    const row = await db.get('SELECT balance FROM accounts WHERE id = ?', [acc]);
    expect(row.balance).toBe(-25);
  });

  test('account currency must be a plain code; lower case is normalised', async () => {
    const bad = await request.post('/api/accounts').set(auth(ctx.token)).send({ name: 'X', currency: 'US$', balance: 1 });
    expect(bad.status).toBe(400);
    const ok = await request.post('/api/accounts').set(auth(ctx.token)).send({ name: 'Y', currency: 'eur', balance: 1 });
    expect(ok.status).toBe(201);
    const row = await db.get('SELECT currency FROM accounts WHERE name = ?', ['Y']);
    expect(row.currency).toBe('EUR');
  });
});
