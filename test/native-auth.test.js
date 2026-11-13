// test/native-auth.test.js — native app sign-in:
//   1) Google through the system browser: /google?app_nonce -> callback stores
//      the result -> /app-return.html -> one-time POST /app/claim;
//   2) Sign in with Apple: RS256 identity token checked against a mocked JWKS
//      (local RSA key), iss/aud/exp/nonce, user lookup/creation policy;
//   3) GET /me reports the sign-in methods.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { makeApp } = require('./helpers/app');

const GOOGLE_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL', 'GOOGLE_SUCCESS_REDIRECT'];
const nonce = () => crypto.randomBytes(32).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('Google sign-in hand-off to the native app', () => {
  let ctx, passport, strategy, origAuthenticate, User, supertest;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_CALLBACK_URL = 'http://localhost:3000/api/auth/google/callback';
    process.env.GOOGLE_SUCCESS_REDIRECT = 'http://localhost:3000/';
    ctx = await makeApp();
    passport = require('passport');
    supertest = require('supertest');
    User = require('../models/user');
    strategy = passport._strategy('google');
    origAuthenticate = strategy.authenticate;
  });
  afterAll(async () => {
    for (const k of GOOGLE_ENV) delete process.env[k];
    await ctx.close();
  });
  afterEach(() => { strategy.authenticate = origAuthenticate; });

  // Browser leg with one cookie jar: start (real strategy -> Google), then the
  // callback with a stubbed strategy outcome.
  async function browserLeg(appNonce, outcome) {
    strategy.authenticate = origAuthenticate;
    const agent = supertest.agent(ctx.app);
    const start = await agent.get('/api/auth/google' + (appNonce ? `?app_nonce=${appNonce}&att=x` : ''));
    expect(start.status).toBe(302);
    expect(start.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    strategy.authenticate = outcome;
    const cb = await agent.get('/api/auth/google/callback?code=fake');
    return { agent, cb };
  }

  test('success: redirect to /app-return.html, token claimable exactly once', async () => {
    const u = await User.findByUsername('testuser');
    const n = nonce();
    const { cb } = await browserLeg(n, function () { this.success(u); });
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/app-return.html');
    expect(cb.headers.location).not.toMatch(/token/);

    // Only the hash is stored.
    const db = require('../db/database');
    const rows = await db.query('SELECT nonce_hash FROM app_auth_handoff');
    expect(rows.map((r) => r.nonce_hash)).toContain(sha(n));
    expect(rows.map((r) => r.nonce_hash)).not.toContain(n);

    const claim = await ctx.request.post('/api/auth/app/claim').send({ nonce: n });
    expect(claim.status).toBe(200);
    const config = require('../config/config');
    expect(jwt.verify(claim.body.token, config.jwtSecret).id).toBe(u.id);
    const me = await ctx.request.get('/api/auth/me').set('Authorization', 'Bearer ' + claim.body.token);
    expect(me.status).toBe(200);

    const again = await ctx.request.post('/api/auth/app/claim').send({ nonce: n });
    expect(again.status).toBe(404);
  });

  test('email_exists and denial are handed to the app as errors', async () => {
    const n1 = nonce();
    const a = await browserLeg(n1, function () { this.fail({ message: 'email_exists' }); });
    expect(a.cb.headers.location).toBe('/app-return.html?error=email_exists');
    const c1 = await ctx.request.post('/api/auth/app/claim').send({ nonce: n1 });
    expect(c1.status).toBe(200);
    expect(c1.body).toEqual({ error: 'email_exists' });

    const n2 = nonce();
    const b = await browserLeg(n2, function () { this.fail({ message: 'denied' }); });
    expect(b.cb.headers.location).toBe('/app-return.html?error=google_denied');
    const c2 = await ctx.request.post('/api/auth/app/claim').send({ nonce: n2 });
    expect(c2.body).toEqual({ error: 'google_denied' });
  });

  test('without app_nonce the website flow is unchanged', async () => {
    const u = await User.findByUsername('testuser');
    const { cb } = await browserLeg(null, function () { this.success(u); });
    expect(cb.headers.location.startsWith('http://localhost:3000/#token=')).toBe(true);
  });

  test('a website sign-in after an app start in the same browser clears the nonce', async () => {
    const u = await User.findByUsername('testuser');
    const agent = supertest.agent(ctx.app);
    const n = nonce();
    await agent.get(`/api/auth/google?app_nonce=${n}`);
    await agent.get('/api/auth/google');
    strategy.authenticate = function () { this.success(u); };
    const cb = await agent.get('/api/auth/google/callback?code=fake');
    expect(cb.headers.location.startsWith('http://localhost:3000/#token=')).toBe(true);
    expect((await ctx.request.post('/api/auth/app/claim').send({ nonce: n })).status).toBe(404);
  });

  test('malformed nonce on start is ignored; on claim -> 400', async () => {
    const u = await User.findByUsername('testuser');
    const { cb } = await browserLeg('zz' + 'a'.repeat(62), function () { this.success(u); });
    expect(cb.headers.location.startsWith('http://localhost:3000/#token=')).toBe(true);
    for (const bad of [undefined, '', 'abc', 'A'.repeat(64), { $gt: '' }]) {
      const r = await ctx.request.post('/api/auth/app/claim').send({ nonce: bad });
      expect(r.status).toBe(400);
    }
  });

  test('expired hand-off -> 404 and the row is gone', async () => {
    const db = require('../db/database');
    const n = nonce();
    await db.run('INSERT INTO app_auth_handoff (nonce_hash, token, expires_at) VALUES (?, ?, ?)', [sha(n), 'tok', Date.now() - 1000]);
    const r = await ctx.request.post('/api/auth/app/claim').send({ nonce: n });
    expect(r.status).toBe(404);
    expect(await db.get('SELECT 1 FROM app_auth_handoff WHERE nonce_hash = ?', [sha(n)])).toBeUndefined();
  });

  test('handoff.store sets a 10 minute expiry', async () => {
    const handoff = require('../services/appHandoff');
    const db = require('../db/database');
    const n = nonce();
    const before = Date.now();
    await handoff.store(n, { token: 't' });
    const row = await db.get('SELECT expires_at FROM app_auth_handoff WHERE nonce_hash = ?', [sha(n)]);
    expect(row.expires_at).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(row.expires_at).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
  });

  test('claim is rate-limited', async () => {
    let last;
    for (let i = 0; i < 31; i++) last = await ctx.request.post('/api/auth/app/claim').send({ nonce: nonce() });
    expect(last.status).toBe(429);
  });
});

