// test/stats-currency-receipts.test.js — wave3/stats:
//   - /api/currency/convert без курса -> 422 с текстом (раньше success:false без
//     result -> фронт падал на undefined.toFixed);
//   - CAD/USD/EUR/UAH конвертируются всегда (страховочная таблица, Net Worth без
//     «Нет курса для CAD»);
//   - /api/receipts/stats/summary отдаёт total/processed/pending/totalAmount.
const { makeApp } = require('./helpers/app');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('currency convert + fallback rates', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('CAD -> USD без строк в currency_rates -> 200 через fallback, с result и source', async () => {
    const before = await db.get(`SELECT COUNT(*) as c FROM currency_rates`);
    expect(before.c).toBe(0);
    const res = await ctx.request.get('/api/currency/convert?amount=100&from=CAD&to=USD').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.result).toBe('number');
    expect(res.body.result).toBeGreaterThan(50);
    expect(res.body.result).toBeLessThan(100);
    expect(res.body.amount).toBe(res.body.result);
    expect(res.body.rate).toBeGreaterThan(0);
    expect(res.body.source).toBe('fallback');
    const seeded = await db.get(`SELECT source FROM currency_rates WHERE from_currency = 'CAD' AND to_currency = 'USD'`);
    expect(seeded.source).toBe('fallback');
  });

  test('CAD -> UAH кросс-курс через USD, EUR -> CAD тоже', async () => {
    const r1 = await ctx.request.get('/api/currency/convert?amount=10&from=CAD&to=UAH').set(AUTH(ctx.token));
    expect(r1.status).toBe(200);
    expect(r1.body.result).toBeGreaterThan(100); // ~300 грн
    const r2 = await ctx.request.get('/api/currency/convert?amount=10&from=eur&to=cad').set(AUTH(ctx.token));
    expect(r2.status).toBe(200);
    expect(r2.body.from).toBe('EUR');
    expect(r2.body.result).toBeGreaterThan(10);
  });

  test('сохранённый курс важнее fallback (дата свежее)', async () => {
    const today = new Date().toISOString().split('T')[0];
    await db.run(
      `INSERT OR REPLACE INTO currency_rates (from_currency, to_currency, rate, source, date) VALUES ('CAD','USD',0.5,'manual',?)`,
      [today]
    );
    const res = await ctx.request.get('/api/currency/convert?amount=100&from=CAD&to=USD').set(AUTH(ctx.token));
    expect(res.body.rate).toBe(0.5);
    expect(res.body.result).toBe(50);
    expect(res.body.source).toBe('stored');
  });

  test('неизвестная валюта -> 422 с понятным сообщением, не 500 и не undefined', async () => {
    const res = await ctx.request.get('/api/currency/convert?amount=100&from=XXX&to=USD').set(AUTH(ctx.token));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(true);
    expect(res.body.code).toBe('RATE_NOT_FOUND');
    expect(res.body.message).toMatch(/XXX/);
  });

  test('невалидная сумма / код -> 400; отсутствующие параметры -> 400', async () => {
    const bad = await ctx.request.get('/api/currency/convert?amount=abc&from=CAD&to=USD').set(AUTH(ctx.token));
    expect(bad.status).toBe(400);
    const badCode = await ctx.request.get('/api/currency/convert?amount=1&from=C%24&to=USD').set(AUTH(ctx.token));
    expect(badCode.status).toBe(400);
    const missing = await ctx.request.get('/api/currency/convert?from=CAD&to=USD').set(AUTH(ctx.token));
    expect(missing.status).toBe(400);
  });

  test('GET /api/currency/rate/:from/:to -> fallback вместо 404 для базовых валют', async () => {
    const res = await ctx.request.get('/api/currency/rate/UAH/EUR').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.rate).toBeGreaterThan(0);
    const none = await ctx.request.get('/api/currency/rate/XXX/YYY').set(AUTH(ctx.token));
    expect(none.status).toBe(404);
    // GBP вне базового набора: без сохранённого курса -> 404, никаких выдуманных значений.
    const gbp = await ctx.request.get('/api/currency/rate/GBP/USD').set(AUTH(ctx.token));
    expect(gbp.status).toBe(404);
  });

  test('ensureRates в тестах не ходит в сеть (FX_LIVE не задан)', async () => {
    const currencyService = require('../services/currencyService');
    let called = 0;
    const orig = currencyService._fetchStooqPair;
    currencyService._fetchStooqPair = async () => { called += 1; throw new Error('network'); };
    try {
      await db.run(`DELETE FROM currency_rates WHERE from_currency IN ('CAD','EUR')`);
      const r = await currencyService.ensureRates(['EUR']);
      expect(r.seeded).toEqual(['EUR']);
      expect(called).toBe(0);
      // Явный live: при падении сети — всё равно fallback.
      const r2 = await currencyService.ensureRates(['CAD'], { live: true });
      expect(called).toBe(1);
      expect(r2.seeded).toEqual(['CAD']);
      // Валюта вне базового набора без курса -> missing (1:1 с флагом в Net Worth), не выдумываем.
      const r3 = await currencyService.ensureRates(['GBP']);
      expect(r3.missing).toEqual(['GBP']);
    } finally {
      currencyService._fetchStooqPair = orig;
    }
  });

  test('live Stooq CSV парсится и сохраняется как source=stooq', async () => {
    const currencyService = require('../services/currencyService');
    const orig = currencyService._fetchStooqPair;
    currencyService._fetchStooqPair = async (symbol) => {
      expect(symbol).toBe('chfusd');
      return 'Symbol,Date,Time,Open,High,Low,Close,Volume\nCHFUSD,2026-10-09,22:00:00,1.25,1.26,1.24,1.2567,0\n';
    };
    try {
      await db.run(`DELETE FROM currency_rates WHERE from_currency = 'CHF'`);
      const r = await currencyService.ensureRates(['CHF'], { live: true });
      expect(r.fetched).toEqual(['CHF']);
      const row = await db.get(`SELECT rate, source FROM currency_rates WHERE from_currency = 'CHF' AND to_currency = 'USD'`);
      expect(row.source).toBe('stooq');
      expect(row.rate).toBeCloseTo(1.2567, 4);
    } finally {
      currencyService._fetchStooqPair = orig;
    }
  });
});

