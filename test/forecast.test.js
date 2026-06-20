// test/forecast.test.js — F7 forecast-anomaly stream.
// Покрывает: anomalyService (выбросы, дубли, рост подписки),
// GET /api/anomalies, GET /api/forecast/balance (новые поля + конечность).

const { makeApp } = require('./helpers/app');

// Хелперы дат: ISO yyyy-mm-dd со смещением в днях от сегодня.
function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

describe('forecast-anomaly stream', () => {
  let ctx;
  let db; // db helpers ({ run, get, query }) той же временной БД, что и app
  let accountId;

  beforeAll(async () => {
    ctx = await makeApp();
    // Модуль БД уже в require-кэше и привязан к временной БД приложения.
    db = require('../db/database');

    // Счёт для транзакций.
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, balance, currency) VALUES (?, ?, ?, ?)`,
      [ctx.userId, 'Test Account', 10000, 'UAH']
    );
    accountId = acc.id;

    // --- Категория "groceries": много мелких + один явный выброс ---
    // 10 обычных покупок ~100, разнесены по дням.
    for (let i = 0; i < 10; i++) {
      await db.run(
        `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [accountId, ctx.userId, isoDaysAgo(40 - i), `Shop ${i}`, 'groceries', 100 + (i % 3), 'expense']
      );
    }
    // Явный выброс: 5000 в groceries.
    const outlier = await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [accountId, ctx.userId, isoDaysAgo(5), 'Big purchase', 'groceries', 5000, 'expense']
    );
    ctx.outlierTxId = outlier.id;

    // --- Дубль-списание: тот же мерчант + сумма в пределах 1 дня ---
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [accountId, ctx.userId, isoDaysAgo(10), 'Netflix', 'subscriptions', 299, 'expense']
    );
    const dup = await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [accountId, ctx.userId, isoDaysAgo(10), 'Netflix', 'subscriptions', 299, 'expense']
    );
    ctx.dupTxId = dup.id;

    // --- Доходы, чтобы у модели был не только расход ---
    for (let i = 0; i < 8; i++) {
      await db.run(
        `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [accountId, ctx.userId, isoDaysAgo(60 - i * 7), 'Salary', 'income', 2000, 'income']
      );
    }

    // --- Подписка с историей платежей и текущим ростом цены ---
    const sub = await db.run(
      `INSERT INTO subscriptions (user_id, name, amount, currency, billing_cycle, start_date, next_billing_date, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [ctx.userId, 'Spotify', 200, 'UAH', 'monthly', isoDaysAgo(120), isoDaysAgo(-5)]
    );
    ctx.subId = sub.id;
    // Историческая медиана платежей = 100, текущая цена 200 -> рост 100%.
    for (const d of [120, 90, 60, 30]) {
      await db.run(
        `INSERT INTO subscription_payments (subscription_id, amount, payment_date, status)
         VALUES (?, ?, ?, 'paid')`,
        [ctx.subId, 100, isoDaysAgo(d)]
      );
    }
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  // ---------------- anomalyService (unit-ish, через реальную БД) ----------------

  test('detectForUser флагует явный выброс суммы', async () => {
    const anomalyService = require('../services/anomalyService');
    const anomalies = await anomalyService.detectForUser(ctx.userId);

    const outlier = anomalies.find(
      (a) => a.transactionId === ctx.outlierTxId && a.type === 'amount_outlier'
    );
    expect(outlier).toBeDefined();
    expect(['low', 'medium', 'high']).toContain(outlier.severity);
    expect(typeof outlier.reason).toBe('string');
  });

  test('detectForUser ловит дубль-списание', async () => {
    const anomalyService = require('../services/anomalyService');
    const anomalies = await anomalyService.detectForUser(ctx.userId);

    const dup = anomalies.find(
      (a) => a.type === 'duplicate_charge' && a.transactionId === ctx.dupTxId
    );
    expect(dup).toBeDefined();
    expect(dup.duplicateOf).toBeDefined();
    expect(dup.severity).toBe('high'); // в пределах 1 дня
  });

  test('detectForUser ловит рост цены подписки', async () => {
    const anomalyService = require('../services/anomalyService');
    const anomalies = await anomalyService.detectForUser(ctx.userId);

    const hike = anomalies.find(
      (a) => a.type === 'subscription_hike' && a.subscriptionId === ctx.subId
    );
    expect(hike).toBeDefined();
    expect(hike.increasePercent).toBeGreaterThanOrEqual(15);
    expect(hike.previousAmount).toBe(100);
    expect(hike.amount).toBe(200);
  });

  test('каждая аномалия имеет контракт {transactionId|null, reason, severity}', async () => {
    const anomalyService = require('../services/anomalyService');
    const anomalies = await anomalyService.detectForUser(ctx.userId);
    expect(anomalies.length).toBeGreaterThan(0);
    for (const a of anomalies) {
      expect(a).toHaveProperty('reason');
      expect(a).toHaveProperty('severity');
      expect(a).toHaveProperty('transactionId');
      expect(['low', 'medium', 'high']).toContain(a.severity);
    }
  });

  test('stdDev / mean / percentile считаются корректно (internals)', () => {
    const { _internals } = require('../services/anomalyService');
    expect(_internals.mean([2, 4, 6])).toBe(4);
    expect(_internals.stdDev([2, 4, 6])).toBeCloseTo(2, 5);
    expect(_internals.stdDev([5])).toBe(0);
    const sorted = [1, 2, 3, 4, 5];
    expect(_internals.percentile(sorted, 0.5)).toBe(3);
    expect(_internals.percentile(sorted, 0)).toBe(1);
    expect(_internals.percentile(sorted, 1)).toBe(5);
  });

  test('detectForUser без userId -> AppError', async () => {
    const anomalyService = require('../services/anomalyService');
    await expect(anomalyService.detectForUser(undefined)).rejects.toMatchObject({
      status: 400,
    });
  });

  // ---------------- GET /api/anomalies ----------------

  test('GET /api/anomalies возвращает аномалии текущего пользователя', async () => {
    const res = await ctx.request
      .get('/api/anomalies')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.anomalies)).toBe(true);
    expect(res.body.data.summary.total).toBe(res.body.data.anomalies.length);
    // Должен присутствовать наш выброс.
    const found = res.body.data.anomalies.some(
      (a) => a.transactionId === ctx.outlierTxId
    );
    expect(found).toBe(true);
  });

  test('GET /api/anomalies без токена -> 401', async () => {
    const res = await ctx.request.get('/api/anomalies');
    expect(res.status).toBe(401);
  });

  // ---------------- GET /api/forecast/balance ----------------

  test('forecast возвращает новые поля коридора и они конечны', async () => {
    const res = await ctx.request
      .get('/api/forecast/balance?days=30')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.forecast)).toBe(true);
    expect(res.body.forecast.length).toBe(31); // i = 0..30

    // Старые поля сохранены (backward compat).
    const first = res.body.forecast[0];
    expect(first).toHaveProperty('date');
    expect(first).toHaveProperty('balance');
    expect(first).toHaveProperty('income');
    expect(first).toHaveProperty('expense');

    // Новые поля коридора.
    expect(first).toHaveProperty('balanceLower');
    expect(first).toHaveProperty('balanceUpper');
    expect(first).toHaveProperty('confidenceBand');

    // Все значения конечны.
    for (const pt of res.body.forecast) {
      expect(Number.isFinite(pt.balance)).toBe(true);
      expect(Number.isFinite(pt.balanceLower)).toBe(true);
      expect(Number.isFinite(pt.balanceUpper)).toBe(true);
      expect(Number.isFinite(pt.confidenceBand)).toBe(true);
      // Коридор симметричен и не сужается ниже нуля.
      expect(pt.balanceUpper).toBeGreaterThanOrEqual(pt.balance - 0.01);
      expect(pt.balanceLower).toBeLessThanOrEqual(pt.balance + 0.01);
    }
  });

  test('forecast summary содержит блок confidence и модель', async () => {
    const res = await ctx.request
      .get('/api/forecast/balance?days=14')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    const s = res.body.summary;
    // Старые поля.
    expect(s).toHaveProperty('currentBalance');
    expect(s).toHaveProperty('projectedBalance');
    expect(s).toHaveProperty('avgDailyExpense');
    expect(s).toHaveProperty('avgDailyIncome');
    // Новые поля.
    expect(s).toHaveProperty('confidence');
    expect(s.confidence).toHaveProperty('residualStd');
    expect(s).toHaveProperty('model');
    expect(['seasonal_trend', 'flat_average']).toContain(s.model);
    expect(Number.isFinite(s.projectedBalance)).toBe(true);
    expect(Number.isFinite(s.confidence.residualStd)).toBe(true);
  });

  test('confidenceBand расширяется с горизонтом (накопление неопределённости)', async () => {
    const res = await ctx.request
      .get('/api/forecast/balance?days=30')
      .set('Authorization', `Bearer ${ctx.token}`);
    const f = res.body.forecast;
    // Если модель активна и есть остатки, последняя полоса >= первой.
    const last = f[f.length - 1].confidenceBand;
    const early = f[1].confidenceBand;
    expect(last).toBeGreaterThanOrEqual(early);
  });
});
