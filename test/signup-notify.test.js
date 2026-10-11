// test/signup-notify.test.js — уведомление оператора о регистрации (PORT_PLAN A9).
//
// Офлайн: emailService.sendEmail подменён через jest.spyOn, https.request —
// фейком. Покрывает:
//   1) POST /api/auth/register -> ровно одно письмо, нужные тема/отправитель/
//      получатели/Reply-To, ответ клиенту не ждёт почту;
//   2) POST /api/auth/login -> писем нет;
//   3) неудачная регистрация (дубликат) -> писем нет;
//   4) без RESEND_API_KEY -> пропуск без ошибок;
//   5) LEAD_NOTIFY_TO/LEAD_NOTIFY_FROM уважаются; LEAD_NOTIFY_FROM важнее MAIL_FROM;
//   6) GA4: при заданных GA4_MEASUREMENT_ID/GA4_API_SECRET уходит один POST
//      на www.google-analytics.com /mp/collect с событием sign_up без email;
//      без них — пропуск;
//   7) ретрай: сетевая ошибка повторяется, 4xx (кроме 429) — нет;
//   8) падение почты не роняет вызывающий код.

const https = require('https');
const { EventEmitter } = require('events');
const { makeApp } = require('./helpers/app');

const NOTIFY_ENV = ['LEAD_NOTIFY_TO', 'LEAD_NOTIFY_FROM', 'GA4_MEASUREMENT_ID', 'GA4_API_SECRET', 'RESEND_API_KEY', 'MAIL_FROM'];
function clearNotifyEnv() { for (const k of NOTIFY_ENV) delete process.env[k]; }

// Фейк https.request: записывает вызовы, отвечает заданным статусом.
function fakeHttps(status = 204) {
  const calls = [];
  const spy = jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
    const req = new EventEmitter();
    const chunks = [];
    req.write = (c) => chunks.push(String(c));
    req.end = () => {
      calls.push({ opts, body: chunks.join('') });
      const res = new EventEmitter();
      res.statusCode = status;
      res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('end'); });
    };
    req.destroy = () => {};
    return req;
  });
  return { calls, spy };
}

let n = 0;
function regBody(over = {}) {
  n += 1;
  return Object.assign({
    username: `newuser${n}`,
    email: `newuser${n}@example.com`,
    password: 'password123',
    fullName: `New User ${n}`,
  }, over);
}

