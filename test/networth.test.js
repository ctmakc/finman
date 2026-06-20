// test/networth.test.js — валюто-зависимый net worth (networth-fx stream).
//
// Покрывает:
//   1) аккаунты в РАЗНЫХ валютах сводятся в базовую валюту через курсы
//      (а не наивной суммой балансов);
//   2) отсутствующий курс -> fallback 1:1 + флаг в missingRates;
//   3) snapshot сохраняется (идемпотентно по дате);
//   4) trend возвращает точки и change.

const { makeApp } = require('./helpers/app');

// db-хелперы требуем ПОСЛЕ makeApp (внутри каждого теста ctx уже привязал
// require-кэш к временной БД), поэтому импортируем лениво в каждом блоке.
function getDb() {
  return require('../db/database');
}

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

describe('networth-fx: currency-aware net worth', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();

    // Базовая валюта пользователя — UAH (дефолт user_currency_settings).
    // Курсы: 1 USD = 40 UAH, 1 EUR = 44 UAH. GBP — НАМЕРЕННО без курса.
    const today = new Date().toISOString().split('T')[0];
    await db.run(
      `INSERT INTO currency_rates (from_currency, to_currency, rate, source, date)
       VALUES (?, ?, ?, 'test', ?)`,
      ['USD', 'UAH', 40, today]
    );
    await db.run(
      `INSERT INTO currency_rates (from_currency, to_currency, rate, source, date)
       VALUES (?, ?, ?, 'test', ?)`,
      ['EUR', 'UAH', 44, today]
    );

    // Счета в трёх валютах:
    //   100 UAH               -> 100   UAH
    //   100 USD * 40          -> 4000  UAH
    //   100 EUR * 44          -> 4400  UAH
    //   50  GBP (нет курса)   -> 50    UAH (fallback 1:1, флаг)
    const accounts = [
      ['UAH', 100],
      ['USD', 100],
      ['EUR', 100],
      ['GBP', 50],
    ];
    for (const [currency, balance] of accounts) {
      await db.run(
        `INSERT INTO accounts (user_id, name, currency, balance, is_active)
         VALUES (?, ?, ?, ?, 1)`,
        [ctx.userId, `acc-${currency}`, currency, balance]
      );
    }

    // Долг 80 USD * 40 = 3200 UAH (обязательство).
    await db.run(
      `INSERT INTO debts (user_id, name, type, amount, paid_amount, currency, start_date, is_active)
       VALUES (?, 'loan', 'loan', 80, 0, 'USD', ?, 1)`,
      [ctx.userId, today]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /current конвертирует разновалютные счета (не наивная сумма)', async () => {
    const res = await ctx.request.get('/api/networth/current').set(AUTH(ctx.token));
    expect(res.status).toBe(200);

    expect(res.body.baseCurrency).toBe('UAH');

    // Наивная сумма балансов была бы 100+100+100+50 = 350.
    // Конвертированная: 100 + 4000 + 4400 + 50(fallback) = 8550.
    expect(res.body.assetsBreakdown.accounts).toBe(8550);
    expect(res.body.assetsBreakdown.accounts).not.toBe(350);
    expect(res.body.totalAssets).toBe(8550);

    // Долг 80 USD -> 3200 UAH.
    expect(res.body.totalLiabilities).toBe(3200);
    expect(res.body.netWorth).toBe(8550 - 3200);
  });

  test('отсутствующий курс (GBP) флагируется в missingRates, считается 1:1', async () => {
    const res = await ctx.request.get('/api/networth/current').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.hasMissingRates).toBe(true);
    expect(res.body.missingRates).toContain('GBP');
    // Валюты с курсом не должны попадать в missingRates.
    expect(res.body.missingRates).not.toContain('USD');
    expect(res.body.missingRates).not.toContain('EUR');
  });

  test('POST /snapshot сохраняет снимок в базовой валюте', async () => {
    const res = await ctx.request
      .post('/api/networth/snapshot')
      .set(AUTH(ctx.token))
      .send({ notes: 'test snapshot' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.data.netWorth).toBe(8550 - 3200);

    const row = await db.get(
      `SELECT * FROM networth_snapshots WHERE id = ?`,
      [res.body.id]
    );
    expect(row).toBeTruthy();
    expect(row.user_id).toBe(ctx.userId);
    expect(row.net_worth).toBe(5350);
    expect(row.total_assets).toBe(8550);
    expect(row.total_liabilities).toBe(3200);
  });

  test('повторный snapshot за тот же день не плодит строки (идемпотентность)', async () => {
    await ctx.request.post('/api/networth/snapshot').set(AUTH(ctx.token)).send({});
    const rows = await db.query(
      `SELECT * FROM networth_snapshots WHERE user_id = ?`,
      [ctx.userId]
    );
    // Оба снимка в один день -> одна строка.
    expect(rows.length).toBe(1);
  });
});

describe('networth-fx: trend', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();

    // Вставляем два снимка на разные даты руками, чтобы проверить тренд.
    await db.run(
      `INSERT INTO networth_snapshots
         (user_id, total_assets, total_liabilities, net_worth, assets_breakdown, liabilities_breakdown, snapshot_date)
       VALUES (?, 1000, 0, 1000, '{}', '{}', '2024-01-01')`,
      [ctx.userId]
    );
    await db.run(
      `INSERT INTO networth_snapshots
         (user_id, total_assets, total_liabilities, net_worth, assets_breakdown, liabilities_breakdown, snapshot_date)
       VALUES (?, 1500, 0, 1500, '{}', '{}', '2024-02-01')`,
      [ctx.userId]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /trend возвращает упорядоченные точки и change', async () => {
    const res = await ctx.request
      .get('/api/networth/trend')
      .set(AUTH(ctx.token));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(Array.isArray(data.points)).toBe(true);
    expect(data.points.length).toBe(2);

    // Хронологический порядок.
    expect(data.points[0].date).toBe('2024-01-01');
    expect(data.points[1].date).toBe('2024-02-01');
    expect(data.points[0].netWorth).toBe(1000);
    expect(data.points[1].netWorth).toBe(1500);

    // change: 1500 - 1000 = +500 (+50%).
    expect(data.change.amount).toBe(500);
    expect(data.change.percent).toBe(50);
  });

  test('GET /trend без снимков -> пустые точки, нулевой change', async () => {
    const fresh = await makeApp();
    try {
      const res = await fresh.request
        .get('/api/networth/trend')
        .set(AUTH(fresh.token));
      expect(res.status).toBe(200);
      expect(res.body.data.points).toEqual([]);
      expect(res.body.data.change.amount).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
