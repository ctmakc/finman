// test/feedback-day3.test.js — the day-3 survey and the owner's daily digest (1123).
//   - POST /api/feedback accepts trigger day3 (score 1–5 + "what gets in the way"), once per person;
//   - lifecycle.journey: steps from the event journal, back on day 2 / week 1, where it stopped;
//   - runDigest: "What new users did" line, per-user path, new feedback once (cursor), test feedback left out;
//   - feedback alone (no day-1/day-7 users) still sends the digest.
process.env.ADMIN_EMAILS = 'boss@finman-team.example';
const jwt = require('jsonwebtoken');
const { makeApp } = require('./helpers/app');

let ctx, db, config, emailService, sendSpy, lifecycle;

async function mkUser(name, email, hoursAgo) {
  const r = await db.run(
    `INSERT INTO users (username, email, password, created_at) VALUES (?, ?, 'x', datetime('now', ?))`,
    [name, email || `${name}@example.com`, `-${hoursAgo || 0} hours`]);
  return { id: r.id, token: jwt.sign({ id: r.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
}
const ev = (uid, event, hoursAgo) => db.run(
  `INSERT INTO analytics_events (user_id, event, props, created_at) VALUES (?, ?, '{}', datetime('now', ?))`, [uid, event, `-${hoursAgo} hours`]);

beforeAll(async () => {
  process.env.RESEND_API_KEY = 'test-resend-key';
  ctx = await makeApp();
  db = require('../db/database');
  config = require('../config/config');
  emailService = require('../services/emailService');
  lifecycle = require('../services/lifecycle');
  sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ sent: true, id: 'm' });
});
afterAll(async () => { sendSpy.mockRestore(); delete process.env.RESEND_API_KEY; await ctx.close(); });
afterEach(() => sendSpy.mockClear());

test('day3 survey: score + text stored once per person', async () => {
  const u = await mkUser('d3user', 'd3user@example.com', 80);
  const body = { kind: 'survey', trigger: 'day3', rating: 4, comment: 'Need my bank to sync on its own' };
  const r1 = await ctx.request.post('/api/feedback').set('Authorization', 'Bearer ' + u.token).send(body);
  expect(r1.status).toBe(201);
  const r2 = await ctx.request.post('/api/feedback').set('Authorization', 'Bearer ' + u.token).send(body);
  expect(r2.body.duplicate).toBe(true);
  const rows = await db.query('SELECT * FROM feedback WHERE user_id = ? AND trigger = ?', [u.id, 'day3']);
  expect(rows).toHaveLength(1);
  expect(rows[0].rating).toBe(4);
  const mine = await ctx.request.get('/api/feedback/mine?trigger=day3').set('Authorization', 'Bearer ' + u.token);
  expect(mine.body.answered).toBe(true);
});

test('journey: steps, returns and where it stopped (events only)', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const j = lifecycle.journey([
    { event: 'sign_up', created_at: '2026-11-10 10:00:00' },
    { event: 'onboarding_firstrun_shown', created_at: '2026-11-10 10:01:00' },
    { event: 'onboarding_bank_picked', created_at: '2026-11-10 10:02:00' },
    { event: 'app_open', created_at: '2026-11-11 09:00:00' },
    { event: 'weekly_email_sent', created_at: '2026-11-16 13:00:00' },
  ], '2026-11-10 10:00:00', now);
  expect(j.steps).toEqual(['first_screen', 'picked_a_path']);
  expect(j.stoppedAt).toBe('picked_a_path');
  expect(j.back2).toBe(true);
  expect(j.back7).toBe(true);
  expect(j.activeDays).toBe(2);
  expect(j.lastEvent).toBe('app_open'); // emails we send are not the person's activity
  const fresh = lifecycle.journey([], '2026-11-20 08:00:00', now);
  expect(fresh.back2).toBeNull();
  expect(lifecycle.journeyText(fresh)).toMatch(/only signed up/);
});

test('digest: "what new users did", per-user path, feedback once; tests left out', async () => {
  const a = await mkUser('digesta', 'digesta@example.com', 30);
  await db.run("INSERT INTO user_acquisition (user_id, method, source) VALUES (?, 'google', 'chatgpt.com (AI)')", [a.id]);
  await ev(a.id, 'onboarding_firstrun_shown', 29);
  await ev(a.id, 'onboarding_bank_picked', 29);
  const t = await mkUser('digestt', 'qa+smoke@finman-smoke.test', 30);
  await db.run(`INSERT INTO feedback (user_id, kind, trigger, rating, comment, is_test) VALUES (?, 'survey', 'day3', 2, 'hidden test', 1)`, [t.id]);
  const r = await lifecycle.runDigest();
  expect(r.sent).toBe(true);
  const mail = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0];
  expect(mail.text).toMatch(/What new users did \(last 7 days/);
  expect(mail.text).toMatch(/digesta@example.com/);
  expect(mail.text).toMatch(/did: saw the first screen → picked a way in/);
  expect(mail.text).toMatch(/Need my bank to sync on its own/); // day3 answer from the first test
  expect(mail.text).toMatch(/survey\/day3 · 4\/5/);
  expect(mail.text).not.toMatch(/hidden test/);
  expect(mail.text).not.toMatch(/finman-smoke\.test/);
  expect(mail.html).toMatch(/What new users did/);
  // Next run: nobody due and no new feedback → nothing sent.
  sendSpy.mockClear();
  const r2 = await lifecycle.runDigest();
  expect(r2.sent).toBe(false);
  expect(sendSpy).not.toHaveBeenCalled();
});

test('digest goes out for new feedback alone', async () => {
  const u = await mkUser('fbonly', 'fbonly@example.com', 24 * 20);
  await db.run(`INSERT INTO feedback (user_id, kind, trigger, rating, comment) VALUES (?, 'rating', 'menu', 5, 'Love the money map')`, [u.id]);
  const r = await lifecycle.runDigest();
  expect(r.sent).toBe(true);
  expect(r.feedback).toBe(1);
  const mail = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0];
  expect(mail.subject).toMatch(/feedback 1/);
  expect(mail.text).toMatch(/Love the money map/);
});
