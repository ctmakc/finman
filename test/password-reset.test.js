// test/password-reset.test.js — forgot / reset password flow.
//
// The email provider is mocked so the test can read the link that would have
// been mailed. The flow must: never reveal whether an email exists, hand out a
// single-use one-hour token, change the password through User.update (so the
// old JWT dies with token_version) and refuse reused / expired / unknown tokens.
const { makeApp } = require('./helpers/app');

jest.mock('../services/emailService', () => {
  const sent = [];
  return {
    __sent: sent,
    isConfigured: () => true,
    getFrom: () => 'Finman <noreply@example.com>',
    sendEmail: jest.fn(async (msg) => { sent.push(msg); return { sent: true, id: 'mock' }; }),
  };
});

// makeApp() resets the module registry, so the instance the app uses is the
// one required AFTER makeApp (see beforeAll), not a top-level require.
let emailService;

function lastToken() {
  const msg = emailService.__sent[emailService.__sent.length - 1];
  const m = msg && String(msg.text).match(/reset-password\?token=([0-9a-f]{64})/);
  return m ? m[1] : null;
}

describe('password reset', () => {
  let ctx;
  // A fresh app per test: each one gets its own rate-limit buckets and DB.
  beforeEach(async () => {
    ctx = await makeApp();
    emailService = require('../services/emailService');
    emailService.__sent.length = 0;
  });
  afterEach(async () => { await ctx.close(); });

  test('unknown email -> same 200 message, nothing sent', async () => {
    const res = await ctx.request.post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(emailService.__sent).toHaveLength(0);
  });

  test('malformed email -> 400', async () => {
    const res = await ctx.request.post('/api/auth/forgot-password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  test('known email -> link with a 64-hex token is mailed, same generic message', async () => {
    const res = await ctx.request.post('/api/auth/forgot-password').send({ email: 'TEST@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const msg = emailService.__sent[0];
    expect(msg.to).toBe('test@example.com');
    expect(msg.subject).toMatch(/reset/i);
    expect(msg.html).toContain('/reset-password?token=');
    expect(lastToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('reset: weak password -> 400, bad token -> 400, good token -> password changed and old JWT revoked', async () => {
    await ctx.request.post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    const token = lastToken();

    const weak = await ctx.request.post('/api/auth/reset-password').send({ token, password: '123' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('WEAK_PASSWORD');

    const bad = await ctx.request.post('/api/auth/reset-password').send({ token: 'f'.repeat(64), password: 'brand-new-pass' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('RESET_TOKEN_INVALID');

    const ok = await ctx.request.post('/api/auth/reset-password').send({ token, password: 'brand-new-pass' });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);

    // The token issued before the reset is dead (token_version bumped).
    const me = await ctx.request.get('/api/auth/me').set('Authorization', `Bearer ${ctx.token}`);
    expect(me.status).toBe(401);

    // Old password no longer works, the new one does.
    const oldLogin = await ctx.request.post('/api/auth/login').send({ username: 'testuser', password: 'password123' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await ctx.request.post('/api/auth/login').send({ username: 'testuser', password: 'brand-new-pass' });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.token).toBeTruthy();

    // Single use: the same token is refused afterwards.
    const again = await ctx.request.post('/api/auth/reset-password').send({ token, password: 'another-pass-1' });
    expect(again.status).toBe(400);
  });

  test('a newer request voids the previous token; an expired token is refused', async () => {
    await ctx.request.post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    const first = lastToken();
    await ctx.request.post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    const second = lastToken();
    expect(first).not.toBe(second);

    const stale = await ctx.request.post('/api/auth/reset-password').send({ token: first, password: 'whatever-123' });
    expect(stale.status).toBe(400);

    // Expire the live token by hand.
    await new Promise((resolve, reject) =>
      ctx.db.run(`UPDATE password_resets SET expires_at = ? WHERE used_at IS NULL`, ['2000-01-01T00:00:00.000Z'],
        (err) => (err ? reject(err) : resolve()))
    );
    const expired = await ctx.request.post('/api/auth/reset-password').send({ token: second, password: 'whatever-123' });
    expect(expired.status).toBe(400);
    expect(expired.body.code).toBe('RESET_TOKEN_INVALID');
  });

  test('APP_URL wins over the request origin in the emailed link', async () => {
    process.env.APP_URL = 'https://app.finman.money/';
    try {
      await ctx.request.post('/api/auth/forgot-password').send({ email: 'test@example.com' });
      expect(emailService.__sent[0].text).toContain('https://app.finman.money/reset-password?token=');
    } finally {
      delete process.env.APP_URL;
    }
  });
});
