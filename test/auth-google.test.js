// test/auth-google.test.js — вход через Google (PORT_PLAN A3), офлайн.
//
// Покрывает:
//   1) без GOOGLE_CLIENT_ID/SECRET: /google/status -> {enabled:false},
//      /google и /google/callback -> 503, стратегия 'google' не регистрируется;
//   2) с фейковыми кредами: status -> {enabled:true}, /google -> 302 на
//      accounts.google.com с нашим client_id и callback;
//   3) verify-колбэк стратегии напрямую (без сети): известный google_id ->
//      тот же пользователь; совпавший email -> привязка без дубликата;
//      новый профиль -> создание + ОДНО уведомление оператора; профиль без
//      email -> отказ; повторный вход -> уведомления нет;
//   4) /google/callback с подменённой стратегией: redirect на
//      successRedirect#token=<JWT {id}>; отказ -> ?auth_error=google_denied;
//   5) миграция 017a: колонки google_id/avatar_url и уникальный индекс,
//      повторный прогон — no-op.

const { makeApp } = require('./helpers/app');
const jwt = require('jsonwebtoken');

// ВАЖНО: passport нужно require'ить ПОСЛЕ makeApp(): харнес сбрасывает реестр
// модулей jest, и инстанс, загруженный раньше, не тот, что видит приложение.
let passport;

const GOOGLE_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL', 'GOOGLE_SUCCESS_REDIRECT'];

function clearGoogleEnv() {
  for (const k of GOOGLE_ENV) delete process.env[k];
}

function profile(over = {}) {
  return Object.assign({
    id: 'g-1001',
    displayName: 'Google Person',
    emails: [{ value: 'Google.Person@example.com', verified: true }],
    photos: [{ value: 'https://lh3.googleusercontent.com/a/photo.jpg' }],
  }, over);
}

// Прогоняет verify-колбэк и возвращает { err, user, info }.
function runVerify(verify, prof) {
  return new Promise((resolve) => {
    verify('access', 'refresh', prof, (err, user, info) => resolve({ err, user, info }));
  });
}

describe('Google sign-in: disabled without credentials', () => {
  let ctx;
  beforeAll(async () => {
    clearGoogleEnv();
    ctx = await makeApp();
  });
  afterAll(async () => { await ctx.close(); });

  test('GET /api/auth/google/status -> { enabled: false }', async () => {
    const r = await ctx.request.get('/api/auth/google/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false });
  });

  test('GET /api/auth/google and /callback -> 503', async () => {
    const a = await ctx.request.get('/api/auth/google');
    expect(a.status).toBe(503);
    const b = await ctx.request.get('/api/auth/google/callback?code=x');
    expect(b.status).toBe(503);
  });

  test('authService.googleEnabled() is false and registerGoogleStrategy() returns false', () => {
    const authService = require('../services/authService');
    expect(authService.googleEnabled()).toBe(false);
    expect(authService.registerGoogleStrategy()).toBe(false);
  });

  test('migration 017a added users.google_id / avatar_url and the unique index; re-run is a no-op', async () => {
    const db = require('../db/database');
    const cols = await db.query('PRAGMA table_info(users)');
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['google_id', 'avatar_url']));
    const idx = await db.query("PRAGMA index_list(users)");
    expect(idx.some((i) => i.name === 'idx_users_google_id' && i.unique === 1)).toBe(true);
    const applied = await db.query("SELECT name FROM schema_migrations WHERE name = '017a_google_columns'");
    expect(applied.length).toBe(1);

    // Повторный up() под гардами ничего не ломает.
    const { columnExists } = require('../lib/migrate');
    const m = require('../migrations/017a_google_columns');
    await expect(m.up(db, { columnExists })).resolves.toBeUndefined();

    // Два пользователя с одинаковым google_id не проходят; NULL — сколько угодно.
    await db.run("UPDATE users SET google_id = 'dup-1' WHERE id = ?", [ctx.userId]);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      db.run("INSERT INTO users (username, email, password, google_id) VALUES ('u2','u2@x.io','h','dup-1')")
    ).rejects.toThrow(/UNIQUE/);
    quiet.mockRestore();
    await db.run("INSERT INTO users (username, email, password) VALUES ('u3','u3@x.io','h')");
    await db.run("INSERT INTO users (username, email, password) VALUES ('u4','u4@x.io','h')");
  });
});

