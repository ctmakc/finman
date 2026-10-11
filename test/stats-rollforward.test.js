// test/stats-rollforward.test.js — wave3/stats: «следующий платёж» подписок и
// регулярных платежей докатывается от start_date до первой даты >= сегодня
// (раньше подписка 2024 года показывала «2024-02-15 ⚠️ Просрочен»).
const { makeApp } = require('./helpers/app');
const dates = require('../lib/dates');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('subscriptions: next_billing_date rolls forward', () => {
  let ctx;
  let db;
  const today = dates.todayISO();

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('POST с start_date 2024-02-15 monthly -> next_billing_date >= today, день 15', async () => {
    const res = await ctx.request
      .post('/api/subscriptions')
      .set(AUTH(ctx.token))
      .send({ name: 'Old Netflix', amount: 15, currency: 'CAD', billing_cycle: 'monthly', start_date: '2024-02-15' });
    expect(res.status).toBe(201);
    const row = await db.get(`SELECT next_billing_date FROM subscriptions WHERE id = ?`, [res.body.id]);
    expect(row.next_billing_date >= today).toBe(true);
    expect(row.next_billing_date.slice(8, 10)).toBe('15');
    expect(dates.diffDays(today, row.next_billing_date)).toBeLessThan(32);
  });

  test('POST со start_date в будущем -> next_billing_date = start_date', async () => {
    const future = dates.addDaysISO(today, 20);
    const res = await ctx.request
      .post('/api/subscriptions')
      .set(AUTH(ctx.token))
      .send({ name: 'Future', amount: 5, billing_cycle: 'yearly', start_date: future });
    expect(res.status).toBe(201);
    const row = await db.get(`SELECT next_billing_date FROM subscriptions WHERE id = ?`, [res.body.id]);
    expect(row.next_billing_date).toBe(future);
  });

  test('GET / докатывает устаревшие автопродляемые подписки; ручные остаются просроченными', async () => {
    const auto = await db.run(
      `INSERT INTO subscriptions (user_id, name, amount, billing_cycle, start_date, next_billing_date, auto_renew, is_active)
       VALUES (?, 'Stale auto', 10, 'monthly', '2024-01-10', '2024-02-10', 1, 1)`,
      [ctx.userId]
    );
    const manual = await db.run(
      `INSERT INTO subscriptions (user_id, name, amount, billing_cycle, start_date, next_billing_date, auto_renew, is_active)
       VALUES (?, 'Stale manual', 10, 'monthly', '2024-01-10', '2024-02-10', 0, 1)`,
      [ctx.userId]
    );
    const res = await ctx.request.get('/api/subscriptions').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const a = res.body.find((s) => s.id === auto.id);
    const m = res.body.find((s) => s.id === manual.id);
    expect(a.next_billing_date >= today).toBe(true);
    expect(a.next_billing_date.slice(8, 10)).toBe('10');
    expect(a.daysUntilBilling).toBeGreaterThanOrEqual(0);
    expect(a.isOverdue).toBe(false);
    expect(m.next_billing_date).toBe('2024-02-10');
    expect(m.isOverdue).toBe(true);
    expect(m.daysUntilBilling).toBeLessThan(0);
  });

  test('POST /:id/payment -> 200, next_billing_date = оплата + цикл (не раньше сегодня)', async () => {
    const created = await ctx.request
      .post('/api/subscriptions')
      .set(AUTH(ctx.token))
      .send({ name: 'Paid one', amount: 9, billing_cycle: 'monthly', start_date: '2024-03-05' });
    expect(created.status).toBe(201);
    const res = await ctx.request
      .post(`/api/subscriptions/${created.body.id}/payment`)
      .set(AUTH(ctx.token))
      .send({ amount: 9 });
    expect(res.status).toBe(200);
    const row = await db.get(`SELECT next_billing_date FROM subscriptions WHERE id = ?`, [created.body.id]);
    expect(row.next_billing_date > today).toBe(true);
    // Серия привязана к дню start_date (5-е): оплата сегодня -> следующее 5-е
    // через месяц, а не «сегодня + месяц» (дрейф дня списания).
    expect(row.next_billing_date).toBe(dates.rollForward(dates.addMonthsISO(today, 1, 5), 'monthly', today, 5));
    const pay = await db.get(`SELECT payment_date FROM subscription_payments WHERE subscription_id = ?`, [created.body.id]);
    expect(pay.payment_date).toBe(today);
    // Старая дата оплаты -> следующая всё равно >= сегодня.
    const old = await ctx.request
      .post(`/api/subscriptions/${created.body.id}/payment`)
      .set(AUTH(ctx.token))
      .send({ amount: 9, payment_date: '2024-04-05' });
    expect(old.status).toBe(200);
    const row2 = await db.get(`SELECT next_billing_date FROM subscriptions WHERE id = ?`, [created.body.id]);
    expect(row2.next_billing_date >= today).toBe(true);
    expect(row2.next_billing_date.slice(8, 10)).toBe('05');
  });

  test('billingInfo: сегодня -> 0 дней / isDueToday', () => {
    const Subscription = require('../models/subscription');
    expect(Subscription.billingInfo({ next_billing_date: today }, today)).toEqual({ daysUntilBilling: 0, isDueToday: true, isOverdue: false });
    expect(Subscription.nextAfterPayment('2026-01-31', 'monthly', '2026-02-10')).toBe('2026-02-28');
    expect(Subscription.nextAfterPayment('2024-01-15', 'monthly', '2026-10-10')).toBe('2026-10-15');
  });
});

