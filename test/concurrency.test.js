// test/concurrency.test.js — целостность баланса при ПАРАЛЛЕЛЬНЫХ записях.
// Без сериализации (transaction-мьютекс) параллельные Transaction.create на
// одном shared-соединении переплели бы BEGIN..COMMIT ("cannot start a
// transaction within a transaction") и/или потеряли бы обновления баланса.
const { makeApp } = require('./helpers/app');

describe('Concurrency — balance integrity under parallel writes', () => {
  let ctx, Transaction, get, accountId;

  beforeAll(async () => {
    ctx = await makeApp();
    Transaction = require('../models/transaction');
    const db = require('../db/database');
    get = db.get;
    const acc = await db.run(
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [ctx.userId, 'Concurrency', 'UAH', 0, 'checking']
    );
    accountId = acc.id;
  });

  afterAll(async () => { if (ctx) await ctx.close(); });

  const mkTx = (amount, type) => Transaction.create({
    accountId, userId: ctx.userId, date: '2026-06-20', amount, type, category: 't', description: 'c',
  });

  test('20 concurrent +10.00 -> balance exactly 200.00 (no lost updates, no interleave error)', async () => {
    const ops = Array.from({ length: 20 }, () => mkTx(10, 'income'));
    await Promise.all(ops); // должно резолвиться без ошибок BEGIN-внутри-BEGIN
    const acc = await get('SELECT balance FROM accounts WHERE id = ?', [accountId]);
    expect(acc.balance).toBe(200);
    const cnt = await get('SELECT COUNT(*) AS c FROM transactions WHERE account_id = ?', [accountId]);
    expect(cnt.c).toBe(20);
  });

  test('mixed concurrent income/expense stays exact to the cent', async () => {
    // от 200: +5*3.33 и -5*1.11 = 200 + 16.65 - 5.55 = 211.10
    const ops = [];
    for (let i = 0; i < 5; i++) ops.push(mkTx(3.33, 'income'));
    for (let i = 0; i < 5; i++) ops.push(mkTx(-1.11, 'expense'));
    await Promise.all(ops);
    const acc = await get('SELECT balance FROM accounts WHERE id = ?', [accountId]);
    expect(acc.balance).toBe(211.1);
  });

  test('concurrent creates + deletes net out exactly', async () => {
    // создаём 10 по +7, параллельно. Затем удаляем половину, параллельно.
    const created = await Promise.all(Array.from({ length: 10 }, () => mkTx(7, 'income')));
    const before = await get('SELECT balance FROM accounts WHERE id = ?', [accountId]);
    expect(before.balance).toBe(281.1); // 211.10 + 70
    await Promise.all(created.slice(0, 5).map((t) => Transaction.delete(t.id, ctx.userId)));
    const after = await get('SELECT balance FROM accounts WHERE id = ?', [accountId]);
    // ровно 246.10 (SQLite ROUND держит копейки; наивное JS 281.1-35 дало бы 246.10000000000002)
    expect(after.balance).toBe(246.1);
  });
});
