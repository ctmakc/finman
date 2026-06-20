// test/backup.test.js — full data portability (wave-2 "export-backup").
//
// Covers:
//   1) backupService.exportAll captures a user's data across many tables;
//   2) importAll into a FRESH (different) user reproduces the data, with
//      foreign keys correctly remapped (transactions->accounts, child rows);
//   3) the HTTP routes: GET /api/export/backup (download), POST
//      /api/export/restore, GET /api/export/csv;
//   4) a malformed backup is rejected with 400 / AppError(400).
//
// Everything runs offline against the per-call temp sqlite DB from the harness.

const { makeApp } = require('./helpers/app');

function getDb() {
  return require('../db/database');
}
function getService() {
  return require('../services/backupService');
}

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

// Seed a rich-ish dataset for `userId` and return the ids we created so tests
// can assert on remapping behaviour.
async function seedUserData(db, userId) {
  // Accounts (two, different currencies).
  const acc1 = await db.run(
    `INSERT INTO accounts (user_id, name, currency, balance, account_type, is_active)
     VALUES (?, 'Main', 'UAH', 1000, 'checking', 1)`,
    [userId]
  );
  const acc2 = await db.run(
    `INSERT INTO accounts (user_id, name, currency, balance, account_type, is_active)
     VALUES (?, 'Savings USD', 'USD', 500, 'savings', 1)`,
    [userId]
  );

  // Categories + tags.
  await db.run(
    `INSERT INTO categories (user_id, name, type, color) VALUES (?, 'Groceries', 'expense', '#abc')`,
    [userId]
  );
  const tag1 = await db.run(
    `INSERT INTO tags (user_id, name, color) VALUES (?, 'food', '#111')`,
    [userId]
  );

  // Transactions (reference accounts).
  const tx1 = await db.run(
    `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
     VALUES (?, ?, '2024-03-01', 'Lunch', 'Groceries', 12.5, 'expense')`,
    [acc1.id, userId]
  );
  const tx2 = await db.run(
    `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
     VALUES (?, ?, '2024-03-02', 'Salary', 'Income', 2000, 'income')`,
    [acc2.id, userId]
  );

  // transaction_tags child (references tx + tag).
  await db.run(
    `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`,
    [tx1.id, tag1.id]
  );

  // Savings goal + a contribution that points back to a transaction.
  const goal = await db.run(
    `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, currency)
     VALUES (?, 'Vacation', 5000, 200, 'UAH')`,
    [userId]
  );
  await db.run(
    `INSERT INTO goal_contributions (goal_id, amount, note, transaction_id)
     VALUES (?, 200, 'first', ?)`,
    [goal.id, tx1.id]
  );

  // A debt + a payment.
  const debt = await db.run(
    `INSERT INTO debts (user_id, name, type, amount, paid_amount, currency, start_date)
     VALUES (?, 'Loan', 'loan', 1000, 100, 'UAH', '2024-01-01')`,
    [userId]
  );
  await db.run(
    `INSERT INTO debt_payments (debt_id, amount, payment_type, payment_date)
     VALUES (?, 100, 'principal', '2024-02-01')`,
    [debt.id]
  );

  // Investment portfolio -> investment -> investment_transaction (deep chain).
  const pf = await db.run(
    `INSERT INTO investment_portfolios (user_id, name, currency) VALUES (?, 'Brokerage', 'USD')`,
    [userId]
  );
  const inv = await db.run(
    `INSERT INTO investments (portfolio_id, symbol, name, type, quantity, buy_price, currency, buy_date)
     VALUES (?, 'AAPL', 'Apple', 'stock', 10, 150, 'USD', '2024-01-15')`,
    [pf.id]
  );
  await db.run(
    `INSERT INTO investment_transactions (investment_id, type, quantity, price, date)
     VALUES (?, 'buy', 10, 150, '2024-01-15')`,
    [inv.id]
  );

  // Split group -> members -> expense -> shares (FKs between members & expense).
  const grp = await db.run(
    `INSERT INTO split_groups (user_id, name, currency) VALUES (?, 'Trip', 'UAH')`,
    [userId]
  );
  const m1 = await db.run(
    `INSERT INTO split_members (group_id, name) VALUES (?, 'Alice')`,
    [grp.id]
  );
  const m2 = await db.run(
    `INSERT INTO split_members (group_id, name) VALUES (?, 'Bob')`,
    [grp.id]
  );
  const exp = await db.run(
    `INSERT INTO split_expenses (group_id, paid_by, description, amount, date)
     VALUES (?, ?, 'Hotel', 300, '2024-03-10')`,
    [grp.id, m1.id]
  );
  await db.run(
    `INSERT INTO split_shares (expense_id, member_id, amount) VALUES (?, ?, 150)`,
    [exp.id, m1.id]
  );
  await db.run(
    `INSERT INTO split_shares (expense_id, member_id, amount) VALUES (?, ?, 150)`,
    [exp.id, m2.id]
  );

  return {
    acc1: acc1.id, acc2: acc2.id, tag1: tag1.id,
    tx1: tx1.id, tx2: tx2.id, goal: goal.id, debt: debt.id,
    pf: pf.id, inv: inv.id, grp: grp.id, m1: m1.id, m2: m2.id, exp: exp.id,
  };
}

