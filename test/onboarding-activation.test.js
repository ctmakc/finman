// test/onboarding-activation.test.js — first-run activation (22.11):
// demo data load/remove, /state, /insight after an import, email verification,
// email-first sign-up (username optional) and login by email.
const crypto = require('crypto');
const { makeApp } = require('./helpers/app');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('first run: state, demo, insight', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.close(); });

  test('fresh user: firstRun=true, no data', async () => {
    const r = await ctx.request.get('/api/onboarding/state').set(AUTH(ctx.token));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ accounts: 0, transactions: 0, demo: false, firstRun: true, emailVerified: false, google: false });
  });

  test('POST /demo loads two tagged accounts with ~90 days of rows, idempotent', async () => {
    const r = await ctx.request.post('/api/onboarding/demo').set(AUTH(ctx.token)).send({ currency: 'CAD' });
    expect(r.status).toBe(201);
    expect(r.body.data.created).toBe(true);
    expect(r.body.data.accountIds).toHaveLength(2);
    expect(r.body.data.transactions).toBeGreaterThan(80);

    const again = await ctx.request.post('/api/onboarding/demo').set(AUTH(ctx.token)).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.created).toBe(false);
    expect(again.body.data.transactions).toBe(r.body.data.transactions);

    const st = await ctx.request.get('/api/onboarding/state').set(AUTH(ctx.token));
    expect(st.body.data).toMatchObject({ demo: true, demoAccounts: 2, firstRun: false, ownTransactions: 0 });

    const ins = await ctx.request.get('/api/onboarding/insight?demo=1').set(AUTH(ctx.token));
    expect(ins.status).toBe(200);
    const d = ins.body.data;
    expect(d.count).toBe(r.body.data.transactions);
    expect(d.currency).toBe('CAD');
    expect(d.income).toBeGreaterThan(0);
    expect(d.expense).toBeGreaterThan(0);
    expect(d.topCategories[0].name).toBe('Housing');
    const names = d.recurring.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['NETFLIX.COM', 'SPOTIFY P0B2', 'RENT — MAPLE PROPERTY MGMT']));
    for (const n of ['IKEA OTTAWA', 'UBER EATS', 'AMAZON.CA']) expect(names).not.toContain(n);
    // Own-data insight ignores demo rows.
    const own = await ctx.request.get('/api/onboarding/insight').set(AUTH(ctx.token));
    expect(own.body.data.count).toBe(0);
  });

  test('balances equal opening + sum of rows', async () => {
    const { query } = require('../db/database');
    const accs = await query('SELECT id, balance, account_type FROM accounts WHERE user_id = ? AND is_demo = 1', [ctx.userId]);
    for (const a of accs) {
      const [{ s }] = await query('SELECT ROUND(SUM(amount), 2) AS s FROM transactions WHERE account_id = ?', [a.id]);
      const opening = a.account_type === 'checking' ? 3200 : 0;
      expect(Math.abs(Math.round((a.balance - opening - s) * 100))).toBe(0);
    }
  });

  test('DELETE /demo removes every demo account and row; own data stays', async () => {
    const { run, get } = require('../db/database');
    const own = await run(`INSERT INTO accounts (user_id, name, currency, balance) VALUES (?, 'Mine', 'CAD', 10)`, [ctx.userId]);
    await run(`INSERT INTO transactions (account_id, user_id, date, description, amount, type) VALUES (?, ?, '2026-11-01', 'COFFEE', -4, 'expense')`, [own.id, ctx.userId]);

    const r = await ctx.request.delete('/api/onboarding/demo').set(AUTH(ctx.token));
    expect(r.status).toBe(200);
    expect(r.body.data.removed).toBe(true);
    expect(r.body.data.accounts).toBe(2);
    const left = await get('SELECT COUNT(*) AS c FROM accounts WHERE user_id = ? AND is_demo = 1', [ctx.userId]);
    expect(left.c).toBe(0);
    const orphan = await get('SELECT COUNT(*) AS c FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.user_id = ? AND a.id IS NULL', [ctx.userId]);
    expect(orphan.c).toBe(0);
    const st = await ctx.request.get('/api/onboarding/state').set(AUTH(ctx.token));
    expect(st.body.data).toMatchObject({ demo: false, transactions: 1, ownTransactions: 1, firstRun: false });

    const again = await ctx.request.delete('/api/onboarding/demo').set(AUTH(ctx.token));
    expect(again.body.data.removed).toBe(false);
  });

  test('insight on an imported account: period, totals, top categories, recurring', async () => {
    const { run } = require('../db/database');
    const acc = await run(`INSERT INTO accounts (user_id, name, currency, balance) VALUES (?, 'RBC chequing', 'CAD', 0)`, [ctx.userId]);
    const rows = [
      ['2026-08-01', 'PAYROLL', 'Salary', 3000, 'income'],
      ['2026-09-01', 'PAYROLL', 'Salary', 3000, 'income'],
      ['2026-10-01', 'PAYROLL', 'Salary', 3000, 'income'],
      ['2026-08-03', 'RENT', 'Housing', -1500, 'expense'],
      ['2026-09-03', 'RENT', 'Housing', -1500, 'expense'],
      ['2026-10-03', 'RENT', 'Housing', -1500, 'expense'],
      ['2026-08-10', 'NETFLIX.COM', 'Subscriptions', -20.99, 'expense'],
      ['2026-09-10', 'NETFLIX.COM', 'Subscriptions', -20.99, 'expense'],
      ['2026-10-10', 'NETFLIX.COM', 'Subscriptions', -20.99, 'expense'],
      ['2026-09-15', 'MYSTERY SHOP', null, -200, 'expense'],
      ['2026-09-20', 'TO SAVINGS', 'Transfer', -500, 'expense'],
    ];
    for (const [date, d, c, a, t] of rows) {
      await run(`INSERT INTO transactions (account_id, user_id, date, description, category, amount, type) VALUES (?, ?, ?, ?, ?, ?, ?)`, [acc.id, ctx.userId, date, d, c, a, t]);
    }
    const r = await ctx.request.get(`/api/onboarding/insight?accountId=${acc.id}`).set(AUTH(ctx.token));
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({ count: 11, from: '2026-08-01', to: '2026-10-10', currency: 'CAD', income: 9000 });
    expect(d.expense).toBeCloseTo(4500 + 62.97 + 200, 2); // transfer excluded
    expect(d.topCategories[0]).toMatchObject({ name: 'Housing', total: 4500 });
    expect(d.uncategorizedShare).toBeGreaterThan(0);
    expect(d.recurring.map((x) => x.name)).toEqual(expect.arrayContaining(['RENT', 'NETFLIX.COM']));
    // biggest = one-off purchases; recurring rent/Netflix are not repeated there
    expect(d.biggest.map((x) => x.description)).toEqual(['MYSTERY SHOP']);

    const bad = await ctx.request.get('/api/onboarding/insight?accountId=abc').set(AUTH(ctx.token));
    expect(bad.status).toBe(400);
  });

  test('another user cannot read this insight', async () => {
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const { run } = require('../db/database');
    const u = await run(`INSERT INTO users (username, email, password) VALUES ('intruder', 'intruder@example.com', 'x')`);
    const t = jwt.sign({ id: u.id }, config.jwtSecret, { expiresIn: '1h' });
    const r = await ctx.request.get('/api/onboarding/insight').set(AUTH(t));
    expect(r.body.data.count).toBe(0);
  });

  test('401 without a token', async () => {
    const r = await ctx.request.get('/api/onboarding/state');
    expect(r.status).toBe(401);
  });
});

