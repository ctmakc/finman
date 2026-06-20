// test/sync.test.js — тесты фоновой банковской синхронизации (F6).
//
// Стратегия: МОКАЕМ bankApiService.getTransactions (чтобы не ходить в реальные
// банки), сеем bank_connection + account, прогоняем syncScheduler.runOnce и
// проверяем: (1) новые транзакции вставлены ОДИН раз; (2) повторный прогон НЕ
// создаёт дублей. Плюс проверяем маршруты POST /api/sync/run и GET
// /api/sync/status.
//
// ВАЖНО про изоляцию: harness makeApp() сбрасывает require-кэш и заново требует
// services/* . Поэтому bankApiService, который использует scheduler, — это тот
// же синглтон, что мы получаем require() ПОСЛЕ makeApp(). Мокаем метод на нём.

const path = require('path');
const { makeApp } = require('./helpers/app');

const PROJECT_ROOT = path.join(__dirname, '..');

// Фиксированный набор «банковских» транзакций для мока.
const MOCK_BANK_TX = [
  {
    id: 'bank-tx-1',
    date: '2026-06-01',
    description: 'Salary',
    category: 'Зарплата',
    amount: 1000,
    type: 'income',
  },
  {
    id: 'bank-tx-2',
    date: '2026-06-02',
    description: 'Grocery',
    category: 'Продукты',
    amount: -50.25,
    type: 'expense',
  },
  {
    id: 'bank-tx-3',
    date: '2026-06-03',
    description: 'Coffee',
    category: 'Рестораны',
    amount: -3.5,
    type: 'expense',
  },
];

// Хелпер: посчитать транзакции счёта в БД.
function countTx(ctx, accountId, userId) {
  return new Promise((resolve, reject) => {
    ctx.db.get(
      `SELECT COUNT(*) AS c FROM transactions WHERE account_id = ? AND user_id = ?`,
      [accountId, userId],
      (err, row) => (err ? reject(err) : resolve(row.c))
    );
  });
}