describe('networth: CAD конвертируется без «Нет курса»', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    // This user keeps UAH as base currency (product default is CAD).
    await db.run(
      `INSERT INTO user_currency_settings (user_id, base_currency, display_currencies)
       VALUES (?, 'UAH', '["UAH","USD","EUR"]')`,
      [ctx.userId]
    );
    await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active) VALUES (?, 'CAD acc', 'CAD', 1000, 1)`,
      [ctx.userId]
    );
    await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active) VALUES (?, 'UAH acc', 'UAH', 500, 1)`,
      [ctx.userId]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /api/networth/current -> missingRates пуст, CAD сконвертирован (не 1:1)', async () => {
    const res = await ctx.request.get('/api/networth/current').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.baseCurrency).toBe('UAH');
    expect(res.body.hasMissingRates).toBe(false);
    expect(res.body.missingRates).toEqual([]);
    // 1000 CAD ≈ 30 000 грн + 500 грн — заведомо больше 1:1 (1500).
    expect(res.body.assetsBreakdown.accounts).toBeGreaterThan(10000);
  });
});

describe('receipts stats shape', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    await db.run(`INSERT INTO receipts (user_id, merchant, total_amount, receipt_date, is_processed) VALUES (?, 'A', 100.5, '2026-10-01', 1)`, [ctx.userId]);
    await db.run(`INSERT INTO receipts (user_id, merchant, total_amount, receipt_date, is_processed) VALUES (?, 'B', 49.5, '2026-10-02', 0)`, [ctx.userId]);
    await db.run(`INSERT INTO receipts (user_id, merchant, total_amount, is_processed) VALUES (?, 'C', NULL, 0)`, [ctx.userId]);
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /api/receipts/stats/summary -> total/processed/pending/totalAmount', async () => {
    const res = await ctx.request.get('/api/receipts/stats/summary').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, processed: 1, pending: 2, totalAmount: 150 });
    // legacy-поля сохранены
    expect(res.body.totalReceipts).toBe(3);
    expect(res.body.pendingReceipts).toBe(2);
  });

  test('пустой пользователь -> нули, не undefined', async () => {
    await db.run(`DELETE FROM receipts WHERE user_id = ?`, [ctx.userId]);
    const res = await ctx.request.get('/api/receipts/stats/summary').set(AUTH(ctx.token));
    expect(res.body).toMatchObject({ total: 0, processed: 0, pending: 0, totalAmount: 0 });
  });
});