describe('Google sign-in: enabled with credentials', () => {
  let ctx, authService, User, signupNotify, emailService, sendSpy;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_CALLBACK_URL = 'http://localhost:3000/api/auth/google/callback';
    process.env.GOOGLE_SUCCESS_REDIRECT = 'http://localhost:3000/';
    process.env.RESEND_API_KEY = 'test-resend-key';
    delete process.env.GA4_MEASUREMENT_ID;
    delete process.env.GA4_API_SECRET;

    ctx = await makeApp();
    passport = require('passport');
    authService = require('../services/authService');
    User = require('../models/user');
    signupNotify = require('../services/signupNotify');
    emailService = require('../services/emailService');
    sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ sent: true, id: 'mail-1' });
  });

  afterAll(async () => {
    sendSpy.mockRestore();
    clearGoogleEnv();
    delete process.env.RESEND_API_KEY;
    await ctx.close();
  });

  afterEach(() => sendSpy.mockClear());

  test('status -> { enabled: true }; strategy registered', async () => {
    const r = await ctx.request.get('/api/auth/google/status');
    expect(r.body).toEqual({ enabled: true });
    expect(authService.googleEnabled()).toBe(true);
    expect(passport._strategy('google')).toBeDefined();
  });

  test('GET /api/auth/google -> 302 to accounts.google.com with our client_id and callback', async () => {
    const r = await ctx.request.get('/api/auth/google');
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.hostname).toBe('accounts.google.com');
    expect(loc.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/google/callback');
    expect(loc.searchParams.get('scope')).toMatch(/email/);
  });

  test('verify: new Google profile -> user created, unusable password, exactly one notification', async () => {
    const { err, user } = await runVerify(authService.googleVerify, profile());
    expect(err).toBeFalsy();
    expect(user).toBeTruthy();
    expect(user.email).toBe('google.person@example.com'); // lower-cased
    expect(user.google_id).toBe('g-1001');
    expect(user.avatar_url).toBe('https://lh3.googleusercontent.com/a/photo.jpg');
    expect(user.full_name).toBe('Google Person');
    expect(user.username).toBe('google.person');

    const row = await User.findByUsername('google.person');
    expect(await User.verifyPassword(row, '')).toBe(false);
    expect(await User.verifyPassword(row, 'password123')).toBe(false);

    await signupNotify.flush();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const mail = sendSpy.mock.calls[0][0];
    expect(mail.subject).toBe('Signup · finman.money · google.person@example.com');
    expect(mail.from).toMatch(/^INNOVA Leads </);
    expect(mail.to).toEqual(['ctmakc@gmail.com']);
    expect(mail.replyTo).toBe('google.person@example.com');
    expect(mail.text).toMatch(/Method: Google/);
  });

  test('verify: returning Google user -> same account, no second notification', async () => {
    const first = await User.findByGoogleId('g-1001');
    const { err, user } = await runVerify(authService.googleVerify, profile());
    expect(err).toBeFalsy();
    expect(user.id).toBe(first.id);
    await signupNotify.flush();
    expect(sendSpy).not.toHaveBeenCalled();
    const all = await require('../db/database').query("SELECT COUNT(*) AS n FROM users WHERE email = 'google.person@example.com'");
    expect(all[0].n).toBe(1);
  });

  // Local emails are never verified: whoever registered victim@ with a
  // password first would receive the victim's Google sign-in. No auto-link.
  test('verify: email matches a password account -> refused (email_exists), nothing linked or created', async () => {
    const before = (await require('../db/database').query('SELECT COUNT(*) AS n FROM users'))[0].n;
    const { err, user, info } = await runVerify(authService.googleVerify, profile({
      id: 'g-2002',
      emails: [{ value: 'TEST@example.com', verified: true }],
      photos: [{ value: 'https://lh3.googleusercontent.com/a/seed.jpg' }],
    }));
    expect(err).toBeFalsy();
    expect(user).toBe(false);
    expect(info.message).toBe('email_exists');
    const row = await User.findById(ctx.userId);
    expect(row.google_id).toBeFalsy();
    const after = (await require('../db/database').query('SELECT COUNT(*) AS n FROM users'))[0].n;
    expect(after).toBe(before);
    await signupNotify.flush();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('verify: unverified Google email -> rejected, nothing created', async () => {
    const before = (await require('../db/database').query('SELECT COUNT(*) AS n FROM users'))[0].n;
    const { user, info } = await runVerify(authService.googleVerify, profile({
      id: 'g-6006',
      emails: [{ value: 'unverified@example.com', verified: false }],
    }));
    expect(user).toBe(false);
    expect(info.message).toMatch(/verified email/);
    const after = (await require('../db/database').query('SELECT COUNT(*) AS n FROM users'))[0].n;
    expect(after).toBe(before);
  });

  test('verify: password account registered with a MIXED-case email is matched (refused), not duplicated', async () => {
    const db = require('../db/database');
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('pw-mixed', 4);
    await db.run("INSERT INTO users (username, email, password, full_name) VALUES ('mixedcase', 'Mixed.Case@Example.com', ?, 'Mixed')", [hash]);
    const before = (await db.query('SELECT COUNT(*) AS n FROM users'))[0].n;

    // Google всегда отдаёт email в нижнем регистре.
    const { err, user, info } = await runVerify(authService.googleVerify, profile({
      id: 'g-5005',
      emails: [{ value: 'mixed.case@example.com', verified: true }],
    }));
    expect(err).toBeFalsy();
    expect(user).toBe(false);
    expect(info.message).toBe('email_exists');
    const after = (await db.query('SELECT COUNT(*) AS n FROM users'))[0].n;
    expect(after).toBe(before); // привязка, не второй аккаунт
    await signupNotify.flush();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('verify: profile without email -> rejected, nothing created', async () => {
    const before = (await require('../db/database').query('SELECT COUNT(*) AS n FROM users'))[0].n;
    const { err, user, info } = await runVerify(authService.googleVerify, profile({ id: 'g-3003', emails: [] }));
    expect(err).toBeFalsy();
    expect(user).toBe(false);
    expect(info && info.message).toMatch(/email/i);
    const after = (await require('../db/database').query('SELECT COUNT(*) AS n FROM users'))[0].n;
    expect(after).toBe(before);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('verify: username clash gets a suffix instead of failing', async () => {
    const { err, user } = await runVerify(authService.googleVerify, profile({
      id: 'g-4004',
      emails: [{ value: 'testuser@other.example', verified: true }], // base "testuser" already exists
    }));
    expect(err).toBeFalsy();
    expect(user.username).toMatch(/^testuser-[0-9a-f]{4}$/);
    await signupNotify.flush();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  describe('callback redirect (strategy stubbed, no network)', () => {
    let strategy, origAuthenticate;
    beforeAll(() => {
      strategy = passport._strategy('google');
      origAuthenticate = strategy.authenticate;
    });
    afterEach(() => { strategy.authenticate = origAuthenticate; });

    test('success -> 302 successRedirect#token=<JWT {id}> (wave2 payload, no orgId/role)', async () => {
      const u = await User.findByGoogleId('g-1001');
      strategy.authenticate = function () { this.success(u); };
      const r = await ctx.request.get('/api/auth/google/callback?code=fake');
      expect(r.status).toBe(302);
      const loc = r.headers.location;
      expect(loc.startsWith('http://localhost:3000/#token=')).toBe(true);
      const token = decodeURIComponent(loc.split('#token=')[1]);
      const config = require('../config/config');
      const payload = jwt.verify(token, config.jwtSecret);
      expect(payload.id).toBe(u.id);
      expect(payload.orgId).toBeUndefined();
      expect(payload.role).toBeUndefined();
      // Токен принимается защищённым роутом.
      const me = await ctx.request.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(200);
      expect(me.body.username).toBe('google.person');
    });

    test('denied -> 302 successRedirect?auth_error=google_denied', async () => {
      strategy.authenticate = function () { this.fail({ message: 'denied' }); };
      const r = await ctx.request.get('/api/auth/google/callback?error=access_denied');
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe('http://localhost:3000/?auth_error=google_denied');
    });

    test('existing password account -> 302 successRedirect?auth_error=email_exists', async () => {
      strategy.authenticate = function () { this.fail({ message: 'email_exists' }); };
      const r = await ctx.request.get('/api/auth/google/callback?code=fake');
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe('http://localhost:3000/?auth_error=email_exists');
    });

    test('strategy error -> 302 successRedirect?auth_error=google_failed', async () => {
      strategy.authenticate = function () { this.error(new Error('boom')); };
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const r = await ctx.request.get('/api/auth/google/callback?code=fake');
      spy.mockRestore();
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe('http://localhost:3000/?auth_error=google_failed');
    });
  });
});

describe('bcrypt cost is configurable and backwards compatible', () => {
  let ctx;
  afterEach(async () => { if (ctx) await ctx.close(); ctx = null; delete process.env.BCRYPT_ROUNDS; });

  test('default cost is 12; BCRYPT_ROUNDS overrides; prod (12) and wave2 (10) hashes both verify', async () => {
    clearGoogleEnv();
    delete process.env.BCRYPT_ROUNDS;
    ctx = await makeApp();
    const config = require('../config/config');
    expect(config.bcryptRounds).toBe(12);
    const User = require('../models/user');
    const bcrypt = require('bcrypt');

    const created = await User.create({ username: 'costuser', email: 'cost@example.com', password: 'secret12', fullName: '' });
    const row = await User.findByUsername('costuser');
    expect(row.password.startsWith('$2b$12$')).toBe(true);
    expect(await User.verifyPassword(row, 'secret12')).toBe(true);

    // Хеш стоимости 10 (wave2) и 12 (прод) проверяются одинаково.
    const h10 = await bcrypt.hash('pw', 10);
    const h12 = await bcrypt.hash('pw', 12);
    expect(await User.verifyPassword({ password: h10 }, 'pw')).toBe(true);
    expect(await User.verifyPassword({ password: h12 }, 'pw')).toBe(true);
    expect(created.id).toBeTruthy();
  });

  test('BCRYPT_ROUNDS=10 produces $2b$10$ hashes', async () => {
    process.env.BCRYPT_ROUNDS = '10';
    ctx = await makeApp();
    const config = require('../config/config');
    expect(config.bcryptRounds).toBe(10);
    const User = require('../models/user');
    await User.create({ username: 'cost10', email: 'cost10@example.com', password: 'secret12', fullName: '' });
    const row = await User.findByUsername('cost10');
    expect(row.password.startsWith('$2b$10$')).toBe(true);
  });
});
