// test/perf.test.js — базовая защита от случайной N+1-регрессии
// (security-perf-v2). ADDITIVE: только измерение времени ответа на
// работающем app, без изменения роутов. Детерминирован и офлайн.
//
// Идея: на пользователе с ~200 транзакциями GET /api/transactions должен
// отвечать заметно быстрее щедрой границы. Текущая реализация делает ОДИН
// JOIN-запрос (models/transaction.findByUserId); если кто-то случайно введёт
// запрос-на-строку (N+1), время вырастет на порядок и тест упадёт.

const { makeApp } = require('./helpers/app');

function getDb() {
  return require('../db/database');
}

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

const TX_COUNT = 200;
// Щедрая верхняя граница: на одном JOIN-запросе ответ — единицы/десятки мс.
// 1500мс ловит только настоящую N+1/деградацию, не флапает на медленном CI.
const TIME_BUDGET_MS = 1500;

describe('perf: GET /api/transactions на ~200 транзакциях', () => {
  let ctx;
  let db;
  let accountId;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();

    // Один счёт пользователя (JOIN transactions->accounts требует его наличия).
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active)
       VALUES (?, 'perf-account', 'UAH', 0, 1)`,
      [ctx.userId]
    );
    accountId = acc.id;

    // Массовая вставка ~200 транзакций напрямую в БД (быстро, в одной
    // транзакции), без обращения к API — это подготовка данных, не объект теста.
    await db.run('BEGIN TRANSACTION');
    try {
      for (let i = 0; i < TX_COUNT; i++) {
        const day = String((i % 28) + 1).padStart(2, '0');
        const amount = (i % 2 === 0 ? 1 : -1) * (10 + (i % 50));
        await db.run(
          `INSERT INTO transactions
             (account_id, user_id, date, description, category, amount, type)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            accountId,
            ctx.userId,
            `2024-03-${day}`,
            `perf-tx-${i}`,
            i % 3 === 0 ? 'Food' : 'Other',
            amount,
            amount >= 0 ? 'income' : 'expense',
          ]
        );
      }
      await db.run('COMMIT');
    } catch (e) {
      await db.run('ROLLBACK');
      throw e;
    }
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('seed создал ~200 транзакций (sanity)', async () => {
    const row = await db.get(
      `SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?`,
      [ctx.userId]
    );
    expect(row.c).toBe(TX_COUNT);
  });

  test(`страница 50 транзакций отвечает < ${TIME_BUDGET_MS}мс`, async () => {
    // Прогрев: первый запрос инициализирует passport/маршруты, его не меряем.
    await ctx.request.get('/api/transactions').set(AUTH(ctx.token));

    const start = Date.now();
    const res = await ctx.request
      .get('/api/transactions')
      .query({ limit: 50, page: 1 })
      .set(AUTH(ctx.token));
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(50);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });

  test(`выборка всех ~200 транзакций отвечает < ${TIME_BUDGET_MS}мс`, async () => {
    const start = Date.now();
    const res = await ctx.request
      .get('/api/transactions')
      .query({ limit: 500, page: 1 })
      .set(AUTH(ctx.token));
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(TX_COUNT);
    // Каждая строка пришла с account_name из JOIN -> N+1 не нужен.
    expect(res.body[0]).toHaveProperty('account_name');
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });
});