// Хелпер: создать счёт пользователя с заданным bank_name.
function seedAccount(ctx, userId, bankName) {
  return new Promise((resolve, reject) => {
    ctx.db.run(
      `INSERT INTO accounts (user_id, name, account_number, bank_name, currency, balance, account_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, 'Main', 'acc-0001', bankName, 'UAH', 0, 'checking'],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

// Хелпер: создать активное банковское подключение.
function seedConnection(ctx, userId, bankId) {
  return new Promise((resolve, reject) => {
    ctx.db.run(
      `INSERT INTO bank_connections (user_id, bank_id, access_token, is_active)
       VALUES (?, ?, ?, 1)`,
      [userId, bankId, 'token-xyz'],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

describe('syncScheduler.runOnce — дедупликация', () => {
  let ctx;
  let scheduler;
  let bankApiService;
  let accountId;
  let originalGetTransactions;

  beforeAll(async () => {
    ctx = await makeApp();

    // Берём те же модули-синглтоны, что использует scheduler.
    scheduler = require(path.join(PROJECT_ROOT, 'services', 'syncScheduler.js'));
    bankApiService = require(path.join(PROJECT_ROOT, 'services', 'bankApiService.js'));

    // МОК: getTransactions всегда возвращает фиксированный список.
    originalGetTransactions = bankApiService.getTransactions;
    bankApiService.getTransactions = jest.fn(async () => MOCK_BANK_TX.slice());

    // Сеем подключение (Monobank -> name 'Monobank') и счёт с тем же bank_name.
    await seedConnection(ctx, ctx.userId, 'monobank');
    accountId = await seedAccount(ctx, ctx.userId, 'Monobank');
  });

  afterAll(async () => {
    if (bankApiService && originalGetTransactions) {
      bankApiService.getTransactions = originalGetTransactions;
    }
    if (ctx) await ctx.close();
  });

  test('первый прогон вставляет все новые транзакции один раз', async () => {
    const summary = await scheduler.runOnce(ctx.userId);

    expect(summary.fetched).toBe(MOCK_BANK_TX.length);
    expect(summary.inserted).toBe(MOCK_BANK_TX.length);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toHaveLength(0);

    const count = await countTx(ctx, accountId, ctx.userId);
    expect(count).toBe(MOCK_BANK_TX.length);
  });

  test('повторный прогон НЕ создаёт дублей (все пропущены)', async () => {
    const summary = await scheduler.runOnce(ctx.userId);

    expect(summary.fetched).toBe(MOCK_BANK_TX.length);
    expect(summary.inserted).toBe(0);
    expect(summary.skipped).toBe(MOCK_BANK_TX.length);

    const count = await countTx(ctx, accountId, ctx.userId);
    // Кол-во транзакций не изменилось — дублей нет.
    expect(count).toBe(MOCK_BANK_TX.length);
  });

  test('новая банковская транзакция вставляется, существующие пропускаются', async () => {
    const extra = {
      id: 'bank-tx-4',
      date: '2026-06-04',
      description: 'Taxi',
      category: 'Транспорт',
      amount: -12.0,
      type: 'expense',
    };
    bankApiService.getTransactions.mockImplementationOnce(async () => [
      ...MOCK_BANK_TX,
      extra,
    ]);

    const summary = await scheduler.runOnce(ctx.userId);
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(MOCK_BANK_TX.length);

    const count = await countTx(ctx, accountId, ctx.userId);
    expect(count).toBe(MOCK_BANK_TX.length + 1);
  });
});

describe('routes /api/sync', () => {
  let ctx;
  let scheduler;
  let bankApiService;
  let originalGetTransactions;

  beforeAll(async () => {
    ctx = await makeApp();
    scheduler = require(path.join(PROJECT_ROOT, 'services', 'syncScheduler.js'));
    bankApiService = require(path.join(PROJECT_ROOT, 'services', 'bankApiService.js'));
    originalGetTransactions = bankApiService.getTransactions;
    bankApiService.getTransactions = jest.fn(async () => MOCK_BANK_TX.slice());

    await seedConnection(ctx, ctx.userId, 'monobank');
    await seedAccount(ctx, ctx.userId, 'Monobank');
  });

  afterAll(async () => {
    if (bankApiService && originalGetTransactions) {
      bankApiService.getTransactions = originalGetTransactions;
    }
    if (ctx) await ctx.close();
  });

  test('GET /api/sync/status требует авторизацию', async () => {
    const res = await ctx.request.get('/api/sync/status');
    expect(res.status).toBe(401);
  });

  test('GET /api/sync/status возвращает состояние планировщика', async () => {
    const res = await ctx.request
      .get('/api/sync/status')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('enabled');
    expect(res.body.data).toHaveProperty('running');
    expect(res.body.data).toHaveProperty('schedule');
  });

  test('POST /api/sync/run синхронизирует транзакции текущего пользователя', async () => {
    const res = await ctx.request
      .post('/api/sync/run')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary.inserted).toBe(MOCK_BANK_TX.length);
    expect(res.body.data.summary.errors).toBe(0);
  });

  test('повторный POST /api/sync/run не создаёт дублей', async () => {
    const res = await ctx.request
      .post('/api/sync/run')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(200);
    expect(res.body.data.summary.inserted).toBe(0);
    expect(res.body.data.summary.skipped).toBe(MOCK_BANK_TX.length);
  });

  test('POST /api/sync/run без авторизации -> 401', async () => {
    const res = await ctx.request.post('/api/sync/run');
    expect(res.status).toBe(401);
  });
});

describe('syncScheduler start/stop/status — управление cron', () => {
  let scheduler;

  beforeAll(() => {
    scheduler = require(path.join(PROJECT_ROOT, 'services', 'syncScheduler.js'));
  });

  afterAll(() => {
    scheduler.stop();
  });

  test('status отражает running после start и false после stop', () => {
    expect(scheduler.status().running).toBe(false);
    scheduler.start();
    expect(scheduler.status().running).toBe(true);
    scheduler.stop();
    expect(scheduler.status().running).toBe(false);
  });

  test('повторный start идемпотентен (не падает)', () => {
    const t1 = scheduler.start();
    const t2 = scheduler.start();
    expect(t1).toBe(t2);
    scheduler.stop();
  });

  test('isEnabled читает env SYNC_ENABLED', () => {
    const prev = process.env.SYNC_ENABLED;
    process.env.SYNC_ENABLED = 'true';
    expect(scheduler.isEnabled()).toBe(true);
    process.env.SYNC_ENABLED = 'false';
    expect(scheduler.isEnabled()).toBe(false);
    delete process.env.SYNC_ENABLED;
    expect(scheduler.isEnabled()).toBe(false);
    if (prev !== undefined) process.env.SYNC_ENABLED = prev;
  });
});
