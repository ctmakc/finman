// test/money-core.test.js — корректность денежного ядра (воспроизведение
// backend-audit/repro.js пунктов 1, 2, 4, 5 + расшаренные счета).
//
//   1) POST /api/accounts {balance} — начальный баланс записывается ОДИН раз,
//      строка-«открытие» имеет type='opening' и не попадает в доходы/расходы.
//   2) Перевод = две строки с общим transfer_id: удаление/правка одной ноги
//      атомарно трогает обе и оба баланса.
//   3) Знак суммы определяется типом: expense < 0, income > 0 — и при создании,
//      и при PUT (смена типа/суммы корректно переносит дельту на баланс).
//   4) Расшаренные счета: транзакции контрибьютора пишутся в леджер владельца
//      (user_id = владелец), видны владельцу в /api/transactions и всем
//      участникам в /api/accounts/:id/transactions. Нет 500 при пропавшем счёте.
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

async function makeUser(ctx, username) {
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcrypt');
  const config = require('../config/config');
  const hash = await bcrypt.hash('password123', 10);
  const ins = await dbRun(
    ctx.db,
    'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)',
    [username, `${username}@example.com`, hash, username]
  );
  return { id: ins.id, token: jwt.sign({ id: ins.id }, config.jwtSecret, { expiresIn: '1h' }) };
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('money core — opening balance', () => {
  let ctx, request, token, db;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    token = ctx.token;
    db = require('../db/database');
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  test('balance 1000 is stored once and produces exactly one type=opening row', async () => {
    const res = await request.post('/api/accounts').set(auth(token)).send({ name: 'Main', balance: 1000 });
    expect(res.status).toBe(201);
    const id = res.body.id;

    const acc = await request.get(`/api/accounts/${id}`).set(auth(token));
    expect(acc.body.balance).toBe(1000);

    const rows = await db.query('SELECT type, amount, category FROM transactions WHERE account_id = ?', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'opening', amount: 1000 });
  });

  test('negative opening balance (credit card) stores -250 once', async () => {
    const res = await request.post('/api/accounts').set(auth(token)).send({ name: 'Card', balance: -250 });
    expect(res.status).toBe(201);
    const acc = await request.get(`/api/accounts/${res.body.id}`).set(auth(token));
    expect(acc.body.balance).toBe(-250);
    const rows = await db.query('SELECT type, amount FROM transactions WHERE account_id = ?', [res.body.id]);
    expect(rows).toEqual([{ type: 'opening', amount: -250 }]);
  });

  test('no balance -> no transaction rows', async () => {
    const res = await request.post('/api/accounts').set(auth(token)).send({ name: 'Empty' });
    expect(res.status).toBe(201);
    const rows = await db.query('SELECT id FROM transactions WHERE account_id = ?', [res.body.id]);
    expect(rows).toHaveLength(0);
  });

  test('opening balance is excluded from income/expense analytics', async () => {
    const today = new Date().toISOString().split('T')[0];
    const overview = await request.get(`/api/analytics/overview?startDate=2000-01-01&endDate=${today}`).set(auth(token));
    expect(overview.status).toBe(200);
    expect(overview.body.income).toBe(0);
    expect(overview.body.expense).toBe(0);

    const stats = await request.get('/api/transactions/stats/summary?groupBy=category').set(auth(token));
    expect(stats.status).toBe(200);
    const incomeExpense = stats.body.filter((r) => r.type === 'income' || r.type === 'expense');
    expect(incomeExpense).toHaveLength(0);
  });

  test('net worth still reflects the opening balances', async () => {
    const res = await request.get('/api/networth').set(auth(token));
    if (res.status === 200) {
      const total = res.body.data ? res.body.data.netWorth ?? res.body.data.total : res.body.netWorth ?? res.body.total;
      if (typeof total === 'number') expect(total).toBe(750);
    }
    const row = await db.get('SELECT SUM(balance) AS s FROM accounts WHERE user_id = ?', [ctx.userId]);
    expect(row.s).toBe(750);
  });
});

