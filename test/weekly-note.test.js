// test/weekly-note.test.js — the Monday "Your week in money is ready" reminder for Finman
// Vault users (services/weeklyNote.js) and Settings -> Emails (/api/auth/email-prefs).
//
//   - only vault users who put data in once and did not open Finman for 6 days;
//   - never test accounts, unsubscribed users or users who switched the weekly email off;
//   - once a week; after 3 reminders with no visit, no more until the person comes back;
//   - the email carries no amounts, has a one-click unsubscribe and a settings link;
//   - the weekly switch also stops the numbers recap for open-data users.
process.env.ENGAGEMENT_EMAILS = '1';
process.env.LIFECYCLE_FROM = 'Finman <hello@finman.money>';
const jwt = require('jsonwebtoken');
const { makeApp } = require('./helpers/app');

let ctx, db, config, emailService, note, sent;

async function mkUser(email, { vault = true, activated = true, lastVisitDaysAgo = 10 } = {}) {
  const r = await db.run('INSERT INTO users (username, email, password, full_name, vault_state) VALUES (?, ?, ?, ?, ?)',
    [email.split('@')[0], email, 'x', 'Ann Lee', vault ? 'active' : 'none']);
  const id = r.id;
  if (activated) await db.run("INSERT INTO analytics_events (user_id, event, created_at) VALUES (?, 'import_done', datetime('now', '-20 days'))", [id]);
  if (lastVisitDaysAgo != null) await db.run(`INSERT INTO analytics_events (user_id, event, created_at) VALUES (?, 'app_open', datetime('now', '-${lastVisitDaysAgo} days'))`, [id]);
  return { id, token: jwt.sign({ id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
}
const MONDAY = new Date('2026-11-23T14:00:00Z');

beforeAll(async () => {
  ctx = await makeApp();
  db = require('../db/database');
  config = require('../config/config');
  emailService = require('../services/emailService');
  note = require('../services/weeklyNote');
  sent = [];
  jest.spyOn(emailService, 'sendEmail').mockImplementation(async (m) => { sent.push(m); return { sent: true }; });
});
afterAll(async () => { jest.restoreAllMocks(); await ctx.close(); });
beforeEach(() => { sent.length = 0; });

describe('who gets the reminder', () => {
  let away, back, fresh, open, testAcc, unsub, off;
  beforeAll(async () => {
    away = await mkUser('away@example.com');
    back = await mkUser('back@example.com', { lastVisitDaysAgo: 2 });
    fresh = await mkUser('fresh@example.com', { activated: false });
    open = await mkUser('open@example.com', { vault: false });
    testAcc = await mkUser('qa@finman.test');
    unsub = await mkUser('unsub@example.com');
    await db.run('UPDATE users SET lifecycle_opt_out = 1 WHERE id = ?', [unsub.id]);
    off = await mkUser('off@example.com');
    await db.run('UPDATE users SET weekly_note_opt_out = 1 WHERE id = ?', [off.id]);
  });

  test('only an activated vault user who stayed away gets one, once a week', async () => {
    const r = await note.run({ now: MONDAY });
    expect(sent.map((m) => m.to[0])).toEqual(['away@example.com']);
    expect(r.emailed).toBe(1);
    const again = await note.run({ now: MONDAY });
    expect(again.emailed).toBe(0);
  });

  test('the email has no amounts, links to the Week page, settings and one-click unsubscribe', async () => {
    const u = { full_name: 'Ann Lee' };
    const m = note.render(u, note.lastWeek('2026-11-23'), 'https://app.finman.money/api/t/unsubscribe?u=1&t=x');
    expect(m.subject).toBe('Your week in money is ready (Nov 16–22)');
    expect(m.text).not.toMatch(/\$\s?\d/);
    expect(m.html).not.toMatch(/\$\s?\d/);
    expect(m.html).toContain('/week?fm_src=email');
    expect(m.html).toContain('/settings?fm_src=email#emails');
    expect(m.text).toContain('/api/t/unsubscribe');
  });

  test('after 3 reminders with no visit it stops; a visit starts it again', async () => {
    const quiet = await mkUser('quiet@example.com');
    for (const k of ['2026-10-26', '2026-11-02', '2026-11-09']) {
      await db.run("INSERT INTO lifecycle_emails (user_id, kind, sent_at) VALUES (?, ?, datetime('now', '-3 days'))", [quiet.id, 'weeknote:' + k]);
    }
    await note.run({ now: new Date('2026-11-30T14:00:00Z') });
    expect(sent.map((m) => m.to[0])).not.toContain('quiet@example.com');
    expect(await note.unanswered(quiet.id)).toBe(3);
    await db.run("INSERT INTO analytics_events (user_id, event, created_at) VALUES (?, 'app_open', datetime('now', '-1 day'))", [quiet.id]);
    expect(await note.unanswered(quiet.id)).toBe(0);
  });
});

describe('Settings -> Emails', () => {
  let u;
  beforeAll(async () => { u = await mkUser('prefs@example.com'); });
  const auth = (r) => r.set('Authorization', 'Bearer ' + u.token);

  test('both on by default; switching weekly off is stored on the server', async () => {
    const g = await auth(ctx.request.get('/api/auth/email-prefs'));
    expect(g.body).toEqual({ weekly: true, tips: true });
    const p = await auth(ctx.request.put('/api/auth/email-prefs')).send({ weekly: false });
    expect(p.body).toEqual({ weekly: false, tips: true });
    const row = await db.get('SELECT weekly_note_opt_out AS w FROM users WHERE id = ?', [u.id]);
    expect(row.w).toBe(1);
    const r = await note.run({ now: new Date('2026-12-07T14:00:00Z') });
    expect(sent.map((m) => m.to[0])).not.toContain('prefs@example.com');
    expect(r).toBeTruthy();
  });

  test('tips switch maps to the one-click unsubscribe flag; nothing to change is 400', async () => {
    const p = await auth(ctx.request.put('/api/auth/email-prefs')).send({ tips: false });
    expect(p.body.tips).toBe(false);
    expect((await db.get('SELECT lifecycle_opt_out AS l FROM users WHERE id = ?', [u.id])).l).toBe(1);
    expect((await auth(ctx.request.put('/api/auth/email-prefs')).send({ weekly: 'no' })).status).toBe(400);
  });

  test('needs a sign-in', async () => {
    expect((await ctx.request.get('/api/auth/email-prefs')).status).toBe(401);
  });

  test('the numbers recap skips open-data users with the weekly email off', async () => {
    const { candidates } = require('../services/engagementMail');
    const ids = (await candidates()).map((c) => c.id);
    expect(ids).not.toContain(u.id);
  });
});
