// test/auth-me-409.test.js — PUT /api/auth/me with an email another account
// already uses must answer 409 (was a 500 from the UNIQUE constraint).
const { makeApp } = require('./helpers/app');
const bcrypt = require('bcrypt');

describe('PUT /api/auth/me email uniqueness', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    const hash = await bcrypt.hash('password123', 4);
    await new Promise((resolve, reject) =>
      ctx.db.run(
        `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
        ['other', 'other@example.com', hash, 'Other'],
        (err) => (err ? reject(err) : resolve())
      )
    );
  });
  afterAll(async () => { await ctx.close(); });

  test('taken email -> 409 with error message, nothing changed', async () => {
    const res = await ctx.request
      .put('/api/auth/me')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ email: 'other@example.com', currentPassword: 'password123' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(true);
    expect(res.body.message).toMatch(/email/i);

    const me = await ctx.request.get('/api/auth/me').set('Authorization', `Bearer ${ctx.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('test@example.com');
  });

  test('own email (no-op) and a free email -> 200', async () => {
    const same = await ctx.request
      .put('/api/auth/me')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ email: 'test@example.com', fullName: 'Renamed' });
    expect(same.status).toBe(200);
    expect(same.body.fullName).toBe('Renamed');

    const free = await ctx.request
      .put('/api/auth/me')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ email: 'new@example.com', currentPassword: 'password123' });
    expect(free.status).toBe(200);
    expect(free.body.email).toBe('new@example.com');
  });

  test('email change without / with a wrong current password -> 400, nothing changed', async () => {
    const none = await ctx.request
      .put('/api/auth/me')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ email: 'hijack@example.com' });
    expect(none.status).toBe(400);
    const wrong = await ctx.request
      .put('/api/auth/me')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ email: 'hijack@example.com', currentPassword: 'nope' });
    // 400, not 401: the client treats 401 as an expired session and logs out.
    expect(wrong.status).toBe(400);
    const me = await ctx.request.get('/api/auth/me').set('Authorization', `Bearer ${ctx.token}`);
    expect(me.body.email).toBe('new@example.com');
  });
});
