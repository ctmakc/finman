// test/review-family.test.js — family sharing and misc hardening from the
// pre-merge review of feat/finman-wave3-1010.
const { makeApp } = require('./helpers/app');

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function makeUser(db, config, username) {
  const jwt = require('jsonwebtoken');
  const ins = await db.run('INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)',
    [username, `${username}@example.com`, 'x', username]);
  return { id: ins.id, token: jwt.sign({ id: ins.id }, config.jwtSecret, { expiresIn: '1h' }) };
}

describe('review: family sharing', () => {
  let ctx, db, request, stranger, member, familyId, accountId;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    request = ctx.request;
    const config = require('../config/config');
    stranger = await makeUser(db, config, 'stranger');
    member = await makeUser(db, config, 'member');
    const fam = await request.post('/api/family').set(auth(ctx.token)).send({ name: 'Home' });
    familyId = fam.body.family.id;
    await db.run(`INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'member')`, [familyId, member.id]);
    accountId = (await db.run(
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [ctx.userId, 'Joint', 'CAD', 0, 'checking'])).id;
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  test('granting account access to a non-family user is refused and leaks nothing', async () => {
    const r = await request.post(`/api/family/accounts/${accountId}/permissions`).set(auth(ctx.token))
      .send({ userId: stranger.id, canView: false });
    expect(r.status).toBe(400);
    const list = await request.get(`/api/family/accounts/${accountId}/permissions`).set(auth(ctx.token));
    expect(JSON.stringify(list.body)).not.toMatch(/stranger@example\.com/);
  });

  test('granting to a family member works', async () => {
    const r = await request.post(`/api/family/accounts/${accountId}/permissions`).set(auth(ctx.token))
      .send({ userId: member.id, canView: true });
    expect(r.status).toBe(200);
  });

  test('invite roles: owner/arbitrary refused, admin only from the owner', async () => {
    for (const role of ['owner', 'superadmin']) {
      const r = await request.post(`/api/family/${familyId}/invite`).set(auth(ctx.token)).send({ email: 'x@example.com', role });
      expect(r.status).toBe(403);
    }
    const ok = await request.post(`/api/family/${familyId}/invite`).set(auth(ctx.token)).send({ email: 'x@example.com', role: 'admin' });
    expect(ok.status).toBe(200);
  });

  test('literal family routes are no longer swallowed by /:id', async () => {
    const a = await request.get('/api/family/accessible-accounts').set(auth(ctx.token));
    expect(a.status).toBe(200);
    const b = await request.get('/api/family/accessible-budgets').set(auth(ctx.token));
    expect(b.status).toBe(200);
    const n = await request.delete('/api/notifications/old').set(auth(ctx.token));
    expect(n.status).not.toBe(404);
  });

  test('base currency setting accepts snake_case and rejects junk', async () => {
    const r = await request.put('/api/currency/settings').set(auth(ctx.token)).send({ base_currency: 'eur' });
    expect(r.status).toBe(200);
    expect(r.body.settings.base_currency || r.body.settings.baseCurrency).toBe('EUR');
    const bad = await request.put('/api/currency/settings').set(auth(ctx.token)).send({ baseCurrency: '<x>' });
    expect(bad.status).toBe(400);
  });
});

describe('review: production secrets', () => {
  test('placeholder secrets from .env.example are refused in production', () => {
    const validateEnv = require('../lib/validateEnv');
    const env = {
      NODE_ENV: 'production',
      JWT_SECRET: 'change-me-32-byte-hex',
      SESSION_SECRET: 'a'.repeat(64),
      ENCRYPTION_KEY: 'b'.repeat(64),
    };
    expect(() => validateEnv(env)).toThrow(/JWT_SECRET/);
    expect(validateEnv({ ...env, JWT_SECRET: 'c'.repeat(64) }).ok).toBe(true);
  });
});
