// test/acquisition.test.js — where users come from and what they do.
//   1) register with attribution -> user_acquisition row, source label,
//      sign_up event, the operator email carries the "Where from" section;
//   2) honeypot field filled -> no account, no email;
//   3) activity journal: a successful POST /api/transactions -> event;
//   4) /api/t beacon accepts only whitelisted events;
//   5) sourceLabel / normalizeAttribution rules;
//   6) OpenPanel forwarding only when configured, never for test sign-ups;
//   7) unsubscribe link sets the opt-out flag;
//   8) lifecycle digest lists day-1 users once.
const { makeApp } = require('./helpers/app');

const ENV = ['LEAD_NOTIFY_TO', 'LEAD_NOTIFY_FROM', 'RESEND_API_KEY', 'MAIL_FROM',
  'OPENPANEL_API_URL', 'OPENPANEL_SERVER_CLIENT_ID', 'OPENPANEL_SERVER_CLIENT_SECRET', 'OPENPANEL_WEB_CLIENT_ID',
  'LIFECYCLE_EMAILS', 'LIFECYCLE_FROM'];
const clearEnv = () => { for (const k of ENV) delete process.env[k]; };
// Operator letters only: password sign-ups also get the email confirmation letter.
const opCalls = (spy) => spy.mock.calls.filter((c) => !/^Confirm your email/.test(c[0].subject || ''));