describe('email-first sign-up and verification', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.close(); });

  test('register with email + password only; username derived; login by email works', async () => {
    const r = await ctx.request.post('/api/auth/register').send({ email: 'Jane.Doe+smoke@finman-smoke.test', password: 'Secret#12345' });
    expect([200, 201]).toContain(r.status);
    const { get } = require('../db/database');
    const u = await get('SELECT username, email_verified_at FROM users WHERE email = ?', ['Jane.Doe+smoke@finman-smoke.test']);
    expect(u.username).toMatch(/^[A-Za-z0-9_]{3,}$/);
    expect(u.email_verified_at).toBeNull();

    const login = await ctx.request.post('/api/auth/login').send({ username: 'Jane.Doe+smoke@finman-smoke.test', password: 'Secret#12345' });
    expect(login.status).toBe(200);
    expect(login.body.token || (login.body.data && login.body.data.token)).toBeTruthy();
  });

  test('verify link: wrong token -> email_verified=0; right token -> verified once', async () => {
    const { run, get } = require('../db/database');
    const token = crypto.randomBytes(32).toString('hex');
    const { hashToken } = require('../services/emailVerify');
    await run('UPDATE users SET email_verify_hash = ? WHERE id = ?', [hashToken(token), ctx.userId]);

    const wrong = await ctx.request.get(`/api/auth/verify-email?token=${'0'.repeat(64)}`);
    expect(wrong.status).toBe(302);
    expect(wrong.headers.location).toMatch(/email_verified=0/);

    const okRes = await ctx.request.get(`/api/auth/verify-email?token=${token}`);
    expect(okRes.status).toBe(302);
    expect(okRes.headers.location).toMatch(/email_verified=1/);
    const u = await get('SELECT email_verified_at, email_verify_hash FROM users WHERE id = ?', [ctx.userId]);
    expect(u.email_verified_at).toBeTruthy();
    expect(u.email_verify_hash).toBeNull();

    const reuse = await ctx.request.get(`/api/auth/verify-email?token=${token}`);
    expect(reuse.headers.location).toMatch(/email_verified=0/);

    const me = await ctx.request.get('/api/auth/me').set(AUTH(ctx.token));
    expect(me.body.emailVerified).toBe(true);
    const send = await ctx.request.post('/api/auth/verify-email/send').set(AUTH(ctx.token));
    expect(send.status).toBe(200);
    expect(send.body.alreadyVerified).toBe(true);
  });

  test('resend has a 60 s cooldown; test sign-ups never reach a real inbox', async () => {
    const { run } = require('../db/database');
    const u = await run(`INSERT INTO users (username, email, password) VALUES ('cool', 'cool+smoke@example.test', 'x')`);
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const t = jwt.sign({ id: u.id }, config.jwtSecret, { expiresIn: '1h' });
    const emailService = require('../services/emailService');
    const spy = jest.spyOn(emailService, 'sendEmail');
    delete process.env.VERIFY_TEST_SINK;
    const first = await ctx.request.post('/api/auth/verify-email/send').set(AUTH(t));
    expect([200, 502]).toContain(first.status);
    expect(spy).not.toHaveBeenCalled();
    const second = await ctx.request.post('/api/auth/verify-email/send').set(AUTH(t));
    expect(second.status).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    spy.mockRestore();
  });

  test('letter + sender', () => {
    const ev = require('../services/emailVerify');
    const l = ev.buildLetter('https://x/api/auth/verify-email?token=abc');
    expect(l.subject).toMatch(/Confirm/);
    expect(l.html).toContain('token=abc');
    process.env.LEAD_NOTIFY_FROM = 'INNOVA Leads <leads@remolda.com>';
    expect(ev.sender()).toBe('Finman <noreply@remolda.com>');
    delete process.env.LEAD_NOTIFY_FROM;
  });
});
