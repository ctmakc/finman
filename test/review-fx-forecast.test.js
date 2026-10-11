// test/review-fx-forecast.test.js — regression tests for the money/forecast
// review: currency-aware aggregates (lib/fx), forecast schedule overlay,
// zero-filled seasonal model, double counting of recurring payments, budget
// roll-forward guard, billing-day anchors, reports, widget totals.
//
// Process TZ is west of UTC on purpose: new Date('YYYY-MM-DD') is the previous
// evening there, which is exactly the class of bug fixed in the forecast model.
process.env.TZ = 'America/Toronto';
process.env.FX_LIVE = '0';

const { makeApp } = require('./helpers/app');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });
const dates = require('../lib/dates');
const TODAY = dates.todayISO('America/Toronto');

// Fallback rates (services/currencyService): UAH->USD 0.024, CAD->USD 0.73.
const UAH_TO_CAD = 0.024 / 0.73;
const uahInCad = (v) => Math.round(v * UAH_TO_CAD * 100) / 100;

async function account(db, userId, name, currency, balance = 0) {
  const r = await db.run(
    `INSERT INTO accounts (user_id, name, currency, balance, is_active) VALUES (?, ?, ?, ?, 1)`,
    [userId, name, currency, balance]
  );
  return r.id;
}

async function tx(db, userId, accountId, date, category, amount, type, description = 'x') {
  const r = await db.run(
    `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [accountId, userId, date, description, category, amount, type]
  );
  return r.id;
}

// ---------------------------------------------------------------------------
describe('lib/dates.rollForward anchor and subscription billing days', () => {
  test('start >= today with anchorDay never returns a date before start', () => {
    expect(dates.rollForward('2026-10-15', 'monthly', '2026-10-15', 5)).toBe('2026-11-05');
    expect(dates.rollForward('2026-10-15', 'monthly', '2026-10-10', 20)).toBe('2026-10-20');
    expect(dates.rollForward('2026-10-15', 'quarterly', '2026-10-01', 5)).toBe('2027-01-05');
    // Behaviour without an anchor is unchanged.
    expect(dates.rollForward('2026-10-15', 'monthly', '2026-10-10')).toBe('2026-10-15');
  });

  test('payments on the 31st do not drift to the 28th', () => {
    const Subscription = require('../models/subscription');
    const start = '2025-12-31';
    const feb = Subscription.nextAfterPayment('2026-01-31', 'monthly', '2026-01-31', start);
    expect(feb).toBe('2026-02-28');
    const mar = Subscription.nextAfterPayment(feb, 'monthly', feb, start);
    expect(mar).toBe('2026-03-31');
    expect(Subscription.nextAfterPayment(mar, 'monthly', mar, start)).toBe('2026-04-30');
    // Without a start date the payment day is the anchor (old behaviour).
    expect(Subscription.nextAfterPayment('2026-01-31', 'monthly', '2026-02-10')).toBe('2026-02-28');
  });
});

// ---------------------------------------------------------------------------
describe('forecast internals', () => {
  const { _internals } = require('../routes/forecast');

  test('occurrences start at next_payment_date, honour end_date and the anchor day', () => {
    const occ = _internals.occurrencesBetween;
    // Monthly on the 31st fires in short months (clamped), then returns to 31.
    expect(occ('2026-01-31', 'monthly', '2026-01-01', '2026-05-31', { anchorDay: 31 }))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    // Never before next_payment_date.
    expect(occ('2026-12-01', 'monthly', '2026-10-01', '2026-11-30')).toEqual([]);
    // Biweekly / quarterly repeat inside the horizon.
    expect(occ('2026-10-02', 'biweekly', '2026-10-01', '2026-11-15'))
      .toEqual(['2026-10-02', '2026-10-16', '2026-10-30', '2026-11-13']);
    expect(occ('2026-10-05', 'quarterly', '2026-10-01', '2027-04-30'))
      .toEqual(['2026-10-05', '2027-01-05', '2027-04-05']);
    // end_date stops the series.
    expect(occ('2026-10-02', 'weekly', '2026-10-01', '2026-12-31', { endISO: '2026-10-20' }))
      .toEqual(['2026-10-02', '2026-10-09', '2026-10-16']);
  });

  test('seasonal model: zero-filled averages and UTC weekday/day-of-month', () => {
    const today = '2026-10-11';
    const first = dates.addDaysISO(today, -27);
    const build = (incomeOf) => {
      const rows = [];
      for (let i = 27; i >= 0; i--) {
        const d = dates.addDaysISO(today, -i);
        const income = incomeOf(dates.parseISO(d));
        if (income) rows.push({ date: d, income, expense: 0 });
      }
      const series = _internals.zeroFilledSeries(rows, first, 28);
      expect(series).toHaveLength(28);
      return { rows, model: _internals.buildSeasonalTrendModel(series, today) };
    };

    // +700 on every Monday: average over all 28 days, spike on Monday (1),
    // not on Sunday (0) as with new Date('YYYY-MM-DD') west of UTC.
    const weekly = build((p) => (p.getUTCDay() === 1 ? 700 : 0));
    const total = weekly.rows.reduce((s, r) => s + r.income, 0);
    expect(weekly.model.avgIncome).toBeCloseTo(total / 28, 6);
    const maxDow = weekly.model.weekdayFactor.indexOf(Math.max(...weekly.model.weekdayFactor));
    expect(maxDow).toBe(1);

    // +3000 on the 15th: the day-of-month factor peaks on 15, not 14.
    const monthly = build((p) => (p.getUTCDate() === 15 ? 3000 : 0));
    const domEntries = Object.entries(monthly.model.monthdayFactor).sort((x, y) => y[1] - x[1]);
    expect(Number(domEntries[0][0])).toBe(15);
  });

  test('trend of a negative base uses its magnitude (less negative = up)', () => {
    expect(_internals.calculateTrend([-100, -100, -100, -50, -50, -50])).toBeCloseTo(50, 6);
    expect(_internals.calculateTrend([100, 100, 100, 50, 50, 50])).toBeCloseTo(-50, 6);
  });
});

// ---------------------------------------------------------------------------
describe('currency-aware aggregates (100 CAD + 4000 UAH)', () => {
  let ctx;
  let db;
  let cad;
  let uah;
  const day = dates.startOfMonthISO(TODAY) === TODAY ? TODAY : dates.addDaysISO(TODAY, -1);

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    cad = await account(db, ctx.userId, 'CAD chq', 'CAD', 1000);
    uah = await account(db, ctx.userId, 'UAH card', 'UAH', 10000);
    await tx(db, ctx.userId, cad, day, 'Food', -100, 'expense');
    await tx(db, ctx.userId, uah, day, 'Food', -4000, 'expense');
    await tx(db, ctx.userId, uah, day, 'Salary', 40000, 'income');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  const EXPENSE = () => Math.round((100 + uahInCad(4000)) * 100) / 100;
  const INCOME = () => uahInCad(40000);

  test('analytics overview / categories / compare are in CAD', async () => {
    const ov = await ctx.request.get(`/api/analytics/overview?startDate=2000-01-01&endDate=${TODAY}`).set(AUTH(ctx.token));
    expect(ov.status).toBe(200);
    expect(ov.body.baseCurrency).toBe('CAD');
    expect(ov.body.expense).toBeCloseTo(EXPENSE(), 1);
    expect(ov.body.expense).toBeLessThan(4100);
    expect(ov.body.income).toBeCloseTo(INCOME(), 1);
    expect(ov.body.transactionCount).toBe(3);

    const cats = await ctx.request.get(`/api/analytics/expenses-by-category?startDate=2000-01-01&endDate=${TODAY}`).set(AUTH(ctx.token));
    expect(cats.body).toHaveLength(1);
    expect(cats.body[0]).toMatchObject({ category: 'Food', count: 2, currency: 'CAD' });
    expect(cats.body[0].total).toBeCloseTo(EXPENSE(), 1);

    const tr = await ctx.request.get('/api/analytics/trends?period=monthly').set(AUTH(ctx.token));
    const month = tr.body.data.find((r) => r.period === day.slice(0, 7));
    expect(tr.body.baseCurrency).toBe('CAD');
    expect(month.expense).toBeCloseTo(EXPENSE(), 1);
  });

  test('widgets cashflow / expenses / top categories are in CAD', async () => {
    const cf = await ctx.request.get('/api/widgets/cashflow/data?period=year').set(AUTH(ctx.token));
    expect(cf.body.currency).toBe('CAD');
    expect(cf.body.expense).toBeCloseTo(EXPENSE(), 1);
    expect(cf.body.income).toBeCloseTo(INCOME(), 1);
    const top = await ctx.request.get('/api/widgets/top_categories/data?period=year').set(AUTH(ctx.token));
    expect(top.body.total).toBeCloseTo(EXPENSE(), 1);
    expect(top.body.categories[0].total).toBeCloseTo(EXPENSE(), 1);
  });

  test('Transaction.getStats / findByUserId / findById carry the currency', async () => {
    const Transaction = require('../models/transaction');
    const stats = await Transaction.getStats(ctx.userId, { groupBy: 'category' });
    const food = stats.find((r) => r.category === 'Food' && r.type === 'expense');
    expect(food.currency).toBe('CAD');
    expect(food.count).toBe(2);
    expect(food.total_amount).toBeCloseTo(EXPENSE(), 1);

    const byMonth = await Transaction.getStats(ctx.userId, { groupBy: 'month' });
    const expRow = byMonth.find((r) => r.type === 'expense');
    expect(expRow.expense).toBeCloseTo(EXPENSE(), 1);

    const list = await Transaction.findByUserId(ctx.userId, {});
    expect(list.find((t) => t.account_id === uah).currency).toBe('UAH');
    const one = await Transaction.findById(list[0].id, ctx.userId);
    expect(['CAD', 'UAH']).toContain(one.currency);
  });

  test('forecast trends and reports convert per account currency', async () => {
    const tr = await ctx.request.get('/api/forecast/trends').set(AUTH(ctx.token));
    expect(tr.status).toBe(200);
    const m = tr.body.months.find((x) => x.month === day.slice(0, 7));
    expect(m.expense).toBeCloseTo(EXPENSE(), 1);
    expect(tr.body.baseCurrency).toBe('CAD');

    const monthly = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({ report_type: 'monthly', period_start: dates.startOfMonthISO(day), period_end: TODAY });
    expect(monthly.status).toBe(200);
    expect(monthly.body.data.currency).toBe('CAD');
    expect(monthly.body.data.summary.expenses).toBeCloseTo(EXPENSE(), 1);

    const reportService = require('../services/reportService');
    const pdfData = await reportService.buildReportData(ctx.userId, {
      reportType: 'monthly', periodStart: dates.startOfMonthISO(day), periodEnd: TODAY,
    });
    expect(pdfData.currency).toBe('CAD');
    expect(pdfData.summary.expenses).toBeCloseTo(EXPENSE(), 1);
  });

  test('budget spending is counted in the budget currency', async () => {
    const Budget = require('../models/budget');
    const b = await Budget.create({
      userId: ctx.userId, name: 'Food UAH', category: 'Food', amount: 10000,
      period: 'monthly', startDate: '2026-01-01', currency: 'UAH',
    });
    await Budget.recalculateSpent(ctx.userId, null, TODAY);
    const budget = await Budget.findById(b.id, ctx.userId);
    // 4000 UAH + 100 CAD (~3041 UAH) — never 4100.
    const cadInUah = Math.round((100 / UAH_TO_CAD) * 100) / 100;
    expect(budget.spent).toBeCloseTo(4000 + cadInUah, 0);
  });

  test('digest sums in the base currency', async () => {
    const digestService = require('../services/digestService');
    const d = await digestService.buildDigest(ctx.userId, { now: new Date(`${TODAY}T12:00:00Z`) });
    expect(d.currency).toBe('CAD');
    expect(d.expense).toBeCloseTo(EXPENSE(), 1);
    expect(digestService.renderText(d)).toContain('Amounts in CAD');
  });
});

// ---------------------------------------------------------------------------
describe('reports: yearly and net worth', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    const cad = await account(db, ctx.userId, 'CAD', 'CAD', 500);
    const uah = await account(db, ctx.userId, 'UAH', 'UAH', 4000);
    await tx(db, ctx.userId, cad, '2025-12-31', 'Food', -30, 'expense');
    await tx(db, ctx.userId, cad, '2025-01-31', 'Food', -20, 'expense');
    await tx(db, ctx.userId, uah, '2025-06-30', 'Food', -4000, 'expense');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('yearly report accepts a date (UI sends period_start) and counts month-end days', async () => {
    const res = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({ report_type: 'yearly', period_start: '2025-10-01', period_end: '2025-12-31' });
    expect(res.status).toBe(200);
    expect(res.body.data.year).toBe(2025);
    expect(res.body.data.monthlyData).toHaveLength(12);
    expect(res.body.data.monthlyData[0].expenses).toBe(20); // Jan 31
    expect(res.body.data.monthlyData[11].expenses).toBe(30); // Dec 31
    expect(res.body.data.monthlyData[5].expenses).toBeCloseTo(uahInCad(4000), 1); // Jun 30, UAH
    expect(res.body.data.currency).toBe('CAD');

    const plain = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({ report_type: 'yearly', period_start: 2025 });
    expect(plain.status).toBe(200);
    expect(plain.body.data.year).toBe(2025);

    const bad = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({ report_type: 'yearly', period_start: 'soon' });
    expect(bad.status).toBe(400);
  });

  test('net worth report works and converts every account', async () => {
    const res = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({ report_type: 'networth' });
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('CAD');
    expect(res.body.data.breakdown.accounts).toBeCloseTo(500 + uahInCad(4000), 1);
    expect(res.body.data.accountsList[0]).toHaveProperty('account_type');
    expect(res.body.data.accountsList[0]).toHaveProperty('currency');
  });
});

// ---------------------------------------------------------------------------
describe('widgets: subscriptions monthly total', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('normalises each billing cycle to a month and sums all subscriptions', async () => {
    const subs = [
      ['W', 10, 'weekly'], ['Q', 30, 'quarterly'], ['Y', 120, 'yearly'],
      ['M1', 5, 'monthly'], ['M2', 5, 'monthly'], ['M3', 5, 'monthly'],
    ];
    for (const [name, amount, cycle] of subs) {
      await db.run(
        `INSERT INTO subscriptions (user_id, name, amount, currency, billing_cycle, start_date, next_billing_date, is_active)
         VALUES (?, ?, ?, 'CAD', ?, '2026-01-01', ?, 1)`,
        [ctx.userId, name, amount, cycle, dates.addDaysISO(TODAY, 3)]
      );
    }
    const res = await ctx.request.get('/api/widgets/subscriptions/data').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(5);
    expect(res.body.count).toBe(6);
    // 10*52/12 + 30/3 + 120/12 + 3*5 = 43.33 + 10 + 10 + 15
    expect(res.body.monthlyTotal).toBeCloseTo(78.33, 2);
    expect(res.body.currency).toBe('CAD');
  });
});

// ---------------------------------------------------------------------------
describe('forecast /balance', () => {
  let ctx;
  let db;

  beforeEach(async () => {
    ctx = await makeApp();
    db = require('../db/database');
  });

  afterEach(async () => {
    if (ctx) await ctx.close();
  });

  const byDate = (forecast) => new Map(forecast.map((f) => [f.date, f]));

  test('overlay: occurrences from next date, end_date, biweekly, quarterly, account currency', async () => {
    const cad = await account(db, ctx.userId, 'CAD', 'CAD', 0);
    const uah = await account(db, ctx.userId, 'UAH', 'UAH', 0);
    const rp = (acc, name, amount, frequency, next, end = null) => db.run(
      `INSERT INTO recurring_payments (user_id, account_id, name, amount, type, frequency, start_date, end_date, next_payment_date, is_active)
       VALUES (?, ?, ?, ?, 'expense', ?, ?, ?, ?, 1)`,
      [ctx.userId, acc, name, amount, frequency, next, end, next]
    );
    await rp(cad, 'Later', 500, 'monthly', dates.addMonthsISO(TODAY, 6));
    await rp(cad, 'Bi', 100, 'biweekly', dates.addDaysISO(TODAY, 1));
    await rp(cad, 'Short', 7, 'weekly', dates.addDaysISO(TODAY, 2), dates.addDaysISO(TODAY, 10));
    await rp(uah, 'Hryvnia', 4000, 'monthly', dates.addDaysISO(TODAY, 4));
    await db.run(
      `INSERT INTO subscriptions (user_id, name, amount, currency, billing_cycle, start_date, next_billing_date, is_active)
       VALUES (?, 'Quarterly', 30, 'CAD', 'quarterly', ?, ?, 1)`,
      [ctx.userId, dates.addDaysISO(TODAY, 3), dates.addDaysISO(TODAY, 3)]
    );

    const res = await ctx.request.get('/api/forecast/balance?days=120').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const f = byDate(res.body.forecast);
    const exp = (n) => f.get(dates.addDaysISO(TODAY, n)).expense;

    // 'Later' (6 months out) never appears in a 120-day horizon.
    expect(res.body.forecast.some((d) => d.expense >= 500)).toBe(false);
    // Biweekly 100: every 14 days.
    for (const n of [1, 15, 29, 43, 57, 71, 85, 99, 113]) expect(exp(n)).toBe(100);
    // Weekly 7 until end_date (+2, +9 only).
    expect(exp(2)).toBe(7);
    expect(exp(9)).toBe(7);
    expect(exp(16)).toBe(0);
    // Quarterly subscription: +3 and three months later.
    expect(exp(3)).toBe(30);
    expect(f.get(dates.addMonthsISO(dates.addDaysISO(TODAY, 3), 3)).expense).toBe(30);
    // UAH payment converted into CAD.
    expect(exp(4)).toBeCloseTo(uahInCad(4000), 1);
    expect(res.body.summary.baseCurrency).toBe('CAD');
  });

  test('history: zero-filled daily average (no 125-173 per day)', async () => {
    const cad = await account(db, ctx.userId, 'CAD', 'CAD', 1000);
    for (let i = 90; i >= 1; i--) {
      const d = dates.addDaysISO(TODAY, -i);
      if (i === 75 || i === 45 || i === 15) await tx(db, ctx.userId, cad, d, 'Salary', 2000, 'income');
      else if (i % 2 === 0) await tx(db, ctx.userId, cad, d, 'Food', -50, 'expense');
    }
    const res = await ctx.request.get('/api/forecast/balance?days=30').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s.model).toBe('seasonal_trend');
    expect(s.avgDailyIncome).toBeCloseTo(6000 / 91, 1);
    // The modelled average per day is the zero-filled one; the old model put
    // at least 125 income on every single day.
    const days = res.body.forecast.slice(1);
    const avgIncome = days.reduce((a, d) => a + d.income, 0) / days.length;
    expect(Math.min(...days.map((d) => d.income))).toBeLessThan(125);
    expect(avgIncome).toBeLessThan(125);
  });

  test('recurring payments are not counted twice (history average + overlay)', async () => {
    const cad = await account(db, ctx.userId, 'CAD', 'CAD', 5000);
    const next = dates.addDaysISO(TODAY, 5);
    await db.run(
      `INSERT INTO recurring_payments (user_id, account_id, name, amount, type, category, frequency, day_of_month, start_date, next_payment_date, is_active)
       VALUES (?, ?, 'Rent', 1000, 'expense', 'Housing', 'monthly', ?, ?, ?, 1)`,
      [ctx.userId, cad, dates.parseISO(next).getUTCDate(), dates.addMonthsISO(next, -3), next]
    );
    // Two past rent payments (as created by the scheduler) + coffee.
    await tx(db, ctx.userId, cad, dates.addMonthsISO(next, -1), 'Housing', -1000, 'expense', 'Rent');
    await tx(db, ctx.userId, cad, dates.addMonthsISO(next, -2), 'Housing', -1000, 'expense', 'Rent');
    for (let i = 1; i <= 10; i++) {
      await tx(db, ctx.userId, cad, dates.addDaysISO(TODAY, -i * 6), 'Coffee', -10, 'expense', 'Coffee');
    }

    const res = await ctx.request.get('/api/forecast/balance?days=30').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const h = res.body.summary.history;
    expect(h.scheduledExcluded.count).toBe(2);
    expect(h.scheduledExcluded.expense).toBe(2000);
    expect(h.totalExpense).toBe(100); // coffee only
    expect(res.body.summary.avgDailyExpense).toBeCloseTo(100 / h.observedDays, 2);
    // Rent appears once, on its due date, on top of the daily average.
    const due = res.body.forecast.find((f) => f.date === next);
    expect(due.expense).toBeCloseTo(1000 + 100 / h.observedDays, 1);
    // Projected change over 30 days = 30 days of coffee + one rent.
    expect(res.body.summary.change).toBeCloseTo(-(1000 + (100 / h.observedDays) * 30), 0);
  });
});

// ---------------------------------------------------------------------------
describe('budget periods in the user day', () => {
  test('getPeriodDates uses the given day (string arithmetic, Monday weeks)', () => {
    const Budget = require('../models/budget');
    expect(Budget.getPeriodDates({ period: 'monthly' }, '2026-11-01'))
      .toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(Budget.getPeriodDates({ period: 'weekly' }, '2026-10-11'))
      .toEqual({ startDate: '2026-10-05', endDate: '2026-10-11' });
    expect(Budget.getPeriodDates({ period: 'weekly' }, '2026-10-12'))
      .toEqual({ startDate: '2026-10-12', endDate: '2026-10-18' });
    expect(Budget.getPeriodDates({ period: 'yearly' }, '2026-02-03'))
      .toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(Budget.getPeriodDates({ period: 'daily' }, '2026-02-03'))
      .toEqual({ startDate: '2026-02-03', endDate: '2026-02-03' });
  });
});