describe('acquisition + activity', () => {
  let ctx, emailService, sendSpy, db, signupFlow, tracker, fetchSpy;

  beforeAll(async () => {
    clearEnv();
    process.env.RESEND_API_KEY = 'test-resend-key';
    ctx = await makeApp();
    emailService = require('../services/emailService');
    db = require('../db/database');
    signupFlow = require('../services/signupFlow');
    tracker = require('../services/tracker');
    sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ sent: true, id: 'm' });
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
  });
  afterAll(async () => { sendSpy.mockRestore(); fetchSpy.mockRestore(); clearEnv(); await ctx.close(); });
  afterEach(async () => { await require('../services/emailVerify').flush(); sendSpy.mockClear(); fetchSpy.mockClear(); });

  test('register with attribution stores the source and puts it in the email', async () => {
    const r = await ctx.request.post('/api/auth/register').set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari/604.1').send({
      username: 'acq_user1', email: 'acq1@example.com', password: 'password123', fullName: 'Acq One',
      attribution: {
        first: {
          utm_source: 'test', utm_medium: 'cpc', utm_campaign: 'fall',
          referrer: 'https://www.google.com/', landing: 'https://app.finman.money/?utm_source=test',
          first_seen_at: new Date(Date.now() - 5 * 60000).toISOString(),
        },
        anon_id: 'a-test-1', tz: 'America/Toronto', lang: 'en-CA', form_ms: 42000,
      },
    });
    expect(r.status).toBe(200);
    await signupFlow.flush();
    const row = await db.get('SELECT * FROM user_acquisition WHERE user_id = ?', [r.body.user.id]);
    expect(row.method).toBe('password');
    expect(row.source).toBe('utm: test / cpc / fall');
    expect(row.utm_source).toBe('test');
    expect(row.tz).toBe('America/Toronto');
    expect(row.form_ms).toBe(42000);
    expect(row.device).toMatch(/iPhone/);
    expect(row.backfilled).toBe(0);
    const ev = await db.get("SELECT * FROM analytics_events WHERE user_id = ? AND event = 'sign_up'", [r.body.user.id]);
    expect(ev).toBeTruthy();

    expect(opCalls(sendSpy)).toHaveLength(1);
    const mail = opCalls(sendSpy)[0][0];
    expect(mail.text).toMatch(/Where from/);
    expect(mail.text).toMatch(/Source: utm: test \/ cpc \/ fall/);
    expect(mail.text).toMatch(/Form filled in: 42 s/);
    expect(mail.html).toMatch(/Where from/);
  });

  test('without attribution the source is "direct" and the email still has it', async () => {
    const r = await ctx.request.post('/api/auth/register').send({
      username: 'acq_user2', email: 'acq2@example.com', password: 'password123',
    });
    expect(r.status).toBe(200);
    const row = await db.get('SELECT * FROM user_acquisition WHERE user_id = ?', [r.body.user.id]);
    expect(row.source).toBe('direct');
    expect(opCalls(sendSpy)[0][0].text).toMatch(/Source: direct/);
  });

  test('honeypot filled -> no account and no email', async () => {
    const r = await ctx.request.post('/api/auth/register').send({
      username: 'acq_bot', email: 'bot@example.com', password: 'password123', website: 'http://spam.example',
    });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeUndefined();
    const u = await db.get("SELECT id FROM users WHERE username = 'acq_bot'");
    expect(u).toBeUndefined();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('test sign-ups (.test) never reach OpenPanel even when configured', async () => {
    process.env.OPENPANEL_API_URL = 'https://stats.example/api';
    process.env.OPENPANEL_SERVER_CLIENT_ID = 'cid';
    process.env.OPENPANEL_SERVER_CLIENT_SECRET = 'sec';
    try {
      const r = await ctx.request.post('/api/auth/register').send({
        username: 'acq_smoke', email: 'acq-smoke@finman.test', password: 'password123',
      });
      expect(r.status).toBe(200);
      await signupFlow.flush();
      expect(fetchSpy).not.toHaveBeenCalled();

      const r2 = await ctx.request.post('/api/auth/register').send({
        username: 'acq_real', email: 'acq-real@example.com', password: 'password123',
      });
      expect(r2.status).toBe(200);
      await signupFlow.flush();
      const urls = fetchSpy.mock.calls.map((c) => c[0]);
      expect(urls.every((u) => u === 'https://stats.example/api/track')).toBe(true);
      const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body));
      expect(bodies.some((b) => b.type === 'identify' && b.payload.profileId === String(r2.body.user.id))).toBe(true);
      expect(bodies.some((b) => b.type === 'track' && b.payload.name === 'sign_up')).toBe(true);
      expect(fetchSpy.mock.calls[0][1].headers['openpanel-client-secret']).toBe('sec');
    } finally {
      delete process.env.OPENPANEL_API_URL;
      delete process.env.OPENPANEL_SERVER_CLIENT_ID;
      delete process.env.OPENPANEL_SERVER_CLIENT_SECRET;
    }
  });

  test('activity journal records a created transaction without its contents', async () => {
    const acc = await ctx.request.post('/api/accounts').set('Authorization', 'Bearer ' + ctx.token)
      .send({ name: 'Chequing', type: 'checking', balance: 0, currency: 'CAD' });
    expect(acc.status).toBeLessThan(300);
    const accountId = acc.body.id || (acc.body.account && acc.body.account.id) || (acc.body.data && acc.body.data.id);
    const tx = await ctx.request.post('/api/transactions').set('Authorization', 'Bearer ' + ctx.token)
      .send({ account_id: accountId, accountId, amount: 12.5, type: 'expense', description: 'Coffee secret', date: '2026-11-01', category: 'Food' });
    expect(tx.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 50));
    await tracker.flush();
    const rows = await db.query('SELECT event, props FROM analytics_events WHERE user_id = ? ORDER BY id', [ctx.userId]);
    const names = rows.map((r) => r.event);
    expect(names).toContain('account_created');
    expect(names).toContain('transaction_added');
    expect(JSON.stringify(rows)).not.toMatch(/Coffee secret/);
  });

  test('beacon accepts whitelisted events only', async () => {
    await ctx.request.post('/api/t').send({ event: 'register_view', anon_id: 'a-b-1', props: { x: 'y' } }).expect(204);
    await ctx.request.post('/api/t').send({ event: 'transaction_added', anon_id: 'a-b-1' }).expect(204);
    await new Promise((r) => setTimeout(r, 30));
    const rows = await db.query("SELECT event FROM analytics_events WHERE anon_id = 'a-b-1'");
    expect(rows.map((r) => r.event)).toEqual(['register_view']);
  });

  test('config exposes only the web client id', async () => {
    let r = await ctx.request.get('/api/t/config');
    expect(r.body.openpanel).toBeNull();
    process.env.OPENPANEL_API_URL = 'https://stats.example/api';
    process.env.OPENPANEL_WEB_CLIENT_ID = 'web-id';
    process.env.OPENPANEL_SERVER_CLIENT_SECRET = 'sec';
    r = await ctx.request.get('/api/t/config');
    expect(r.body.openpanel).toEqual({ clientId: 'web-id', apiUrl: '/op' });
    expect(JSON.stringify(r.body)).not.toMatch(/sec/);
    delete process.env.OPENPANEL_API_URL; delete process.env.OPENPANEL_WEB_CLIENT_ID; delete process.env.OPENPANEL_SERVER_CLIENT_SECRET;
  });

  test('unsubscribe link sets the opt-out flag; a forged token does not', async () => {
    const { unsubscribeUrl } = require('../services/lifecycle');
    const url = new URL(unsubscribeUrl(ctx.userId));
    await ctx.request.get('/api/t/unsubscribe?u=' + ctx.userId + '&t=' + 'f'.repeat(32)).expect(400);
    await ctx.request.get(url.pathname + url.search).expect(200);
    const u = await db.get('SELECT lifecycle_opt_out FROM users WHERE id = ?', [ctx.userId]);
    expect(u.lifecycle_opt_out).toBe(1);
  });

  test('digest lists a day-1 user once', async () => {
    const lifecycle = require('../services/lifecycle');
    const ins = await db.run("INSERT INTO users (username, email, password, created_at) VALUES ('day1', 'day1@example.com', 'x', datetime('now', '-30 hours'))");
    await db.run("INSERT INTO user_acquisition (user_id, method, source) VALUES (?, 'google', 'chatgpt.com (AI)')", [ins.id]);
    const r1 = await lifecycle.runDigest();
    expect(r1.users).toBeGreaterThanOrEqual(1);
    const mail = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0];
    expect(mail.text).toMatch(/day1@example.com · google · chatgpt.com \(AI\)/);
    sendSpy.mockClear();
    const r2 = await lifecycle.runDigest();
    expect(r2.users).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('nudges stay off without LIFECYCLE_EMAILS=1', async () => {
    const lifecycle = require('../services/lifecycle');
    expect(await lifecycle.runNudges()).toEqual({ skipped: true });
  });
});

