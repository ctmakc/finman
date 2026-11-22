// test/growth-metrics.test.js — services/growthMetrics.js (aggregates only) and its outlets:
//   - compute(): path steps, activation, week-1 / week-4 returns by events, test/team left out,
//     server-sent emails (weekly_note_sent, email_sent) are not a return;
//   - runWeekly(): Mondays only, once a week, no emails of users in the text;
//   - GET /api/feedback/admin/metrics: team only (404 for others).
process.env.ADMIN_EMAILS = 'boss@finman-team.example';
const jwt = require('jsonwebtoken');
const { makeApp } = require('./helpers/app');
const gm = require('../services/growthMetrics');

const NOW = '2026-12-14T15:00:00.000Z';
const ev = (user_id, event, created_at, props) => ({ user_id, event, created_at, props: props ? JSON.stringify(props) : null });

describe('compute()', () => {
  const users = [
    { id: 1, email: 'a@example.com', created_at: '2026-11-03 10:00:00', utm_source: 'chatgpt.com' },
    { id: 2, email: 'b@example.com', created_at: '2026-11-04 10:00:00', referrer: 'https://www.google.com/' },
    { id: 3, email: 'c@example.com', created_at: '2026-12-10 10:00:00' },
    { id: 4, email: 'qa@finman.test', created_at: '2026-11-05 10:00:00' },
    { id: 5, email: 'boss@finman-team.example', created_at: '2026-11-05 10:00:00' },
  ];
  const events = [
    ev(1, 'vault_key_saved', '2026-11-03 10:01:00'), ev(1, 'onboarding_firstrun_shown', '2026-11-03 10:02:00'),
    ev(1, 'statement_read', '2026-11-03 10:03:00'), ev(1, 'account_created', '2026-11-03 10:04:00'),
    ev(1, 'import_done', '2026-11-03 10:05:00'), ev(1, 'onboarding_insight_shown', '2026-11-03 10:06:00'),
    ev(1, 'app_open', '2026-11-06 09:00:00'), ev(1, 'app_open', '2026-11-27 09:00:00'),
    ev(2, 'onboarding_firstrun_shown', '2026-11-04 10:02:00'), ev(2, 'import_failed', '2026-11-04 10:03:00', { code: 'FILE_PDF' }),
    ev(2, 'weekly_note_sent', '2026-11-09 13:00:00'), ev(2, 'email_sent', '2026-11-05 13:00:00'),
    ev(3, 'app_open', '2026-12-10 10:00:00'),
    ev(4, 'app_open', '2026-11-08 10:00:00'),
  ];
  const m = gm.compute({ users, events, admins: ['boss@finman-team.example'], now: NOW, since: '2026-11-03' });

  test('test and team accounts are left out', () => {
    expect(m.users_alive).toBe(3);
    expect(m.excluded).toEqual({ test: 1, team: 1 });
  });
  test('path steps', () => {
    expect(m.funnel).toMatchObject({ signed_up: 3, vault_ready: 1, first_screen: 2, picked_a_path: 2, first_account: 1, own_data_in: 1, first_report: 1 });
    expect(m.import_failed_codes).toEqual({ FILE_PDF: 1 });
    expect(m.statements_read).toBe(1);
  });
  test('returns: own visits count, emails we sent do not, too-young users are not eligible', () => {
    expect(m.week1).toEqual({ eligible: 2, returned: 1 });
    expect(m.week4).toEqual({ eligible: 2, returned: 1 });
    expect(m.by_week['2026-12-07']).toMatchObject({ signups: 1, week1_eligible: 0 });
  });
  test('describe() has no email addresses', () => {
    expect(gm.describe(m).join('\n')).not.toMatch(/@/);
  });
});

describe('runWeekly() and the team page', () => {
  let ctx, db, emailService, sent, boss, alice;
  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    const config = require('../config/config');
    emailService = require('../services/emailService');
    sent = [];
    jest.spyOn(emailService, 'sendEmail').mockImplementation(async (m) => { sent.push(m); return { sent: true }; });
    const mk = async (name, email) => {
      const r = await db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [name, email, 'x']);
      return { id: r.id, token: jwt.sign({ id: r.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
    };
    boss = await mk('boss', 'boss@finman-team.example');
    alice = await mk('alice', 'alice@example.com');
  });
  afterAll(async () => { jest.restoreAllMocks(); await ctx.close(); });

  test('only on Mondays, once a week, aggregates only', async () => {
    expect(await gm.runWeekly({ now: new Date('2026-11-24T14:00:00Z') })).toEqual({ skipped: 'not monday' });
    const r = await gm.runWeekly({ now: new Date('2026-11-23T14:00:00Z') });
    expect(r.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^Finman week 2026-11-23:/);
    expect(sent[0].text).not.toMatch(/alice@example\.com/);
    expect(await gm.runWeekly({ now: new Date('2026-11-23T18:00:00Z') })).toEqual({ skipped: 'already sent' });
  });

  test('GET /api/feedback/admin/metrics is for the team only', async () => {
    const no = await ctx.request.get('/api/feedback/admin/metrics').set('Authorization', 'Bearer ' + alice.token);
    expect(no.status).toBe(404);
    const ok = await ctx.request.get('/api/feedback/admin/metrics').set('Authorization', 'Bearer ' + boss.token);
    expect(ok.status).toBe(200);
    expect(ok.body.metrics.funnel).toHaveProperty('signed_up');
    expect(ok.body.lines.join('\n')).not.toMatch(/@/);
  });
});