// Create a second user in the same temp DB and sign a JWT for them.
async function makeSecondUser(ctx) {
  const db = getDb();
  const bcrypt = require('bcrypt');
  const jwt = require('jsonwebtoken');
  const config = require('../config/config');
  const hash = await bcrypt.hash('password123', 10);
  // Уникальные username/email на каждый вызов: describe делит одну БД (один makeApp
  // в beforeAll), а несколько тестов создают «второго» юзера — хардкод email ловил
  // UNIQUE constraint на втором вызове.
  const n = (makeSecondUser._n = (makeSecondUser._n || 0) + 1);
  const ins = await db.run(
    `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
    [`second${n}`, `second${n}@example.com`, hash, 'Second User']
  );
  const token = jwt.sign({ id: ins.id }, config.jwtSecret, {
    expiresIn: config.jwtExpiration || '24h',
  });
  return { userId: ins.id, token };
}

describe('backupService: export/import round-trip', () => {
  let ctx;
  let db;
  let svc;
  let seeded;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    svc = getService();
    seeded = await seedUserData(db, ctx.userId);
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('exportAll returns an envelope with all seeded tables populated', async () => {
    const backup = await svc.exportAll(ctx.userId);
    expect(backup.app).toBe('finman');
    expect(backup.version).toBeGreaterThanOrEqual(1);
    expect(backup.tables).toBeDefined();

    expect(backup.tables.accounts.length).toBe(2);
    expect(backup.tables.transactions.length).toBe(2);
    expect(backup.tables.transaction_tags.length).toBe(1);
    expect(backup.tables.goal_contributions.length).toBe(1);
    expect(backup.tables.debt_payments.length).toBe(1);
    expect(backup.tables.investments.length).toBe(1);
    expect(backup.tables.investment_transactions.length).toBe(1);
    expect(backup.tables.split_members.length).toBe(2);
    expect(backup.tables.split_shares.length).toBe(2);

    // Original ids are stamped for remapping.
    expect(backup.tables.accounts[0].__id).toBeDefined();
    // Never leak password.
    expect(JSON.stringify(backup)).not.toContain('password');
  });

  test('export does NOT include another user\'s rows', async () => {
    const other = await makeSecondUser(ctx);
    await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active)
       VALUES (?, 'Other-Only', 'EUR', 9999, 1)`,
      [other.userId]
    );
    const backup = await svc.exportAll(ctx.userId);
    const names = backup.tables.accounts.map((a) => a.name);
    expect(names).not.toContain('Other-Only');
    // Still exactly the original 2 accounts for ctx user.
    expect(backup.tables.accounts.length).toBe(2);
  });

  test('importAll into a FRESH user reproduces the data with remapped FKs', async () => {
    const backup = await svc.exportAll(ctx.userId);
    const target = await makeSecondUser(ctx);

    const result = await svc.importAll(target.userId, backup);
    expect(result.totalImported).toBeGreaterThan(0);

    // Accounts copied to the new user.
    const accounts = await db.query(
      'SELECT * FROM accounts WHERE user_id = ?',
      [target.userId]
    );
    expect(accounts.length).toBe(2);

    // Transactions copied AND their account_id points at the NEW accounts
    // (not the source user's account ids).
    const txs = await db.query(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY date',
      [target.userId]
    );
    expect(txs.length).toBe(2);
    const newAccountIds = accounts.map((a) => a.id);
    for (const t of txs) {
      expect(newAccountIds).toContain(t.account_id);
      // Must NOT still reference the source account ids.
      expect(t.account_id).not.toBe(seeded.acc1);
      expect(t.account_id).not.toBe(seeded.acc2);
    }

    // transaction_tags remapped: its transaction_id/tag_id reference the new ids.
    const newTags = await db.query('SELECT * FROM tags WHERE user_id = ?', [target.userId]);
    const newTagIds = newTags.map((t) => t.id);
    const newTxIds = txs.map((t) => t.id);
    const tt = await db.query(
      `SELECT tt.* FROM transaction_tags tt
       JOIN transactions t ON tt.transaction_id = t.id
       WHERE t.user_id = ?`,
      [target.userId]
    );
    expect(tt.length).toBe(1);
    expect(newTxIds).toContain(tt[0].transaction_id);
    expect(newTagIds).toContain(tt[0].tag_id);

    // Deep chain: portfolio -> investment -> investment_transaction.
    const pfs = await db.query(
      'SELECT * FROM investment_portfolios WHERE user_id = ?',
      [target.userId]
    );
    expect(pfs.length).toBe(1);
    const invs = await db.query(
      'SELECT * FROM investments WHERE portfolio_id = ?',
      [pfs[0].id]
    );
    expect(invs.length).toBe(1);
    const invTx = await db.query(
      'SELECT * FROM investment_transactions WHERE investment_id = ?',
      [invs[0].id]
    );
    expect(invTx.length).toBe(1);

    // Split chain: shares reference the NEW members/expense.
    const grps = await db.query('SELECT * FROM split_groups WHERE user_id = ?', [target.userId]);
    expect(grps.length).toBe(1);
    const members = await db.query('SELECT * FROM split_members WHERE group_id = ?', [grps[0].id]);
    expect(members.length).toBe(2);
    const memberIds = members.map((m) => m.id);
    const exps = await db.query('SELECT * FROM split_expenses WHERE group_id = ?', [grps[0].id]);
    expect(exps.length).toBe(1);
    expect(memberIds).toContain(exps[0].paid_by);
    const shares = await db.query('SELECT * FROM split_shares WHERE expense_id = ?', [exps[0].id]);
    expect(shares.length).toBe(2);
    for (const s of shares) {
      expect(memberIds).toContain(s.member_id);
    }
  });

  test('importAll rejects a malformed backup with AppError(400)', async () => {
    expect.assertions(4);
    try {
      await svc.importAll(ctx.userId, 'not json at all {');
    } catch (e) {
      expect(e.name).toBe('AppError');
      expect(e.status).toBe(400);
    }
    try {
      await svc.importAll(ctx.userId, { version: 1 }); // no tables container
    } catch (e) {
      expect(e.name).toBe('AppError');
      expect(e.status).toBe(400);
    }
  });

  test('importAll rejects an unknown table name with 400', async () => {
    await expect(
      svc.importAll(ctx.userId, { app: 'finman', version: 1, tables: { not_a_table: [] } })
    ).rejects.toMatchObject({ name: 'AppError', status: 400 });
  });

  test('exportCsv produces a non-empty UTF-8 CSV containing seeded values', async () => {
    const csv = await svc.exportCsv(ctx.userId);
    expect(typeof csv).toBe('string');
    expect(csv.length).toBeGreaterThan(0);
    // Section header + a known value.
    expect(csv).toContain('# accounts');
    expect(csv).toContain('Main');
  });
});

