// test/review-idor.test.js — cross-user access closed in the pre-merge review
// of feat/finman-wave3-1010: transaction tags, subscription payment history,
// foreign account ids on recurring payments and subscriptions, and the shared
// exchange-rate table.
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
  const config = require('../config/config');
  const ins = await dbRun(ctx.db,
    'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)',
    [username, `${username}@example.com`, 'x', username]);
  return { id: ins.id, token: jwt.sign({ id: ins.id }, config.jwtSecret, { expiresIn: '1h' }) };
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('review: cross-user access', () => {
  let ctx, request, alice, bob, bobAccount, bobTx, bobTag, bobSub;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    alice = { id: ctx.userId, token: ctx.token };
    bob = await makeUser(ctx, 'bob');
    bobAccount = (await dbRun(ctx.db,
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [bob.id, 'Bob chequing', 'CAD', 100, 'checking'])).id;
    bobTx = (await dbRun(ctx.db,
      `INSERT INTO transactions (account_id,user_id,date,description,category,amount,type) VALUES (?,?,?,?,?,?,?)`,
      [bobAccount, bob.id, '2026-10-01', 'pharmacy', 'Health', -20, 'expense'])).id;
    bobTag = (await dbRun(ctx.db, `INSERT INTO tags (user_id,name,color) VALUES (?,?,?)`, [bob.id, 'medical', '#f00'])).id;
    await dbRun(ctx.db, `INSERT INTO transaction_tags (transaction_id,tag_id) VALUES (?,?)`, [bobTx, bobTag]);
    bobSub = (await dbRun(ctx.db,
      `INSERT INTO subscriptions (user_id,name,amount,currency,billing_cycle,start_date,next_billing_date) VALUES (?,?,?,?,?,?,?)`,
      [bob.id, 'Gym', 30, 'CAD', 'monthly', '2026-01-01', '2026-11-01'])).id;
    await dbRun(ctx.db,
      `INSERT INTO subscription_payments (subscription_id,amount,payment_date) VALUES (?,?,?)`,
      [bobSub, 30, '2026-10-01']);
  });

  afterAll(async () => { if (ctx) await ctx.close(); });

  test('tags of another user\'s transaction: GET and PUT -> 404, tags untouched', async () => {
    const g = await request.get(`/api/currency/transaction/${bobTx}/tags`).set(auth(alice.token));
    expect(g.status).toBe(404);
    const p = await request.put(`/api/currency/transaction/${bobTx}/tags`).set(auth(alice.token)).send({ tagIds: [] });
    expect(p.status).toBe(404);
    const own = await request.get(`/api/currency/transaction/${bobTx}/tags`).set(auth(bob.token));
    expect(own.status).toBe(200);
    expect(own.body.map((t) => t.name)).toEqual(['medical']);
  });

  test('PUT /tags/:id on a foreign tag does not leak it', async () => {
    const r = await request.put(`/api/currency/tags/${bobTag}`).set(auth(alice.token)).send({ color: '#000' });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/medical/);
  });

  test('foreign tag ids are ignored when tagging an own transaction', async () => {
    const accA = (await dbRun(ctx.db,
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [alice.id, 'A', 'CAD', 0, 'checking'])).id;
    const txA = (await dbRun(ctx.db,
      `INSERT INTO transactions (account_id,user_id,date,description,category,amount,type) VALUES (?,?,?,?,?,?,?)`,
      [accA, alice.id, '2026-10-01', 'x', 'Other', -1, 'expense'])).id;
    const r = await request.put(`/api/currency/transaction/${txA}/tags`).set(auth(alice.token)).send({ tagIds: [bobTag] });
    expect(r.status).toBe(200);
    expect(r.body.tags).toEqual([]);
  });

  test('subscription payment history of another user -> empty', async () => {
    const r = await request.get(`/api/subscriptions/${bobSub}/payments`).set(auth(alice.token));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    const own = await request.get(`/api/subscriptions/${bobSub}/payments`).set(auth(bob.token));
    expect(own.body.length).toBe(1);
  });

  test('subscription pointed at a foreign account -> 404', async () => {
    const r = await request.post('/api/subscriptions').set(auth(alice.token))
      .send({ name: 'Spy', amount: 1, billing_cycle: 'monthly', start_date: '2026-10-01', account_id: bobAccount });
    expect(r.status).toBe(404);
  });

  test('recurring payment re-pointed at a foreign account -> 404', async () => {
    const accA = (await dbRun(ctx.db,
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [alice.id, 'Rec', 'CAD', 0, 'checking'])).id;
    const created = await request.post('/api/recurring').set(auth(alice.token))
      .send({ accountId: accA, name: 'Rent', amount: 100, startDate: '2026-10-01' });
    expect(created.status).toBe(201);
    const id = created.body.payment.id;
    const r = await request.put(`/api/recurring/${id}`).set(auth(alice.token)).send({ accountId: bobAccount });
    expect(r.status).toBe(404);
  });

  test('manual exchange rate: regular user -> 403; invalid values -> 400 for an admin', async () => {
    const r = await request.post('/api/currency/rate').set(auth(alice.token)).send({ from: 'USD', to: 'CAD', rate: 1000 });
    expect(r.status).toBe(403);
    const config = require('../config/config');
    config.adminEmails.push('test@example.com');
    try {
      const bad = await request.post('/api/currency/rate').set(auth(alice.token)).send({ from: 'USD', to: 'CAD', rate: -1 });
      expect(bad.status).toBe(400);
      const ok = await request.post('/api/currency/rate').set(auth(alice.token)).send({ from: 'USD', to: 'CAD', rate: 1.37 });
      expect(ok.status).toBe(200);
    } finally {
      config.adminEmails.length = 0;
    }
  });
});
