// test/ledger.test.js — "ledger-export" stream.
//
// Covers the Beancount (plain-text double-entry) anti-lock-in export:
//   1) service toBeancount() emits an `open` directive per account + per
//      category leg, and one balanced posting pair per transaction;
//   2) every transaction in the output balances to zero (Beancount's hard
//      requirement) — verified by summing the signed posting amounts;
//   3) the mounted route GET /api/export/beancount streams a non-empty
//      text/plain attachment containing those directives;
//   4) auth is enforced (401 without a token);
//   5) name/currency/date sanitisation produces valid Beancount tokens.
//
// The export is read-only and offline; we seed via raw sqlite and assert on
// the produced text. No network, no schema changes.

const { makeApp } = require('./helpers/app');
// require ПОСЛЕ makeApp() — иначе сервис биндится к БД, существовавшей ДО
// jest.resetModules() в makeApp, и читает пустую/чужую базу.
let ledgerExport;

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

// Parse the postings of every transaction directive and assert each group
// sums (signed) to zero. Returns the number of transactions found.
function assertBalanced(text) {
  const lines = text.split('\n');
  let txCount = 0;
  let current = null; // array of signed numbers for the open transaction
  const groups = [];

  const flush = () => {
    if (current) groups.push(current);
    current = null;
  };

  for (const line of lines) {
    // Transaction header: `YYYY-MM-DD * "..."`
    if (/^\d{4}-\d{2}-\d{2}\s+\*/.test(line)) {
      flush();
      current = [];
      txCount += 1;
      continue;
    }
    // Posting line: `  Account:Name  -12.50 UAH`
    const m = /^\s+[A-Z][A-Za-z0-9:-]*\s+(-?\d+\.\d{2})\s+[A-Z][A-Z0-9'._-]*\s*$/.exec(line);
    if (m && current) {
      current.push(parseFloat(m[1]));
    } else if (line.trim() === '' && current) {
      // blank line ends the transaction block
      flush();
    }
  }
  flush();

  for (const g of groups) {
    expect(g.length).toBeGreaterThanOrEqual(2);
    const sum = Math.round(g.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(sum).toBe(0);
  }
  return txCount;
}

// ctx.db — это СЫРОЙ sqlite3-хендл (callback-стиль). Оборачиваем в промис,
// иначе `await rawDb.run(...)` не дожидается вставки (раса с чтением).
function dbRun(rawDb, sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

describe('ledger-export: Beancount service', () => {
  let ctx;
  let db;
  let accountId;

  beforeAll(async () => {
    ctx = await makeApp();
    ledgerExport = require('../services/ledgerExport');
    db = ctx.db;

    const acc = await dbRun(db,
      `INSERT INTO accounts (user_id, name, currency, balance, account_type, is_active, created_at)
       VALUES (?, 'Main Wallet', 'UAH', 1500, 'checking', 1, '2026-01-01')`,
      [ctx.userId]
    );
    accountId = acc.id;

    const txns = [
      // date, description, category, type, amount
      ['2026-03-02', 'Salary March', 'salary', 'income', 5000],
      ['2026-03-05', 'Groceries', 'food', 'expense', 1200.5],
      ['2026-03-10', 'Metro pass', 'transport', 'expense', 300],
      // tricky names that must be sanitised into valid Beancount tokens
      ['2026-03-12', 'Кафе "У дома"', 'еда & кофе', 'expense', 87.33],
    ];
    for (const [date, description, category, type, amount] of txns) {
      await dbRun(db,
        `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [accountId, ctx.userId, date, description, category, amount, type]
      );
    }
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('emits open directives for accounts and category legs', async () => {
    const text = await ledgerExport.toBeancount(ctx.userId);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);

    // Account open directive.
    expect(text).toMatch(/\bopen Assets:Main-Wallet UAH\b/);
    // Category legs opened (expense + income roots).
    expect(text).toMatch(/\bopen Expenses:Food\b/);
    expect(text).toMatch(/\bopen Expenses:Transport\b/);
    expect(text).toMatch(/\bopen Income:Salary\b/);

    // There must be at least as many `open` lines as accounts + distinct legs.
    const openCount = (text.match(/^\S.*\bopen /gm) || []).length;
    expect(openCount).toBeGreaterThanOrEqual(4);
  });

  test('every transaction posting pair balances to zero', async () => {
    const text = await ledgerExport.toBeancount(ctx.userId);
    const txCount = assertBalanced(text);
    expect(txCount).toBe(4);
  });

  test('operating_currency option present and parseable structure', async () => {
    const text = await ledgerExport.toBeancount(ctx.userId);
    expect(text).toMatch(/option "operating_currency" "UAH"/);
    // No stray unquoted Cyrillic in account tokens (sanitised away).
    const openLines = text.split('\n').filter((l) => /\bopen /.test(l));
    for (const l of openLines) {
      // Account token after `open ` must be valid Beancount (ASCII colon path).
      const m = /\bopen\s+([^\s]+)/.exec(l);
      expect(m).not.toBeNull();
      expect(m[1]).toMatch(/^[A-Z][A-Za-z0-9:-]*$/);
    }
  });

  test('empty user still produces a parseable, non-empty document', async () => {
    // Seed a second user with no accounts/txns.
    const u = await dbRun(db,
      `INSERT INTO users (username, email, password, full_name)
       VALUES ('empty', 'empty@example.com', 'x', 'Empty')`
    );
    const text = await ledgerExport.toBeancount(u.id);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/Beancount export from finman/);
    // No transactions -> assertBalanced finds zero groups, no failure.
    expect(assertBalanced(text)).toBe(0);
  });

  test('internal sanitisers produce valid Beancount tokens', () => {
    const { accountComponent, normalizeCurrency, normalizeDate, bcString } =
      ledgerExport._internal;
    expect(accountComponent('еда & кофе', 'X')).toMatch(/^[A-Z0-9]/);
    expect(accountComponent('', 'Fallback')).toBe('Fallback');
    expect(normalizeCurrency('uah')).toBe('UAH');
    expect(normalizeCurrency('!!!')).toBe('UAH');
    expect(normalizeDate('2026-03-02T10:00:00Z')).toBe('2026-03-02');
    expect(bcString('a "b" \\c')).toBe('a \\"b\\" \\\\c');
  });
});

describe('ledger-export: GET /api/export/beancount route', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await makeApp();
    ledgerExport = require('../services/ledgerExport');
    const db = ctx.db;
    const acc = await dbRun(db,
      `INSERT INTO accounts (user_id, name, currency, balance, is_active, created_at)
       VALUES (?, 'Savings', 'EUR', 200, 1, '2026-02-01')`,
      [ctx.userId]
    );
    await dbRun(db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-04-01', 'Rent', 'housing', 800, 'expense')`,
      [acc.id, ctx.userId]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('requires authentication', async () => {
    const res = await ctx.request.get('/api/export/beancount');
    expect(res.status).toBe(401);
  });

  test('returns a non-empty text/plain Beancount attachment', async () => {
    const res = await ctx.request
      .get('/api/export/beancount')
      .set(AUTH(ctx.token));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-disposition']).toMatch(/\.beancount/);

    const body = res.text;
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/\bopen Assets:Savings EUR\b/);
    expect(body).toMatch(/\bopen Expenses:Housing\b/);
    // The single expense transaction must balance.
    expect(assertBalanced(body)).toBe(1);
  });
});