describe('export routes (HTTP)', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    await seedUserData(db, ctx.userId);
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /api/export/backup downloads a JSON backup', async () => {
    const res = await ctx.request.get('/api/export/backup').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const body = JSON.parse(res.text);
    expect(body.app).toBe('finman');
    expect(body.tables.accounts.length).toBe(2);
  });

  test('GET /api/export/csv downloads a CSV', async () => {
    const res = await ctx.request.get('/api/export/csv').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toContain('# accounts');
  });

  test('POST /api/export/restore restores a backup into the same account', async () => {
    // Export current user's data, restore into a brand-new user via their token.
    const exportRes = await ctx.request.get('/api/export/backup').set(AUTH(ctx.token));
    const backup = JSON.parse(exportRes.text);

    const second = await makeSecondUser(ctx);
    const res = await ctx.request
      .post('/api/export/restore')
      .set(AUTH(second.token))
      .send(backup);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalImported).toBeGreaterThan(0);

    const accounts = await db.query('SELECT * FROM accounts WHERE user_id = ?', [second.userId]);
    expect(accounts.length).toBe(2);
  });

  test('POST /api/export/restore rejects malformed body with 400', async () => {
    const res = await ctx.request
      .post('/api/export/restore')
      .set(AUTH(ctx.token))
      .send({ garbage: true });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBeDefined();
  });

  test('export endpoints require auth', async () => {
    const res = await ctx.request.get('/api/export/backup');
    expect(res.status).toBe(401);
  });
});
