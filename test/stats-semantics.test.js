// test/stats-semantics.test.js — wave3/stats: календарь/аналитика/прогноз/виджеты.
//   - /api/calendar/events падал SQLITE_ERROR (next_execution_date) -> сетка не рисовалась;
//   - месяц-к-месяцу и прогноз считали «Начальный баланс» и переводы доходом (+658 %);
//   - /api/forecast/goal|debt читали несуществующие колонки date;
//   - проценты без потолка.
const { makeApp } = require('./helpers/app');
const dates = require('../lib/dates');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('stats semantics: calendar / analytics / forecast / widgets', () => {
  let ctx;
  let db;
  let accountId;
  let goalId;
  let debtId;
  const today = dates.todayISO();
  const thisMonthStart = dates.startOfMonthISO(today);
  const lastMonthStart = dates.addMonthsISO(thisMonthStart, -1, 1);
  const lastMonthMid = dates.addDaysISO(lastMonthStart, 10);

  async function tx(date, category, amount, type, extra = {}) {
    return db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type, transfer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, ctx.userId, date, extra.description || category, category, amount, type, extra.transfer_id || null]
    );
  }

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, balance, currency) VALUES (?, ?, ?, ?)`,
      [ctx.userId, 'Main', 55000, 'CAD']
    );
    accountId = acc.id;

    // Начальный баланс — записан транзакцией (routes/accounts.js), это НЕ доход.
    await tx(thisMonthStart, 'Начальный баланс', 50000, 'income');
    // Перевод между счетами — две ноги type='transfer', это НЕ доход/расход.
    await tx(thisMonthStart, 'Transfer', -700, 'transfer', { transfer_id: 'tr-1' });
    await tx(thisMonthStart, 'Transfer', 700, 'transfer', { transfer_id: 'tr-1' });
    // Реальный денежный поток: этот месяц 2000 / 500, прошлый 1000 / 400.
    await tx(thisMonthStart, 'Salary', 2000, 'income');
    await tx(thisMonthStart, 'Groceries', 500, 'expense');
    await tx(lastMonthMid, 'Salary', 1000, 'income');
    await tx(lastMonthMid, 'Groceries', 400, 'expense');

    // Регулярный платёж через 3 дня, подписка через 5 дней.
    await db.run(
      `INSERT INTO recurring_payments (user_id, account_id, name, amount, type, frequency, start_date, next_payment_date, is_active)
       VALUES (?, ?, ?, ?, 'expense', 'monthly', ?, ?, 1)`,
      [ctx.userId, accountId, 'Rent', 1200, '2026-01-01', dates.addDaysISO(today, 3)]
    );
    await db.run(
      `INSERT INTO subscriptions (user_id, name, amount, currency, billing_cycle, start_date, next_billing_date, is_active)
       VALUES (?, ?, ?, 'CAD', 'monthly', ?, ?, 1)`,
      [ctx.userId, 'Netflix', 20, '2026-01-01', dates.addDaysISO(today, 5)]
    );
    // Своё событие календаря.
    await db.run(
      `INSERT INTO calendar_events (user_id, title, event_type, event_date) VALUES (?, ?, 'reminder', ?)`,
      [ctx.userId, 'Dentist', dates.addDaysISO(today, 2)]
    );

    // Цель с двумя пополнениями и долг с двумя платежами (прогноз).
    const goal = await db.run(
      `INSERT INTO savings_goals (user_id, name, target_amount, current_amount) VALUES (?, ?, ?, ?)`,
      [ctx.userId, 'Trip', 3000, 600]
    );
    goalId = goal.id;
    await db.run(`INSERT INTO goal_contributions (goal_id, amount, created_at) VALUES (?, ?, ?)`, [goalId, 300, `${dates.addDaysISO(today, -20)} 10:00:00`]);
    await db.run(`INSERT INTO goal_contributions (goal_id, amount, created_at) VALUES (?, ?, ?)`, [goalId, 300, `${dates.addDaysISO(today, -5)} 10:00:00`]);
    const debt = await db.run(
      `INSERT INTO debts (user_id, name, type, amount, paid_amount, start_date) VALUES (?, ?, 'credit', ?, ?, ?)`,
      [ctx.userId, 'Loan', 5000, 1000, '2026-01-01']
    );
    debtId = debt.id;
    await db.run(`INSERT INTO debt_payments (debt_id, amount, payment_date) VALUES (?, ?, ?)`, [debtId, 500, dates.addDaysISO(today, -40)]);
    await db.run(`INSERT INTO debt_payments (debt_id, amount, payment_date) VALUES (?, ?, ?)`, [debtId, 500, dates.addDaysISO(today, -10)]);
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  // ---------------- calendar ----------------
  test('GET /api/calendar/events -> 200, регулярный платёж по name/next_payment_date', async () => {
    const res = await ctx.request
      .get(`/api/calendar/events?start=${today}&end=${dates.addDaysISO(today, 30)}`)
      .set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const rent = res.body.find((e) => e.event_type === 'recurring');
    expect(rent).toBeTruthy();
    expect(rent.title).toBe('Rent');
    expect(rent.event_date).toBe(dates.addDaysISO(today, 3));
    expect(res.body.find((e) => e.event_type === 'subscription').title).toBe('Netflix');
    expect(res.body.find((e) => e.title === 'Dentist')).toBeTruthy();
  });

  test('GET /api/calendar/events?type= фильтрует параметром; без start/end -> текущий месяц', async () => {
    const filtered = await ctx.request
      .get(`/api/calendar/events?start=${today}&end=${dates.addDaysISO(today, 30)}&type=reminder`)
      .set(AUTH(ctx.token));
    expect(filtered.status).toBe(200);
    const own = filtered.body.filter((e) => !['recurring', 'subscription', 'debt', 'goal'].includes(e.event_type));
    expect(own.every((e) => e.event_type === 'reminder')).toBe(true);
    // Инъекция в type — просто пустой результат, не ошибка.
    const inj = await ctx.request
      .get(`/api/calendar/events?start=${today}&end=${dates.addDaysISO(today, 30)}&type=x' OR '1'='1`)
      .set(AUTH(ctx.token));
    expect(inj.status).toBe(200);
    const noRange = await ctx.request.get('/api/calendar/events').set(AUTH(ctx.token));
    expect(noRange.status).toBe(200);
    expect(Array.isArray(noRange.body)).toBe(true);
  });

  test('GET /api/calendar/upcoming -> 200 с Rent', async () => {
    const res = await ctx.request.get('/api/calendar/upcoming').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.map((e) => e.title)).toEqual(expect.arrayContaining(['Rent', 'Netflix', 'Dentist']));
  });

  // ---------------- analytics ----------------
  test('GET /api/analytics/compare -> начальный баланс и переводы не доход', async () => {
    const res = await ctx.request.get('/api/analytics/compare').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.thisMonth.income).toBe(2000);
    expect(res.body.thisMonth.expense).toBe(500);
    expect(res.body.lastMonth.income).toBe(1000);
    expect(res.body.changes.income).toBe(100);
    expect(res.body.changes.expense).toBe(25);
    expect(res.body.period.thisMonth.start).toBe(thisMonthStart);
  });

  test('GET /api/analytics/overview + expenses-by-category -> без «Начальный баланс»', async () => {
    const ov = await ctx.request.get('/api/analytics/overview').set(AUTH(ctx.token));
    expect(ov.status).toBe(200);
    expect(ov.body.income).toBe(2000);
    expect(ov.body.expense).toBe(500);
    const cats = await ctx.request.get('/api/analytics/expenses-by-category').set(AUTH(ctx.token));
    expect(cats.status).toBe(200);
    expect(cats.body.map((c) => c.category)).not.toContain('Начальный баланс');
    expect(cats.body.map((c) => c.category)).not.toContain('Transfer');
    const inc = await ctx.request.get('/api/analytics/income-by-category').set(AUTH(ctx.token));
    expect(inc.body.map((c) => c.category)).toEqual(['Salary']);
    const trends = await ctx.request.get('/api/analytics/trends?period=monthly').set(AUTH(ctx.token));
    expect(trends.status).toBe(200);
    const cur = trends.body.data.find((d) => d.period === today.slice(0, 7));
    expect(cur.income).toBe(2000);
  });

  test('компаре с пустым прошлым месяцем -> 0, а не Infinity', async () => {
    await db.run(`DELETE FROM transactions WHERE user_id = ? AND date < ?`, [ctx.userId, thisMonthStart]);
    const res = await ctx.request.get('/api/analytics/compare').set(AUTH(ctx.token));
    expect(res.body.changes.income).toBe(0);
    // восстановим
    await tx(lastMonthMid, 'Salary', 1000, 'income');
    await tx(lastMonthMid, 'Groceries', 400, 'expense');
  });

  // ---------------- forecast ----------------
  test('GET /api/forecast/balance -> конечные числа, changePercent с потолком, без opening', async () => {
    const res = await ctx.request.get('/api/forecast/balance?days=30').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(Number.isFinite(s.projectedBalance)).toBe(true);
    expect(s.changePercent === null || Math.abs(s.changePercent) <= 999).toBe(true);
    // Средний дневной доход не должен включать 50 000 начального баланса.
    expect(s.avgDailyIncome).toBeLessThanOrEqual(2000);
    expect(res.body.forecast[0].date).toBe(today);
    expect(res.body.forecast).toHaveLength(31);
  });

  test('GET /api/forecast/goal/:id и /debt/:id -> 200 (колонки created_at / payment_date)', async () => {
    const g = await ctx.request.get(`/api/forecast/goal/${goalId}`).set(AUTH(ctx.token));
    expect(g.status).toBe(200);
    expect(g.body.remaining).toBe(2400);
    expect(g.body.avgContribution).toBeGreaterThan(0);
    const d = await ctx.request.get(`/api/forecast/debt/${debtId}`).set(AUTH(ctx.token));
    expect(d.status).toBe(200);
    expect(d.body.remaining).toBe(4000);
    expect(d.body.projectedDate).toBeTruthy();
  });

  test('GET /api/forecast/trends и /expenses -> 200, проценты <= 999', async () => {
    const t = await ctx.request.get('/api/forecast/trends').set(AUTH(ctx.token));
    expect(t.status).toBe(200);
    expect(t.body.months).toHaveLength(6);
    for (const k of ['income', 'expense', 'savings']) {
      expect(Number(t.body.trends[k].percent)).toBeLessThanOrEqual(999);
    }
    const cur = t.body.months.find((m) => m.month === today.slice(0, 7));
    expect(cur.income).toBe(2000);
    const e = await ctx.request.get('/api/forecast/expenses').set(AUTH(ctx.token));
    expect(e.status).toBe(200);
    expect(e.body.categories.map((c) => c.category)).not.toContain('Начальный баланс');
  });

  // ---------------- widgets ----------------
  test('виджеты cashflow/top_categories/upcoming игнорируют opening/transfer', async () => {
    const cf = await ctx.request.get('/api/widgets/cashflow/data').set(AUTH(ctx.token));
    expect(cf.status).toBe(200);
    expect(cf.body.income).toBe(2000);
    expect(cf.body.expense).toBe(500);
    const top = await ctx.request.get('/api/widgets/top_categories/data').set(AUTH(ctx.token));
    expect(top.status).toBe(200);
    expect(top.body.categories.map((c) => c.category)).toEqual(['Groceries']);
    const up = await ctx.request.get('/api/widgets/upcoming/data').set(AUTH(ctx.token));
    expect(up.status).toBe(200);
    expect(up.body.items.map((i) => i.title)).toEqual(['Rent', 'Netflix']);
  });
});