describe('signupNotify via /api/auth/register and /login', () => {
  let ctx, emailService, signupNotify, sendSpy;

  beforeAll(async () => {
    clearNotifyEnv();
    process.env.RESEND_API_KEY = 'test-resend-key';
    ctx = await makeApp();
    emailService = require('../services/emailService');
    signupNotify = require('../services/signupNotify');
    sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ sent: true, id: 'mail-1' });
  });
  afterAll(async () => { sendSpy.mockRestore(); clearNotifyEnv(); await ctx.close(); });
  afterEach(() => sendSpy.mockClear());

  test('register -> 200 immediately and exactly one notification with the inbox-safe subject', async () => {
    // Почта «висит» — ответ клиенту всё равно приходит сразу.
    let release;
    sendSpy.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const body = regBody();
    const r = await ctx.request.post('/api/auth/register').send(body);
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    release({ sent: true, id: 'late' });
    await signupNotify.flush();

    const mail = sendSpy.mock.calls[0][0];
    expect(mail.subject).toBe(`Signup · finman.money · ${body.email}`);
    expect(mail.from).toBe('INNOVA Leads <leads@remolda.com>');
    expect(mail.to).toEqual(['ctmakc@gmail.com']);
    expect(mail.replyTo).toBe(body.email);
    expect(mail.text).toContain(`Username: ${body.username}`);
    expect(mail.text).toContain(`Email: ${body.email}`);
    expect(mail.text).toContain('Method: email');
    expect(mail.html).toContain('<table');
    expect(mail.html).toContain(body.username);
  });

  test('login -> no notification', async () => {
    const r = await ctx.request.post('/api/auth/login').send({ username: 'testuser', password: 'password123' });
    expect(r.status).toBe(200);
    await signupNotify.flush();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('failed registration (duplicate username) -> no notification', async () => {
    const r = await ctx.request.post('/api/auth/register').send(regBody({ username: 'testuser' }));
    expect(r.status).toBe(400);
    await signupNotify.flush();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('HTML in the name is escaped in the mail body', async () => {
    const body = regBody({ fullName: '<img src=x onerror=alert(1)>' });
    const r = await ctx.request.post('/api/auth/register').send(body);
    expect(r.status).toBe(200);
    await signupNotify.flush();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const mail = sendSpy.mock.calls[0][0];
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;img');
  });

  // authLimiter общий для /login и /register (5 за 15 мин) — дальше без HTTP.
  test('LEAD_NOTIFY_TO / LEAD_NOTIFY_FROM are honoured and LEAD_NOTIFY_FROM wins over MAIL_FROM', async () => {
    process.env.LEAD_NOTIFY_TO = 'a@example.com, b@example.com';
    process.env.LEAD_NOTIFY_FROM = 'INNOVA Leads <leads@test.example>';
    process.env.MAIL_FROM = 'FinMan <noreply@finman.app>';
    try {
      await signupNotify.notifySignup({ id: 7, username: 'env7', email: 'env7@example.com' }, 'password');
      const mail = sendSpy.mock.calls[0][0];
      expect(mail.to).toEqual(['a@example.com', 'b@example.com']);
      expect(mail.from).toBe('INNOVA Leads <leads@test.example>');
    } finally {
      delete process.env.LEAD_NOTIFY_TO; delete process.env.LEAD_NOTIFY_FROM; delete process.env.MAIL_FROM;
    }
  });

  test('a rejected mail promise never escapes notifySignup (caller never sees it)', async () => {
    sendSpy.mockRejectedValueOnce(new Error('resend down'));
    const res = await signupNotify.notifySignup({ id: 8, username: 'u8', email: 'u8@example.com' }, 'password');
    expect(Array.isArray(res)).toBe(true);
    expect(res[0].sent).toBe(false);
    await expect(signupNotify.flush()).resolves.toBeDefined();
  });
});

describe('signupNotify unit: skip, retry, GA4', () => {
  let ctx, emailService, signupNotify;
  beforeAll(async () => {
    clearNotifyEnv();
    ctx = await makeApp();
    emailService = require('../services/emailService');
    signupNotify = require('../services/signupNotify');
  });
  afterAll(async () => { clearNotifyEnv(); await ctx.close(); });
  afterEach(() => { jest.restoreAllMocks(); clearNotifyEnv(); });

  const user = { id: 42, username: 'u42', email: 'u42@example.com', fullName: 'U 42' };

  test('without RESEND_API_KEY the mail is skipped and sendEmail is not called', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail');
    const [mail, ga] = await signupNotify.notifySignup(user, 'password');
    expect(spy).not.toHaveBeenCalled();
    expect(mail.skipped).toBe(true);
    expect(ga.skipped).toBe(true);
  });

  test('network failure is retried up to 3 times, then reported', async () => {
    process.env.RESEND_API_KEY = 'k';
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ sent: false, error: true, reason: 'SEND_FAILED', status: null });
    const [mail] = await signupNotify.notifySignup(user, 'password', { retryDelayMs: 0, skipGa4: true });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(mail.sent).toBe(false);
  });

  test('4xx (not 429) is not retried; 429 is', async () => {
    process.env.RESEND_API_KEY = 'k';
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ sent: false, error: true, reason: 'SEND_FAILED', status: 422 });
    await signupNotify.notifySignup(user, 'password', { retryDelayMs: 0, skipGa4: true });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    spy.mockResolvedValue({ sent: false, error: true, reason: 'SEND_FAILED', status: 429 });
    await signupNotify.notifySignup(user, 'password', { retryDelayMs: 0, skipGa4: true });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test('GA4: one POST to /mp/collect with sign_up and no email; client_id is a hash of the id', async () => {
    process.env.GA4_MEASUREMENT_ID = 'G-TEST123';
    process.env.GA4_API_SECRET = 's3cr3t';
    const { calls } = fakeHttps(204);
    const [, ga] = await signupNotify.notifySignup(user, 'google');
    expect(ga).toEqual({ ok: true, status: 204 });
    expect(calls).toHaveLength(1);
    const { opts, body } = calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.hostname).toBe('www.google-analytics.com');
    expect(opts.path).toBe('/mp/collect?measurement_id=G-TEST123&api_secret=s3cr3t');
    const parsed = JSON.parse(body);
    expect(parsed.events[0].name).toBe('sign_up');
    expect(parsed.events[0].params.method).toBe('google');
    expect(parsed.client_id).toMatch(/^\d+\.\d+$/);
    expect(body).not.toContain('u42@example.com');
    expect(body).not.toContain('42"'); // raw id is not sent either

    // Детерминированность client_id для одного и того же пользователя.
    const again = await signupNotify.sendGa4SignUp('google', user.id);
    expect(again.ok).toBe(true);
    expect(JSON.parse(calls[1].body).client_id).toBe(parsed.client_id);
  });

  test('GA4: skipped without GA4_MEASUREMENT_ID/GA4_API_SECRET; request error is swallowed', async () => {
    const { calls } = fakeHttps(204);
    const r = await signupNotify.sendGa4SignUp('password', 1);
    expect(r).toEqual({ skipped: true });
    expect(calls).toHaveLength(0);

    process.env.GA4_MEASUREMENT_ID = 'G-X';
    process.env.GA4_API_SECRET = 'y';
    jest.restoreAllMocks();
    jest.spyOn(https, 'request').mockImplementation(() => {
      const req = new EventEmitter();
      req.write = () => {}; req.destroy = () => {};
      req.end = () => setImmediate(() => req.emit('error', new Error('ECONNRESET')));
      return req;
    });
    const bad = await signupNotify.sendGa4SignUp('password', 1);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('ECONNRESET');
  });

  test('buildSubject uses the email and the finman.money site tag', () => {
    expect(signupNotify.buildSubject({ email: 'x@y.z' })).toBe('Signup · finman.money · x@y.z');
    expect(signupNotify.buildSubject({ username: 'nomail' })).toBe('Signup · finman.money · nomail');
  });
});

describe('signupNotify: smoke/QA sign-ups are not reported', () => {
  test('*.test and +smoke addresses skip mail and GA4', async () => {
    const { notifySignup, isTestSignup } = require('../services/signupNotify');
    expect(isTestSignup({ email: 'smoke-1@finman-smoke.test' })).toBe(true);
    expect(isTestSignup({ email: 'owner+smoke1@gmail.com' })).toBe(true);
    expect(isTestSignup({ email: 'person@example.com' })).toBe(false);
    expect(isTestSignup({ email: 'test@gmail.com' })).toBe(false);
    const [mail, ga] = await notifySignup({ id: 1, email: 'smoke-1@finman-smoke.test' }, 'password');
    expect(mail.reason).toBe('TEST_SIGNUP');
    expect(ga.skipped).toBe(true);
  });
});