describe('Sign in with Apple', () => {
  let ctx, fetchSpy, keyPair, otherKey, jwk, User, appleAuth, signupFlow;
  const KID = 'test-kid-1';

  function idToken(over = {}, opts = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = Object.assign({
      iss: 'https://appleid.apple.com',
      aud: 'money.finman.app',
      exp: now + 600,
      iat: now,
      sub: '001234.apple-sub-a',
      email: 'apple.person@example.com',
      email_verified: 'true',
      nonce: sha(opts.rawNonce || 'raw-nonce-0123456789abcdef'),
    }, over);
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    return jwt.sign(payload, opts.key || keyPair.privateKey, { algorithm: 'RS256', keyid: opts.kid || KID, noTimestamp: true });
  }

  const post = (body) => ctx.request.post('/api/auth/apple').send(Object.assign({ nonce: 'raw-nonce-0123456789abcdef' }, body));

  beforeAll(async () => {
    keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    jwk = Object.assign(keyPair.publicKey.export({ format: 'jwk' }), { kid: KID, alg: 'RS256', use: 'sig' });
    ctx = await makeApp();
    User = require('../models/user');
    appleAuth = require('../services/appleAuth');
    signupFlow = require('../services/signupFlow');
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url) === 'https://appleid.apple.com/auth/keys') {
        return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
      }
      throw new Error('unexpected fetch ' + url);
    });
  });
  afterAll(async () => {
    fetchSpy.mockRestore();
    await ctx.close();
  });

  test('new user: created with apple_id, email verified, signup hooks run, token works', async () => {
    const hook = jest.spyOn(signupFlow, 'handleSignup');
    const r = await post({ identityToken: idToken(), authorizationCode: 'c', givenName: 'Ann', familyName: 'Lee', attribution: 'a=1' });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('apple.person@example.com');
    expect(r.body.user.fullName).toBe('Ann Lee');
    const row = await User.findByAppleId('001234.apple-sub-a');
    expect(row.email_verified_at).toBeTruthy();
    expect(row.apple_refresh_token_enc).toBeNull(); // no SIWA key configured
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][1]).toBe('apple');
    expect(hook.mock.calls[0][2]).toBe('a=1');
    hook.mockRestore();

    const me = await ctx.request.get('/api/auth/me').set('Authorization', 'Bearer ' + r.body.token);
    expect(me.status).toBe(200);
    expect(me.body.apple).toBe(true);
    expect(me.body.hasPassword).toBe(false);
    // JWKS fetched once and then cached
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/auth/keys'))).toHaveLength(1);
  });

  test('returning user: found by apple_id even without an email claim', async () => {
    const r = await post({ identityToken: idToken({ email: undefined, email_verified: undefined }) });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('apple.person@example.com');
    const db = require('../db/database');
    expect((await db.get(`SELECT COUNT(*) AS n FROM users WHERE apple_id = '001234.apple-sub-a'`)).n).toBe(1);
  });

  test('raw nonce in the token is accepted too', async () => {
    const r = await post({ identityToken: idToken({ nonce: 'raw-nonce-0123456789abcdef' }) });
    expect(r.status).toBe(200);
  });

  test('existing password account with the same email -> 409 email_exists, no link', async () => {
    const r = await post({ identityToken: idToken({ sub: 'sub-b', email: 'TEST@example.com' }) });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('email_exists');
    const u = await User.findByUsername('testuser');
    expect(u.apple_id).toBeNull();
  });

  test('new user without a verified email -> 401 email_missing', async () => {
    expect((await post({ identityToken: idToken({ sub: 'sub-c', email: undefined, email_verified: undefined }) })).body.code).toBe('email_missing');
    expect((await post({ identityToken: idToken({ sub: 'sub-c', email: 'x@example.com', email_verified: 'false' }) })).body.code).toBe('email_missing');
    expect(await User.findByAppleId('sub-c')).toBeUndefined();
  });

  test.each([
    ['wrong issuer', { iss: 'https://evil.example' }, 'invalid_token'],
    ['wrong audience', { aud: 'com.other.app' }, 'invalid_token'],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }, 'token_expired'],
    ['nonce mismatch', { nonce: sha('another-nonce-value-xyz') }, 'invalid_nonce'],
    ['nonce missing', { nonce: undefined }, 'invalid_nonce'],
  ])('rejects %s', async (_, over, code) => {
    const r = await post({ identityToken: idToken(over) });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe(code);
  });

  test('rejects a token signed by another key, an unknown kid, alg none and garbage', async () => {
    expect((await post({ identityToken: idToken({}, { key: otherKey.privateKey }) })).status).toBe(401);
    expect((await post({ identityToken: idToken({}, { kid: 'nope' }) })).status).toBe(401);
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: KID })).toString('base64url') + '.' +
      Buffer.from(JSON.stringify({ iss: 'https://appleid.apple.com', aud: 'money.finman.app', sub: 'x', exp: 9999999999 })).toString('base64url') + '.';
    expect((await post({ identityToken: none })).status).toBe(401);
    expect((await post({ identityToken: 'garbage' })).status).toBe(400);
    expect((await post({ identityToken: idToken(), nonce: '' })).status).toBe(400);
  });

  test('JWKS outage -> 503', async () => {
    appleAuth.resetJwksCache();
    fetchSpy.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const r = await post({ identityToken: idToken() });
    expect(r.status).toBe(503);
  });

  test('with a SIWA key: code exchanged, refresh token stored encrypted', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyPath = path.join(os.tmpdir(), `siwa-${process.pid}.p8`);
    fs.writeFileSync(keyPath, ec.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    const config = require('../config/config');
    Object.assign(config.apple, { keyPath, keyId: 'KEYID12345', teamId: 'TEAMID1234' });
    let tokenCall;
    fetchSpy.mockImplementation(async (url, opts) => {
      if (String(url).endsWith('/auth/keys')) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
      if (String(url).endsWith('/auth/token')) {
        tokenCall = new URLSearchParams(opts.body);
        return { ok: true, status: 200, json: async () => ({ refresh_token: 'apple-refresh-1' }) };
      }
      throw new Error('unexpected');
    });
    try {
      const r = await post({ identityToken: idToken({ sub: 'sub-siwa', email: 'siwa@example.com' }), authorizationCode: 'code-1' });
      expect(r.status).toBe(200);
      expect(tokenCall.get('code')).toBe('code-1');
      expect(tokenCall.get('client_id')).toBe('money.finman.app');
      // client_secret is an ES256 JWT our public key verifies
      const secret = tokenCall.get('client_secret');
      const decoded = jwt.verify(secret, ec.publicKey.export({ format: 'pem', type: 'spki' }), { algorithms: ['ES256'] });
      expect(decoded).toMatchObject({ iss: 'TEAMID1234', sub: 'money.finman.app', aud: 'https://appleid.apple.com' });
      expect(jwt.decode(secret, { complete: true }).header.kid).toBe('KEYID12345');
      const row = await User.findByAppleId('sub-siwa');
      expect(row.apple_refresh_token_enc).toBeTruthy();
      expect(row.apple_refresh_token_enc).not.toContain('apple-refresh-1');
      expect(config.decryptToken(row.apple_refresh_token_enc)).toBe('apple-refresh-1');
    } finally {
      Object.assign(config.apple, { keyPath: '', keyId: '', teamId: '' });
      fs.unlinkSync(keyPath);
    }
  });
});