describe('source labels', () => {
  const { sourceLabel, normalizeAttribution } = require('../services/tracker');
  const L = (first) => sourceLabel(normalizeAttribution({ first }));
  test.each([
    [{ gclid: 'x' }, 'Google Ads'],
    [{ fbclid: 'x' }, 'Facebook/Instagram'],
    [{ utm_source: 'newsletter' }, 'utm: newsletter'],
    [{ referrer: 'https://www.google.ca/' }, 'google organic'],
    [{ referrer: 'https://chatgpt.com/' }, 'chatgpt.com (AI)'],
    [{ referrer: 'https://finman.money/budget-app-canada', site_referrer: 'https://www.bing.com/' }, 'finman.money ← bing organic'],
    [{ referrer: 'https://finman.money/' }, 'finman.money (direct)'],
    [{ site_landing: 'https://finman.money/x', site_referrer: 'https://chatgpt.com/' }, 'finman.money ← chatgpt.com (AI)'],
    [{ utm_source: 'finman.money', utm_medium: 'site', utm_campaign: 'sticky', site_referrer: 'https://chatgpt.com/' }, 'finman.money ← chatgpt.com (AI) · cta sticky'],
    [{ utm_source: 'finman.money', utm_medium: 'site', utm_campaign: 'home' }, 'finman.money (direct) · cta home'],
    [{}, 'direct'],
  ])('%j -> %s', (first, label) => { expect(L(first)).toBe(label); });

  test('junk input is dropped', () => {
    const a = normalizeAttribution('{"first":{"utm_source":"a","evil":"x"},"form_ms":-5}');
    expect(a.first).toEqual({ utm_source: 'a' });
    expect(a.form_ms).toBeNull();
    expect(normalizeAttribution('not json').first).toEqual({});
  });
});