describe('money core — sign by type on create and PUT', () => {
  let ctx, request, token, db, accId;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    token = ctx.token;
    db = require('../db/database');
    const a = await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [ctx.userId, 'Acc', 'UAH', 0, 'checking']
    );
    accId = a.id;
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  const balance = async () => (await db.get('SELECT balance FROM accounts WHERE id = ?', [accId])).balance;

  let txId;
  test('POST expense with positive amount is stored negative and lowers the balance', async () => {
    const res = await request.post('/api/transactions').set(auth(token))
      .send({ accountId: accId, date: '2026-10-01', amount: 50, type: 'expense' });
    expect(res.status).toBe(201);
    txId = res.body.id;
    const row = await db.get('SELECT amount, type FROM transactions WHERE id = ?', [txId]);
    expect(row).toEqual({ amount: -50, type: 'expense' });
    expect(await balance()).toBe(-50);
  });

  test('PUT type expense->income flips the sign and re-applies the delta (+100)', async () => {
    const res = await request.put(`/api/transactions/${txId}`).set(auth(token)).send({ type: 'income' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('income');
    expect(res.body.amount).toBe(50);
    expect(await balance()).toBe(50);
  });

  test('PUT amount only keeps the type sign', async () => {
    const res = await request.put(`/api/transactions/${txId}`).set(auth(token)).send({ amount: 80 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(80);
    expect(await balance()).toBe(80);
  });

  test('PUT amount + type expense stores negative and moves balance accordingly', async () => {
    const res = await request.put(`/api/transactions/${txId}`).set(auth(token)).send({ amount: 20, type: 'expense' });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(-20);
    expect(await balance()).toBe(-20);
  });

  test('DELETE reverses the current signed amount', async () => {
    const res = await request.delete(`/api/transactions/${txId}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(await balance()).toBe(0);
  });
});

describe('money core — transfer legs stay paired', () => {
  let ctx, request, token, db, accA, accB;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    token = ctx.token;
    db = require('../db/database');
    accA = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [ctx.userId, 'A', 'UAH', 1000, 'checking']
    )).id;
    accB = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [ctx.userId, 'B', 'UAH', 0, 'savings']
    )).id;
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  const balance = async (id) => (await db.get('SELECT balance FROM accounts WHERE id = ?', [id])).balance;
  const transfer = async (amount) => {
    const res = await request.post('/api/transactions/transfer').set(auth(token))
      .send({ fromAccountId: accA, toAccountId: accB, amount });
    expect(res.status).toBe(201);
    return res.body;
  };

  test('deleting one leg deletes both legs and restores both balances', async () => {
    const t = await transfer(100);
    expect(await balance(accA)).toBe(900);
    expect(await balance(accB)).toBe(100);

    const del = await request.delete(`/api/transactions/${t.from.id}`).set(auth(token));
    expect(del.status).toBe(200);

    const legs = await db.query('SELECT id FROM transactions WHERE transfer_id = ?', [t.transferId]);
    expect(legs).toHaveLength(0);
    expect(await balance(accA)).toBe(1000);
    expect(await balance(accB)).toBe(0);
  });

  test('editing the amount of one leg adjusts both legs and both balances', async () => {
    const t = await transfer(100);
    const res = await request.put(`/api/transactions/${t.to.id}`).set(auth(token)).send({ amount: 40 });
    expect(res.status).toBe(200);

    const legs = await db.query(
      'SELECT account_id, amount FROM transactions WHERE transfer_id = ? ORDER BY amount',
      [t.transferId]
    );
    expect(legs).toEqual([
      { account_id: accA, amount: -40 },
      { account_id: accB, amount: 40 },
    ]);
    expect(await balance(accA)).toBe(960);
    expect(await balance(accB)).toBe(40);

    // Описание/дата также синхронизируются на обе ноги.
    const upd = await request.put(`/api/transactions/${t.from.id}`).set(auth(token))
      .send({ description: 'Rent pot', date: '2026-09-30' });
    expect(upd.status).toBe(200);
    const rows = await db.query('SELECT description, date FROM transactions WHERE transfer_id = ?', [t.transferId]);
    expect(rows).toEqual([
      { description: 'Rent pot', date: '2026-09-30' },
      { description: 'Rent pot', date: '2026-09-30' },
    ]);
  });

  test('changing the type of a transfer leg is rejected (400) and nothing moves', async () => {
    const t = await transfer(10);
    const res = await request.put(`/api/transactions/${t.from.id}`).set(auth(token)).send({ type: 'expense' });
    expect(res.status).toBe(400);
    const legs = await db.query('SELECT type, amount FROM transactions WHERE transfer_id = ? ORDER BY amount', [t.transferId]);
    expect(legs).toEqual([{ type: 'transfer', amount: -10 }, { type: 'transfer', amount: 10 }]);
    expect(await balance(accA)).toBe(950);
    expect(await balance(accB)).toBe(50);
  });
});

describe('money core — shared accounts (contributor writes into the owner ledger)', () => {
  let ctx, request, tokenA, tokenB, userB, db, accId;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    tokenA = ctx.token;
    db = require('../db/database');
    userB = await makeUser(ctx, 'contributor');
    tokenB = userB.token;
    accId = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [ctx.userId, 'Family', 'UAH', 500, 'checking']
    )).id;
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  test('contributor without can_add_transactions gets 403 / stranger gets 404', async () => {
    const stranger = await request.post('/api/transactions').set(auth(tokenB))
      .send({ accountId: accId, date: '2026-10-01', amount: -10, type: 'expense' });
    expect(stranger.status).toBe(404);

    await db.run(
      'INSERT INTO account_permissions (account_id,user_id,can_view,can_edit,can_delete,can_add_transactions,granted_by) VALUES (?,?,1,0,0,0,?)',
      [accId, userB.id, ctx.userId]
    );
    const viewer = await request.post('/api/transactions').set(auth(tokenB))
      .send({ accountId: accId, date: '2026-10-01', amount: -10, type: 'expense' });
    expect(viewer.status).toBe(403);
    expect((await db.get('SELECT balance FROM accounts WHERE id = ?', [accId])).balance).toBe(500);
  });

  test('contributor with can_add_transactions writes into the owner ledger; both can read it', async () => {
    await db.run('UPDATE account_permissions SET can_add_transactions = 1 WHERE account_id = ? AND user_id = ?', [accId, userB.id]);
    const res = await request.post('/api/transactions').set(auth(tokenB))
      .send({ accountId: accId, date: '2026-10-02', amount: 30, type: 'expense', description: 'Groceries' });
    expect(res.status).toBe(201);

    const row = await db.get('SELECT user_id, amount, type FROM transactions WHERE id = ?', [res.body.id]);
    // Документированная семантика: строка принадлежит леджеру ВЛАДЕЛЬЦА счёта.
    expect(row).toEqual({ user_id: ctx.userId, amount: -30, type: 'expense' });
    expect((await db.get('SELECT balance FROM accounts WHERE id = ?', [accId])).balance).toBe(470);

    // Владелец видит её в своём списке.
    const ownerList = await request.get(`/api/transactions?accountId=${accId}`).set(auth(tokenA));
    expect(ownerList.body.map((t) => t.id)).toContain(res.body.id);
    // Контрибьютор видит её через /api/accounts/:id/transactions.
    const sharedList = await request.get(`/api/accounts/${accId}/transactions`).set(auth(tokenB));
    expect(sharedList.status).toBe(200);
    expect(sharedList.body.map((t) => t.id)).toContain(res.body.id);
  });

  test('account transactions for a missing account -> 404, never 500', async () => {
    const res = await request.get('/api/accounts/987654/transactions').set(auth(tokenA));
    expect(res.status).toBe(404);
    const post = await request.post('/api/transactions').set(auth(tokenA))
      .send({ accountId: 987654, date: '2026-10-01', amount: -1, type: 'expense' });
    expect(post.status).toBe(404);
  });
});