describe('recurring: next_payment_date rolls forward', () => {
  let ctx;
  let db;
  let accountId;
  const today = dates.todayISO();

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    const acc = await db.run(`INSERT INTO accounts (user_id, name, balance, currency) VALUES (?, 'Main', 1000, 'CAD')`, [ctx.userId]);
    accountId = acc.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('POST аренда с startDate 2024-12-01 / dayOfMonth 1 -> ближайшее 1-е число >= today, не «Просрочено»', async () => {
    const res = await ctx.request
      .post('/api/recurring')
      .set(AUTH(ctx.token))
      .send({ accountId, name: 'Rent', amount: 1500, type: 'expense', frequency: 'monthly', dayOfMonth: 1, startDate: '2024-12-01' });
    expect(res.status).toBe(201);
    const p = res.body.payment;
    expect(p.next_payment_date >= today).toBe(true);
    expect(p.next_payment_date.slice(8, 10)).toBe('01');
    expect(dates.diffDays(today, p.next_payment_date)).toBeLessThan(32);
  });

  test('POST weekly со startDate в прошлом -> тот же день недели, дата >= today', async () => {
    const res = await ctx.request
      .post('/api/recurring')
      .set(AUTH(ctx.token))
      .send({ accountId, name: 'Gym', amount: 20, frequency: 'weekly', startDate: '2024-02-15' });
    expect(res.status).toBe(201);
    const p = res.body.payment;
    expect(p.next_payment_date >= today).toBe(true);
    expect(dates.parseISO(p.next_payment_date).getUTCDay()).toBe(dates.parseISO('2024-02-15').getUTCDay());
  });

  test('startDate в будущем остаётся как есть; GET /overdue пуст', async () => {
    const future = dates.addDaysISO(today, 12);
    const res = await ctx.request
      .post('/api/recurring')
      .set(AUTH(ctx.token))
      .send({ accountId, name: 'Future', amount: 1, frequency: 'monthly', startDate: future });
    expect(res.status).toBe(201);
    expect(res.body.payment.next_payment_date).toBe(future);
    const overdue = await ctx.request.get('/api/recurring/overdue').set(AUTH(ctx.token));
    expect(overdue.status).toBe(200);
    expect(overdue.body.length === 0 || (overdue.body.payments || []).length === 0).toBe(true);
  });

  test('calculateNextPaymentDate: markAsPaid-семантика (skipCurrent) не ломается', () => {
    const RecurringPayment = require('../models/recurringPayment');
    expect(RecurringPayment.calculateNextPaymentDate('2026-10-10', 'monthly', 10, null, true, '2026-10-10')).toBe('2026-11-10');
    expect(RecurringPayment.calculateNextPaymentDate('2024-12-01', 'monthly', 1, null, false, '2026-10-10')).toBe('2026-11-01');
    expect(RecurringPayment.calculateNextPaymentDate('2026-10-20', 'monthly', 20, null, false, '2026-10-10')).toBe('2026-10-20');
  });
});
