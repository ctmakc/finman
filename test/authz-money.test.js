// test/authz-money.test.js — дыры авторизации, двигающие чужие деньги
// (backend-audit/repro.js пункты 3 и 6).
//
//   1) POST /api/receipts/:id/create-transaction с чужим account_id -> 403,
//      баланс жертвы не меняется; со своим счётом — expense < 0, баланс падает
//      на сумму чека, чек связан с транзакцией (всё в одной транзакции БД).
//   2) POST /api/export/transactions/csv?accountId=<чужой> -> 404 и ни одной
//      строки; в свой счёт — знак по типу (Расход < 0, Доход > 0) и баланс
//      двигается на сумму импорта.
//   3) POST /api/export/full/json импортирует счета импортирующего пользователя.
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

describe('authz — receipts create-transaction', () => {
  let ctx, request, tokenA, tokenB, userB, db, accA, accB;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    tokenA = ctx.token;
    db = require('../db/database');
    userB = await makeUser(ctx, 'attacker');
    tokenB = userB.token;
    accA = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [ctx.userId, 'Victim', 'UAH', 2000, 'checking']
    )).id;
    accB = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [userB.id, 'Mine', 'UAH', 1000, 'checking']
    )).id;
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  const balance = async (id) => (await db.get('SELECT balance FROM accounts WHERE id = ?', [id])).balance;

  test("B's receipt into A's account -> 403, A's balance untouched, receipt not linked", async () => {
    const r = await request.post('/api/receipts/manual').set(auth(tokenB)).send({ merchant: 'Evil', total_amount: 500 });
    expect(r.status).toBe(201);

    const res = await request.post(`/api/receipts/${r.body.id}/create-transaction`).set(auth(tokenB)).send({ account_id: accA });
    expect(res.status).toBe(403);
    expect(await balance(accA)).toBe(2000);
    const rows = await db.query('SELECT id FROM transactions WHERE account_id = ?', [accA]);
    expect(rows).toHaveLength(0);
    const rcpt = await db.get('SELECT transaction_id FROM receipts WHERE id = ?', [r.body.id]);
    expect(rcpt.transaction_id).toBeNull();
  });

  test('nonexistent account -> 404', async () => {
    const r = await request.post('/api/receipts/manual').set(auth(tokenB)).send({ merchant: 'X', total_amount: 5 });
    const res = await request.post(`/api/receipts/${r.body.id}/create-transaction`).set(auth(tokenB)).send({ account_id: 999999 });
    expect(res.status).toBe(404);
  });

  test('own account -> expense stored negative, balance -total, receipt linked', async () => {
    const r = await request.post('/api/receipts/manual').set(auth(tokenB))
      .send({ merchant: 'Silpo', total_amount: 123.45, receipt_date: '2026-10-03', category: 'food' });
    const res = await request.post(`/api/receipts/${r.body.id}/create-transaction`).set(auth(tokenB)).send({ account_id: accB });
    expect(res.status).toBe(200);
    const txId = res.body.transaction_id;
    expect(txId).toBeTruthy();

    const tx = await db.get('SELECT user_id, account_id, amount, type, date FROM transactions WHERE id = ?', [txId]);
    expect(tx).toEqual({ user_id: userB.id, account_id: accB, amount: -123.45, type: 'expense', date: '2026-10-03' });
    expect(await balance(accB)).toBe(876.55);
    const rcpt = await db.get('SELECT transaction_id, is_processed FROM receipts WHERE id = ?', [r.body.id]);
    expect(rcpt.transaction_id).toBe(txId);
    expect(rcpt.is_processed).toBe(1);
  });

  test("A's token cannot use B's receipt id", async () => {
    const r = await request.post('/api/receipts/manual').set(auth(tokenB)).send({ merchant: 'X', total_amount: 5 });
    const res = await request.post(`/api/receipts/${r.body.id}/create-transaction`).set(auth(tokenA)).send({ account_id: accA });
    expect(res.status).toBe(404);
    expect(await balance(accA)).toBe(2000);
  });
});

describe('authz — export.js import paths', () => {
  let ctx, request, tokenA, tokenB, userB, db, accA, accB;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    tokenA = ctx.token;
    db = require('../db/database');
    userB = await makeUser(ctx, 'importer');
    tokenB = userB.token;
    accA = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [ctx.userId, 'Victim', 'UAH', 2000, 'checking']
    )).id;
    accB = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [userB.id, 'Mine', 'UAH', 100, 'checking']
    )).id;
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  const CSV = 'Дата,Описание,Категория,Сумма,Тип\n2026-10-01,"Coffee",food,10,Расход\n2026-10-02,"Salary",salary,-300,Доход\n';
  const balance = async (id) => (await db.get('SELECT balance FROM accounts WHERE id = ?', [id])).balance;

  test("CSV import into A's account as B -> 404, no rows, A's balance untouched", async () => {
    const res = await request.post(`/api/export/transactions/csv?accountId=${accA}`).set(auth(tokenB))
      .set('Content-Type', 'text/csv').send(CSV);
    expect(res.status).toBe(404);
    const rows = await db.query('SELECT id FROM transactions WHERE account_id = ?', [accA]);
    expect(rows).toHaveLength(0);
    expect(await balance(accA)).toBe(2000);
  });

  test('CSV import into own account: sign by type, balance moves by the net', async () => {
    const res = await request.post(`/api/export/transactions/csv?accountId=${accB}`).set(auth(tokenB))
      .set('Content-Type', 'text/csv').send(CSV);
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);

    const rows = await db.query(
      'SELECT user_id, amount, type, category FROM transactions WHERE account_id = ? ORDER BY date',
      [accB]
    );
    expect(rows).toEqual([
      { user_id: userB.id, amount: -10, type: 'expense', category: 'food' },
      { user_id: userB.id, amount: 300, type: 'income', category: 'salary' },
    ]);
    expect(await balance(accB)).toBe(390);
  });

  test('missing accountId -> 400', async () => {
    const res = await request.post('/api/export/transactions/csv').set(auth(tokenB))
      .set('Content-Type', 'text/csv').send(CSV);
    expect(res.status).toBe(400);
  });

  test('full/json import creates accounts for the importing user only', async () => {
    const res = await request.post('/api/export/full/json').set(auth(tokenB))
      .send({ accounts: [{ name: 'Imported', bank_name: 'X', currency: 'UAH', balance: 42, account_type: 'checking' }] });
    expect(res.status).toBe(200);
    expect(res.body.results.accounts).toBe(1);
    const row = await db.get('SELECT user_id, balance FROM accounts WHERE name = ?', ['Imported']);
    expect(row).toEqual({ user_id: userB.id, balance: 42 });
  });
});
