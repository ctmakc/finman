// test/reconcile.test.js — сверка счёта с банковской выпиской (service layer).
// Роутер reconcile ещё НЕ смонтирован в server.js -> тестируем сервис напрямую
// против реальной (временной) БД из makeApp(). Сеем через raw sqlite.
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

describe('Reconcile service — cleared-balance math + balancing adjustment', () => {
  let ctx;
  let reconcileService;
  let accountId;

  beforeAll(async () => {
    ctx = await makeApp();
    reconcileService = require('../services/reconcileService');
    const uid = ctx.userId;

    // Счёт со стартовым балансом 0; баланс будем держать в согласии с транзакциями.
    const acc = await dbRun(
      ctx.db,
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [uid, 'Reconcile Acc', 'UAH', 0, 'checking']
    );
    accountId = acc.id;

    const tx = (date, amount, cleared, desc) =>
      dbRun(
        ctx.db,
        `INSERT INTO transactions (account_id,user_id,date,amount,type,category,description,cleared)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          accountId,
          uid,
          date,
          amount,
          amount >= 0 ? 'income' : 'expense',
          'Test',
          desc,
          cleared,
        ]
      );

    // Проведённые (cleared=1): +100.00, +50.50, -20.25  => clearedBalance = 130.25
    await tx('2026-06-01', 100.0, 1, 'salary');
    await tx('2026-06-02', 50.5, 1, 'refund');
    await tx('2026-06-03', -20.25, 1, 'coffee');
    // Непроведённые (cleared=0): -30.00 и +75.00 => unclearedTotal = 45.00
    await tx('2026-06-10', -30.0, 0, 'pending card');
    await tx('2026-06-11', 75.0, 0, 'pending transfer');

    // Держим хранимый баланс счёта в согласии с суммой всех транзакций:
    // 100 + 50.5 - 20.25 - 30 + 75 = 175.25
    await dbRun(ctx.db, `UPDATE accounts SET balance = ? WHERE id = ?`, [175.25, accountId]);
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('startReconcile computes cleared balance, uncleared total and delta', async () => {
    // Выписка показывает 130.25 -> ровно очищенный баланс -> delta 0, reconciled.
    const state = await reconcileService.startReconcile(accountId, ctx.userId, 130.25);
    expect(state.clearedBalance).toBe(130.25);
    expect(state.unclearedTotal).toBe(45.0);
    expect(state.bookBalance).toBe(175.25);
    expect(state.delta).toBe(0);
    expect(state.reconciled).toBe(true);
    expect(state.uncleared).toHaveLength(2);
  });

  test('delta = statementBalance - clearedBalance (float-safe)', async () => {
    // Выписка 200.00 -> delta = 200 - 130.25 = 69.75
    const state = await reconcileService.startReconcile(accountId, ctx.userId, 200.0);
    expect(state.delta).toBe(69.75);
    expect(state.reconciled).toBe(false);
  });

  test('suspect flags an uncleared tx whose amount equals the delta', async () => {
    // Если выписка = clearedBalance + 75.00 = 205.25, delta=75.00 == pending transfer
    const state = await reconcileService.startReconcile(accountId, ctx.userId, 205.25);
    expect(state.delta).toBe(75.0);
    expect(state.suspect).toHaveLength(1);
    expect(state.suspect[0].amount).toBe(75.0);
  });

  test('markCleared moves an uncleared tx into the cleared balance (no balance change)', async () => {
    const before = await dbGet(ctx.db, 'SELECT balance FROM accounts WHERE id = ?', [accountId]);
    const pending = await dbGet(
      ctx.db,
      `SELECT id FROM transactions WHERE account_id = ? AND cleared = 0 AND amount = 75.0`,
      [accountId]
    );
    const result = await reconcileService.markCleared([pending.id], ctx.userId);
    expect(result.updated).toBe(1);

    // Баланс счёта не изменился (cleared — только признак сверки).
    const after = await dbGet(ctx.db, 'SELECT balance FROM accounts WHERE id = ?', [accountId]);
    expect(after.balance).toBe(before.balance);

    // Теперь очищенный баланс = 130.25 + 75 = 205.25
    const state = await reconcileService.startReconcile(accountId, ctx.userId, 205.25);
    expect(state.clearedBalance).toBe(205.25);
    expect(state.delta).toBe(0);

    // Откатываем для независимости остальных тестов.
    await reconcileService.markUncleared([pending.id], ctx.userId);
  });

  test('markCleared ignores empty / invalid ids', async () => {
    expect((await reconcileService.markCleared([], ctx.userId)).updated).toBe(0);
    expect((await reconcileService.markCleared(['x', -1, 0], ctx.userId)).updated).toBe(0);
  });

  test('postAdjustment creates a balancing cleared transaction and moves the balance', async () => {
    const accBefore = await dbGet(ctx.db, 'SELECT balance FROM accounts WHERE id = ?', [accountId]);
    const clearedBefore = await reconcileService.startReconcile(accountId, ctx.userId, 0);

    // Закрываем расхождение +12.30: создаётся income-транзакция cleared=1.
    const tx = await reconcileService.postAdjustment(accountId, ctx.userId, 12.3);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBe(12.3);
    expect(tx.type).toBe('income');
    expect(tx.cleared).toBe(1);

    // Баланс счёта вырос ровно на 12.30 (атомарный updateBalance).
    const accAfter = await dbGet(ctx.db, 'SELECT balance FROM accounts WHERE id = ?', [accountId]);
    expect(accAfter.balance).toBe(Math.round((accBefore.balance + 12.3) * 100) / 100);

    // Очищенный баланс тоже вырос на 12.30 (транзакция cleared).
    const clearedAfter = await reconcileService.startReconcile(accountId, ctx.userId, 0);
    expect(clearedAfter.clearedBalance).toBe(
      Math.round((clearedBefore.clearedBalance + 12.3) * 100) / 100
    );

    // Транзакция реально записана как cleared в БД.
    const row = await dbGet(ctx.db, 'SELECT * FROM transactions WHERE id = ?', [tx.id]);
    expect(row.cleared).toBe(1);
    expect(row.amount).toBe(12.3);
  });

  test('postAdjustment with negative delta posts an expense', async () => {
    const tx = await reconcileService.postAdjustment(accountId, ctx.userId, -5.55);
    expect(tx.amount).toBe(-5.55);
    expect(tx.type).toBe('expense');
  });

  test('postAdjustment with zero delta is a no-op', async () => {
    const tx = await reconcileService.postAdjustment(accountId, ctx.userId, 0);
    expect(tx).toBeNull();
  });

  test('reconcile after adjustment closes the gap exactly', async () => {
    // Текущий очищенный баланс:
    const state0 = await reconcileService.startReconcile(accountId, ctx.userId, 0);
    const target = Math.round((state0.clearedBalance + 33.33) * 100) / 100;
    // Выписка target -> delta 33.33; постим корректировку на этот delta.
    const state1 = await reconcileService.startReconcile(accountId, ctx.userId, target);
    expect(state1.delta).toBe(33.33);
    await reconcileService.postAdjustment(accountId, ctx.userId, state1.delta);
    const state2 = await reconcileService.startReconcile(accountId, ctx.userId, target);
    expect(state2.delta).toBe(0);
    expect(state2.reconciled).toBe(true);
  });

  test('startReconcile throws for an account not owned by the user', async () => {
    await expect(
      reconcileService.startReconcile(999999, ctx.userId, 100)
    ).rejects.toThrow();
  });
});
