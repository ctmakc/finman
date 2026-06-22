// test/transfers.test.js — двойная запись переводов между счетами.
// Transaction.createTransfer создаёт ДВЕ строки type='transfer' с общим
// transfer_id и атомарно двигает оба баланса; переводы исключены из агрегатов
// income/expense. Роут POST /api/transactions/transfer уже смонтирован в
// server.js -> используем ctx.request (supertest), а точные проверки баланса/
// исключения — прямым вызовом модели против ctx.db.
const { makeApp } = require('./helpers/app');

describe('Transfers — double-entry money movement', () => {
  let ctx, Transaction, db, get, accA, accB;

  beforeAll(async () => {
    ctx = await makeApp();
    Transaction = require('../models/transaction');
    db = require('../db/database');
    get = db.get;

    const a = await db.run(
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [ctx.userId, 'Счёт A', 'UAH', 100, 'checking']
    );
    const b = await db.run(
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [ctx.userId, 'Счёт B', 'UAH', 50, 'checking']
    );
    accA = a.id;
    accB = b.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  const balance = async (id) =>
    (await get('SELECT balance FROM accounts WHERE id = ?', [id])).balance;

  test('moves money exactly: from -X, to +X, two rows share a transfer_id', async () => {
    const beforeA = await balance(accA); // 100
    const beforeB = await balance(accB); // 50

    const res = await Transaction.createTransfer({
      userId: ctx.userId,
      fromAccountId: accA,
      toAccountId: accB,
      amount: 30,
      date: '2026-06-21',
      description: 'Тестовый перевод',
    });

    // Балансы сдвинулись ровно на сумму.
    expect(await balance(accA)).toBe(beforeA - 30); // 70
    expect(await balance(accB)).toBe(beforeB + 30); // 80

    // Создано ровно две строки type='transfer' с одним transfer_id.
    expect(res.transferId).toBeTruthy();
    const rows = await db.query(
      `SELECT account_id, amount, type, transfer_id FROM transactions WHERE transfer_id = ? ORDER BY amount`,
      [res.transferId]
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === 'transfer')).toBe(true);
    expect(rows.every((r) => r.transfer_id === res.transferId)).toBe(true);
    // Списание со счёта A = -30, зачисление на счёт B = +30.
    expect(rows[0]).toMatchObject({ account_id: accA, amount: -30 });
    expect(rows[1]).toMatchObject({ account_id: accB, amount: 30 });
  });

  test('float-safe to the cent (33.33)', async () => {
    const beforeA = await balance(accA);
    const beforeB = await balance(accB);
    await Transaction.createTransfer({
      userId: ctx.userId,
      fromAccountId: accA,
      toAccountId: accB,
      amount: 33.33,
    });
    expect(await balance(accA)).toBe(Math.round((beforeA - 33.33) * 100) / 100);
    expect(await balance(accB)).toBe(Math.round((beforeB + 33.33) * 100) / 100);
  });

  test('transfers are EXCLUDED from income/expense totals (findByUserId type filter unaffected)', async () => {
    // Чистая БД для изоляции агрегатов.
    const local = await makeApp();
    try {
      const ldb = require('../db/database');
      const LTransaction = require('../models/transaction');
      const a = await ldb.run(
        `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
        [local.userId, 'A', 'UAH', 0, 'checking']
      );
      const b = await ldb.run(
        `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
        [local.userId, 'B', 'UAH', 0, 'checking']
      );

      // Один доход, один расход, один перевод.
      await LTransaction.create({ accountId: a.id, userId: local.userId, date: '2026-06-21', amount: 200, type: 'income', category: 'salary', description: 'pay' });
      await LTransaction.create({ accountId: a.id, userId: local.userId, date: '2026-06-21', amount: -50, type: 'expense', category: 'food', description: 'lunch' });
      await LTransaction.createTransfer({ userId: local.userId, fromAccountId: a.id, toAccountId: b.id, amount: 70 });

      // Агрегат доход/расход (тот же фильтр type IN income/expense, что в getStats).
      const agg = await ldb.get(
        `SELECT
           SUM(CASE WHEN type='income'  THEN amount      ELSE 0 END) AS income,
           SUM(CASE WHEN type='expense' THEN ABS(amount) ELSE 0 END) AS expense
         FROM transactions WHERE user_id = ? AND type IN ('income','expense')`,
        [local.userId]
      );
      expect(agg.income).toBe(200);
      expect(agg.expense).toBe(50);

      // findByUserId с фильтром по типу не возвращает строки перевода.
      const incomes = await LTransaction.findByUserId(local.userId, { type: 'income' });
      const expenses = await LTransaction.findByUserId(local.userId, { type: 'expense' });
      expect(incomes.every((t) => t.type === 'income')).toBe(true);
      expect(expenses.every((t) => t.type === 'expense')).toBe(true);
      expect(incomes.some((t) => t.type === 'transfer')).toBe(false);

      // getStats по дате: перевод не попадает ни в income, ни в expense периода.
      const stats = await LTransaction.getStats(local.userId, { groupBy: 'day' });
      const totalIncome = stats.reduce((s, r) => s + (r.income || 0), 0);
      const totalExpense = stats.reduce((s, r) => s + (r.expense || 0), 0);
      expect(totalIncome).toBe(200);
      expect(totalExpense).toBe(50);

      // Но строки перевода физически есть (findByUserId без фильтра типа).
      const all = await LTransaction.findByUserId(local.userId, {});
      expect(all.filter((t) => t.type === 'transfer')).toHaveLength(2);
    } finally {
      await local.close();
    }
  });

  test('same-account transfer is rejected with AppError(400)', async () => {
    await expect(
      Transaction.createTransfer({
        userId: ctx.userId,
        fromAccountId: accA,
        toAccountId: accA,
        amount: 10,
      })
    ).rejects.toMatchObject({ name: 'AppError', status: 400, code: 'SAME_ACCOUNT' });
  });

  test('non-positive amount is rejected with AppError(400)', async () => {
    await expect(
      Transaction.createTransfer({
        userId: ctx.userId,
        fromAccountId: accA,
        toAccountId: accB,
        amount: 0,
      })
    ).rejects.toMatchObject({ name: 'AppError', status: 400, code: 'INVALID_AMOUNT' });

    await expect(
      Transaction.createTransfer({
        userId: ctx.userId,
        fromAccountId: accA,
        toAccountId: accB,
        amount: -5,
      })
    ).rejects.toMatchObject({ name: 'AppError', status: 400, code: 'INVALID_AMOUNT' });
  });

  test('atomicity: a rejected transfer does not move any balance', async () => {
    const beforeA = await balance(accA);
    const beforeB = await balance(accB);
    await expect(
      Transaction.createTransfer({
        userId: ctx.userId,
        fromAccountId: accA,
        toAccountId: accA, // same-account -> reject before any write
        amount: 25,
      })
    ).rejects.toMatchObject({ name: 'AppError' });
    expect(await balance(accA)).toBe(beforeA);
    expect(await balance(accB)).toBe(beforeB);
  });

  describe('POST /api/transactions/transfer (mounted route)', () => {
    let route, rAccA, rAccB;
    beforeAll(async () => {
      route = await makeApp();
      const rdb = require('../db/database');
      const a = await rdb.run(
        `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
        [route.userId, 'RA', 'UAH', 100, 'checking']
      );
      const b = await rdb.run(
        `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
        [route.userId, 'RB', 'UAH', 0, 'checking']
      );
      rAccA = a.id;
      rAccB = b.id;
    });
    afterAll(async () => { if (route) await route.close(); });

    test('201 + moves money via HTTP', async () => {
      const res = await route.request
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${route.token}`)
        .send({ fromAccountId: rAccA, toAccountId: rAccB, amount: 40, date: '2026-06-21' });
      expect(res.status).toBe(201);
      expect(res.body.transferId).toBeTruthy();

      const rdb = require('../db/database');
      const a = await rdb.get('SELECT balance FROM accounts WHERE id = ?', [rAccA]);
      const b = await rdb.get('SELECT balance FROM accounts WHERE id = ?', [rAccB]);
      expect(a.balance).toBe(60);
      expect(b.balance).toBe(40);
    });

    test('400 for same-account via HTTP (AppError envelope)', async () => {
      const res = await route.request
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${route.token}`)
        .send({ fromAccountId: rAccA, toAccountId: rAccA, amount: 10 });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SAME_ACCOUNT');
    });

    test('404 when an account does not belong to the user', async () => {
      const res = await route.request
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${route.token}`)
        .send({ fromAccountId: rAccA, toAccountId: 999999, amount: 5 });
      expect(res.status).toBe(404);
    });

    test('400 when required fields are missing', async () => {
      const res = await route.request
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${route.token}`)
        .send({ fromAccountId: rAccA });
      expect(res.status).toBe(400);
    });
  });
});
