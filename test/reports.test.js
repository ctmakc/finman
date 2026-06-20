// test/reports.test.js — wave-2 pdf-reports stream.
//
// Покрывает:
//   1) POST /api/reports/generate {format:'pdf'} -> возвращает id и метаданные;
//   2) GET  /api/reports/:id/download -> стримит НЕПУСТОЙ PDF (заголовок '%PDF');
//   3) reportService.buildReportData считает summary/категории/бюджеты/networth
//      из засеянных данных (через lib/money, float-safe);
//   4) renderReportPdf отдаёт валидный PDF-буфер из тех же данных;
//   5) download чужого/несуществующего отчёта -> 404 (REPORT_NOT_FOUND).
//
// Тесты офлайн и детерминированы: pdfkit рендерит локально, сеть не трогаем.

const { makeApp } = require('./helpers/app');

function getDb() {
  return require('../db/database');
}

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

const PERIOD = { start: '2026-03-01', end: '2026-03-31' };

describe('pdf-reports: generate + download', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();

    // Счёт для транзакций.
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active)
       VALUES (?, 'Main', 'UAH', 1000, 1)`,
      [ctx.userId]
    );
    const accountId = acc.id;

    // Транзакции за период: доход 5000, расходы 1200.50 (food) + 300 (transport).
    const txns = [
      ['2026-03-02', 'salary', 'income', 'income', 5000],
      ['2026-03-05', 'groceries', 'food', 'expense', 1200.5],
      ['2026-03-10', 'metro', 'transport', 'expense', 300],
      // Вне периода — НЕ должно попасть в отчёт.
      ['2026-02-28', 'old', 'food', 'expense', 999],
    ];
    for (const [date, description, category, type, amount] of txns) {
      await db.run(
        `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [accountId, ctx.userId, date, description, category, amount, type]
      );
    }

    // Бюджет на food: лимит 1000 (факт 1200.50 -> over budget).
    await db.run(
      `INSERT INTO budgets (user_id, name, category, amount, period, start_date, is_active)
       VALUES (?, 'Food budget', 'food', 1000, 'monthly', '2026-03-01', 1)`,
      [ctx.userId]
    );

    // Net worth: ручной актив 2000, долг 500 (paid 100 -> остаток 400).
    await db.run(
      `INSERT INTO manual_assets (user_id, name, type, value, is_active)
       VALUES (?, 'Laptop', 'electronics', 2000, 1)`,
      [ctx.userId]
    );
    await db.run(
      `INSERT INTO debts (user_id, name, type, amount, paid_amount, start_date, is_active)
       VALUES (?, 'Loan', 'loan', 500, 100, '2026-01-01', 1)`,
      [ctx.userId]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('buildReportData aggregates summary/categories/budgets/networth', async () => {
    const reportService = require('../services/reportService');
    const data = await reportService.buildReportData(ctx.userId, {
      reportType: 'monthly',
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });

    // Summary
    expect(data.summary.income).toBe(5000);
    expect(data.summary.expenses).toBe(1500.5); // 1200.50 + 300
    expect(data.summary.net).toBe(3499.5); // 5000 - 1500.50
    expect(data.summary.transactionCount).toBe(3); // вне периода исключено

    // Category breakdown (отсортирован по убыванию)
    const food = data.categoryBreakdown.find((c) => c.category === 'food');
    const transport = data.categoryBreakdown.find((c) => c.category === 'transport');
    expect(food.total).toBe(1200.5);
    expect(transport.total).toBe(300);
    expect(data.categoryBreakdown[0].category).toBe('food'); // больший расход первым

    // Budget vs actual
    const b = data.budgetVsActual.find((x) => x.category === 'food');
    expect(b.limit).toBe(1000);
    expect(b.spent).toBe(1200.5);
    expect(b.overBudget).toBe(true);
    expect(b.remaining).toBe(-200.5);

    // Net worth: assets = accounts(1000) + manual(2000) = 3000;
    // liabilities = 500 - 100 = 400; net worth = 2600.
    expect(data.netWorth.totalAssets).toBe(3000);
    expect(data.netWorth.totalLiabilities).toBe(400);
    expect(data.netWorth.netWorth).toBe(2600);
  });

  test('renderReportPdf returns a non-empty PDF buffer (%PDF header)', async () => {
    const reportService = require('../services/reportService');
    const data = await reportService.buildReportData(ctx.userId, {
      reportType: 'monthly',
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });
    const pdf = await reportService.renderReportPdf(data);

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('POST /api/reports/generate {format:pdf} returns an id', async () => {
    const res = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({
        report_type: 'monthly',
        format: 'pdf',
        period_start: PERIOD.start,
        period_end: PERIOD.end,
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(typeof res.body.id).toBe('number');
    expect(res.body.format).toBe('pdf');
    expect(res.body.download_url).toBe(`/api/reports/${res.body.id}/download`);

    // Метаданные сохранены в таблице reports.
    const row = await db.get(
      'SELECT * FROM reports WHERE id = ? AND user_id = ?',
      [res.body.id, ctx.userId]
    );
    expect(row).toBeTruthy();
    expect(row.format).toBe('pdf');
    expect(row.report_type).toBe('monthly');
  });

  test('GET /api/reports/:id/download streams a non-empty PDF', async () => {
    // Сначала сгенерируем отчёт.
    const gen = await ctx.request
      .post('/api/reports/generate')
      .set(AUTH(ctx.token))
      .send({
        report_type: 'monthly',
        format: 'pdf',
        period_start: PERIOD.start,
        period_end: PERIOD.end,
      });
    expect(gen.status).toBe(200);
    const id = gen.body.id;

    const res = await ctx.request
      .get(`/api/reports/${id}/download`)
      .set(AUTH(ctx.token))
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(Buffer.from(c)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);

    const body = res.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('download of a missing report -> 404 REPORT_NOT_FOUND', async () => {
    const res = await ctx.request
      .get('/api/reports/999999/download')
      .set(AUTH(ctx.token));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('REPORT_NOT_FOUND');
  });

  test('annual report builds default full-year period when none given', async () => {
    const reportService = require('../services/reportService');
    const data = await reportService.buildReportData(ctx.userId, {
      reportType: 'annual',
    });
    expect(data.reportType).toBe('annual');
    expect(data.period.start).toMatch(/-01-01$/);
    expect(data.period.end).toMatch(/-12-31$/);
    expect(data.title).toMatch(/Annual/);
  });
});
