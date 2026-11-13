// test/engagement.test.js — the habit loop (12.11):
//   journey checklist + milestones + streak, week/month recap, AI CFO tips,
//   the recap email (unsubscribe, opt-out, test accounts, once per period),
//   invite links (fm_ref=invite-<code>), push subscription API, client events.
const { makeApp } = require('./helpers/app');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });
// Thursday 12 Nov 2026, noon in Toronto.
const NOW = new Date('2026-11-12T17:00:00Z');

describe('journey helpers (pure)', () => {
  const journey = require('../services/journey');

  test('weekStart returns Monday', () => {
    expect(journey.weekStart('2026-11-12')).toBe('2026-11-09');
    expect(journey.weekStart('2026-11-09')).toBe('2026-11-09');
    expect(journey.weekStart('2026-11-15')).toBe('2026-11-09');
    expect(journey.weekStart('2026-11-01')).toBe('2026-10-26');
  });

  test('streak counts weeks in a row; an empty current week keeps last week alive', () => {
    const s = journey.streakFrom(['2026-10-20', '2026-10-28', '2026-11-03', '2026-11-04'], '2026-11-12');
    expect(s.current).toBe(3);
    expect(s.activeThisWeek).toBe(false);
    expect(s.thisWeek).toEqual([false, false, false, false, false, false, false]);
    const s2 = journey.streakFrom(['2026-10-20', '2026-11-03', '2026-11-10'], '2026-11-12');
    expect(s2.current).toBe(2);
    expect(s2.thisWeek[1]).toBe(true);
    expect(s2.best).toBe(2);
    expect(journey.streakFrom([], '2026-11-12').current).toBe(0);
  });

  test('recap periods: last full week and last month', () => {
    const { periodFor } = require('../services/moneyRecap');
    expect(periodFor('week', '2026-11-12')).toMatchObject({ start: '2026-11-02', end: '2026-11-08', label: 'Nov 2–8', key: '2026-11-02' });
    expect(periodFor('week', '2026-11-02')).toMatchObject({ start: '2026-10-26', end: '2026-11-01', label: 'Oct 26 – Nov 1' });
    expect(periodFor('month', '2026-11-12')).toMatchObject({ start: '2026-10-01', end: '2026-10-31', label: 'October 2026', key: '2026-10' });
    expect(periodFor('month', '2026-01-02')).toMatchObject({ start: '2025-12-01', end: '2025-12-31' });
  });

  test('push subscription validation', () => {
    const { validSub } = require('../services/push');
    expect(validSub({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } })).toBe(true);
    expect(validSub({ endpoint: 'http://evil/x', keys: { p256dh: 'a', auth: 'b' } })).toBe(false);
    expect(validSub({ endpoint: 'https://x' })).toBeFalsy();
  });
});

describe('engagement funnel (app)', () => {
  let ctx, db, emailService, sendSpy, accountId;

  async function addTx(date, description, amount, type, category, acc = accountId) {
    return db.run(
      'INSERT INTO transactions (account_id, user_id, date, description, amount, type, category) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [acc, ctx.userId, date, description, amount, type, category],
    );
  }

  beforeAll(async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    process.env.RESEND_API_KEY = 'test-resend-key';
    ctx = await makeApp();
    db = require('../db/database');
    emailService = require('../services/emailService');
    sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ sent: true, id: 'm' });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    // Tracked sign-up (backfilled = 0) so milestones are real events.
    await db.run("INSERT INTO user_acquisition (user_id, method, source, backfilled) VALUES (?, 'password', 'direct', 0)", [ctx.userId]);
    await db.run("UPDATE users SET created_at = '2026-09-01 12:00:00' WHERE id = ?", [ctx.userId]);
  });
  afterAll(async () => { jest.restoreAllMocks(); delete process.env.ENGAGEMENT_EMAILS; delete process.env.LIFECYCLE_FROM; await ctx.close(); });
  afterEach(() => sendSpy.mockClear());

  test('fresh user: nothing done, next step is the first statement', async () => {
    const r = await ctx.request.get('/api/engagement/journey').set(AUTH(ctx.token));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ doneCount: 0, total: 5, next: 'first_insight', complete: false });
    expect(r.body.data.push).toEqual({ available: false, devices: 0 });
    expect(r.body.data.referral.link).toMatch(/fm_ref=invite-[a-z0-9]{8}&utm_source=invite/);
    expect(r.body.data.tips).toEqual([]);
  });

  test('demo data does not count as activation', async () => {
    const demo = await db.run("INSERT INTO accounts (user_id, name, currency, balance, is_demo) VALUES (?, 'Demo', 'CAD', 0, 1)", [ctx.userId]);
    await addTx('2026-11-03', 'DEMO COFFEE', -5, 'expense', 'Dining', demo.id);
    const j = await require('../services/journey').compute(ctx.userId, { now: NOW });
    expect(j.steps[0].done).toBe(false);
    await db.run('DELETE FROM transactions WHERE account_id = ?', [demo.id]);
    await db.run('DELETE FROM accounts WHERE id = ?', [demo.id]);
  });

  test('own data: activated + step milestones once, with events', async () => {
    const acc = await db.run("INSERT INTO accounts (user_id, name, currency, balance) VALUES (?, 'Chequing', 'CAD', 1000)", [ctx.userId]);
    accountId = acc.id;
    // Three past months of groceries ~400, this month running hot.
    for (const m of ['08', '09', '10']) {
      await addTx(`2026-${m}-01`, 'PAYROLL ACME', 4000, 'income', 'Salary');
      await addTx(`2026-${m}-05`, 'LOBLAWS', -200, 'expense', 'Groceries');
      await addTx(`2026-${m}-18`, 'METRO', -200, 'expense', 'Groceries');
      await addTx(`2026-${m}-10`, 'NETFLIX.COM', -16.99, 'expense', 'Subscriptions');
      await addTx(`2026-${m}-12`, 'SPOTIFY P0B2', -11.99, 'expense', 'Subscriptions');
      await addTx(`2026-${m}-20`, 'MONTHLY PLAN FEE', -16.95, 'expense', 'Bank Fees');
    }
    await addTx('2026-11-01', 'PAYROLL ACME', 4000, 'income', 'Salary');
    await addTx('2026-11-03', 'LOBLAWS', -320, 'expense', 'Groceries');
    await addTx('2026-11-06', 'COSTCO', -260, 'expense', 'Groceries');
    await addTx('2026-11-04', 'UBER EATS', -45, 'expense', 'Dining');
    await addTx('2026-10-27', 'LOBLAWS', -150, 'expense', 'Groceries');

    const journey = require('../services/journey');
    const j = await journey.compute(ctx.userId, { now: NOW });
    expect(j.steps.find((s) => s.key === 'first_insight').done).toBe(true);
    expect(j.next).toBe('second_source');
    expect(j.fresh).toEqual(expect.arrayContaining(['activated', 'step_first_insight']));
    const again = await journey.compute(ctx.userId, { now: NOW });
    expect(again.fresh).toEqual([]);
    const ev = await db.query("SELECT event, props FROM analytics_events WHERE user_id = ? AND event IN ('activated', 'journey_step_done')", [ctx.userId]);
    expect(ev.map((e) => e.event).sort()).toEqual(['activated', 'journey_step_done']);
    expect(JSON.parse(ev.find((e) => e.event === 'journey_step_done').props)).toMatchObject({ step: 'first_insight' });
  });

  test('week recap: own money for Nov 2–8 against the week before', async () => {
    const r = await require('../services/moneyRecap').recap(ctx.userId, { kind: 'week', now: NOW });
    expect(r.period.label).toBe('Nov 2–8');
    expect(r.expense).toBe(625);
    expect(r.income).toBe(0);
    expect(r.prev.expense).toBe(150);
    expect(r.expenseDelta).toBe(317);
    expect(r.topCategories[0]).toMatchObject({ category: 'Groceries', amount: 580 });
    const m = await require('../services/moneyRecap').recap(ctx.userId, { kind: 'month', now: NOW });
    expect(m.period.label).toBe('October 2026');
    expect(m.income).toBe(4000);
    expect(m.savingsRate).toBeGreaterThan(80);
  });

  test('AI CFO tips name real amounts', async () => {
    const tips = await require('../services/cfoTips').tips(ctx.userId, { now: NOW });
    const ids = tips.map((t) => t.id);
    expect(ids).toContain('pace:Groceries');
    expect(ids).toContain('fees');
    expect(ids).toContain('first-budget');
    const pace = tips.find((t) => t.id === 'pace:Groceries');
    expect(pace.body).toMatch(/\$580 so far this month/);
    expect(pace.action.page).toBe('transactions');
    expect(require('../services/cfoTips').toContext(tips)).toMatch(/Groceries is running ahead/);
  });

  test('AI CFO leaves rent out of pace and subscription tips', async () => {
    const ids = [];
    for (const d of ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']) {
      ids.push((await addTx(d, 'RENT MAPLE PROPERTY', -1900, 'expense', 'Housing')).id);
    }
    const tips = await require('../services/cfoTips').tips(ctx.userId, { now: NOW });
    expect(tips.map((t) => t.id)).not.toContain('pace:Housing');
    const rec = tips.find((t) => t.id === 'recurring');
    if (rec) expect(rec.body).not.toMatch(/RENT/);
    for (const id of ids) await db.run('DELETE FROM transactions WHERE id = ?', [id]);
  });

  test('budget and goal complete their steps', async () => {
    await db.run("INSERT INTO budgets (user_id, name, category, amount, period, start_date, is_active) VALUES (?, 'Groceries', 'Groceries', 400, 'monthly', '2026-11-01', 1)", [ctx.userId]);
    await db.run("INSERT INTO savings_goals (user_id, name, target_amount, current_amount, target_date, is_active) VALUES (?, 'Trip', 3000, 500, '2027-06-01', 1)", [ctx.userId]);
    const j = await require('../services/journey').compute(ctx.userId, { now: NOW });
    expect(j.steps.filter((s) => s.done).map((s) => s.key)).toEqual(['first_insight', 'budget', 'goal']);
    const tips = await require('../services/cfoTips').tips(ctx.userId, { now: NOW });
    expect(tips.map((t) => t.id)).toContain('budget:Groceries');
  });

  test('GET /recap opens the weekly review step; GET /email-preview renders HTML', async () => {
    const r = await ctx.request.get('/api/engagement/recap?kind=week&source=email').set(AUTH(ctx.token));
    expect(r.status).toBe(200);
    expect(r.body.data.period.end).toBeDefined();
    const ms = await db.query("SELECT key, props FROM user_milestones WHERE user_id = ? AND key LIKE 'weekly_review:%'", [ctx.userId]);
    expect(ms).toHaveLength(1);
    expect(JSON.parse(ms[0].props).source).toBe('email');
    const p = await ctx.request.get('/api/engagement/email-preview?kind=month').set(AUTH(ctx.token));
    expect(p.status).toBe(200);
    expect(p.headers['content-type']).toMatch(/html/);
    expect(p.text).toMatch(/Unsubscribe/);
  });

  test('POST /event accepts only whitelisted events', async () => {
    const bad = await ctx.request.post('/api/engagement/event').set(AUTH(ctx.token)).send({ event: 'sign_up' });
    expect(bad.status).toBe(400);
    const good = await ctx.request.post('/api/engagement/event').set(AUTH(ctx.token))
      .send({ event: 'checklist_step_click', props: { step: 'budget', Evil: 'x', nested: { a: 1 } } });
    expect(good.status).toBe(200);
    const ev = await db.get("SELECT props FROM analytics_events WHERE user_id = ? AND event = 'checklist_step_click'", [ctx.userId]);
    expect(JSON.parse(ev.props)).toEqual({ step: 'budget' });
    // The engagement API itself is not journaled as "engagement_created".
    const j = await db.get("SELECT COUNT(*) AS n FROM analytics_events WHERE event LIKE 'engagement_%'");
    expect(j.n).toBe(0);
  });

  test('push API: off without VAPID keys', async () => {
    const k = await ctx.request.get('/api/engagement/push/key').set(AUTH(ctx.token));
    expect(k.body.data.key).toBeNull();
    const s = await ctx.request.post('/api/engagement/push/subscribe').set(AUTH(ctx.token))
      .send({ subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } } });
    expect(s.status).toBe(503);
    const anon = await ctx.request.get('/api/engagement/journey');
    expect(anon.status).toBe(401);
  });

  test('weekly email: once per week, with unsubscribe headers; off without the flag', async () => {
    const mail = require('../services/engagementMail');
    process.env.LIFECYCLE_FROM = 'Finman <hello@finman.money>';
    delete process.env.ENGAGEMENT_EMAILS;
    const off = await mail.runRecap('week', { now: NOW });
    expect(off.emailed).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();

    process.env.ENGAGEMENT_EMAILS = '1';
    const r = await mail.runRecap('week', { now: NOW });
    expect(r).toMatchObject({ kind: 'week:2026-11-02', emailed: 1 });
    const m = sendSpy.mock.calls[0][0];
    expect(m.to).toEqual(['test@example.com']);
    expect(m.subject).toMatch(/^Your week in money: \$625 spent/);
    expect(m.headers['List-Unsubscribe']).toMatch(/\/api\/t\/unsubscribe\?u=\d+&t=[a-f0-9]{32}/);
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.html).toMatch(/Groceries is running ahead|Groceries: \d+% used/);
    expect(m.text).toMatch(/Stop these emails:/);
    expect(m.html).not.toMatch(/DEMO/);

    sendSpy.mockClear();
    const again = await mail.runRecap('week', { now: NOW });
    expect(again.emailed).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
    const ev = await db.get("SELECT COUNT(*) AS n FROM analytics_events WHERE event = 'weekly_email_sent'");
    expect(ev.n).toBe(1);
  });

  test('monthly email skips opted-out, settings-off and .test users', async () => {
    const mail = require('../services/engagementMail');
    process.env.ENGAGEMENT_EMAILS = '1';
    process.env.LIFECYCLE_FROM = 'Finman <hello@finman.money>';
    const t = await db.run("INSERT INTO users (username, email, password) VALUES ('qa1', 'qa1@finman.test', 'x')");
    const a = await db.run("INSERT INTO accounts (user_id, name, currency, balance) VALUES (?, 'A', 'CAD', 0)", [t.id]);
    await db.run("INSERT INTO transactions (account_id, user_id, date, description, amount, type, category) VALUES (?, ?, '2026-10-03', 'X', -10, 'expense', 'Dining')", [a.id, t.id]);

    // Unsubscribe by one-click POST, then check nothing goes out.
    const { unsubToken } = require('../routes/track');
    const u = await ctx.request.post(`/api/t/unsubscribe?u=${ctx.userId}&t=${unsubToken(ctx.userId)}`).send('List-Unsubscribe=One-Click');
    expect(u.status).toBe(200);
    const r = await mail.runRecap('month', { now: NOW });
    expect(r.emailed).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();

    await db.run('UPDATE users SET lifecycle_opt_out = 0 WHERE id = ?', [ctx.userId]);
    await db.run('INSERT INTO notification_settings (user_id, weekly_summary) VALUES (?, 0)', [ctx.userId]);
    const r2 = await mail.runRecap('month', { now: NOW });
    expect(r2.emailed).toBe(0);
    await db.run('DELETE FROM notification_settings WHERE user_id = ?', [ctx.userId]);

    const r3 = await mail.runRecap('month', { now: NOW });
    expect(r3).toMatchObject({ kind: 'month:2026-10', emailed: 1 });
    expect(sendSpy.mock.calls[0][0].subject).toMatch(/^Your October 2026 in money/);
  });

  test('invite link: the friend is attached to the inviter, both get events, inviter gets a badge', async () => {
    const ref = await ctx.request.get('/api/engagement/referral').set(AUTH(ctx.token));
    const code = ref.body.data.code;
    expect(code).toMatch(/^[a-z0-9]{8}$/);
    const r = await ctx.request.post('/api/auth/register').send({
      email: 'friend1@example.com', password: 'password123',
      attribution: { first: { site_referrer: `invite-${code}`, utm_source: 'invite', utm_medium: 'referral' }, anon_id: 'a-friend-1' },
    });
    expect(r.status).toBe(200);
    await require('../services/signupFlow').flush();
    const friend = await db.get('SELECT referred_by FROM users WHERE id = ?', [r.body.user.id]);
    expect(friend.referred_by).toBe(ctx.userId);
    const ev = await db.query("SELECT event, user_id FROM analytics_events WHERE event IN ('referral_signup', 'friend_joined')");
    expect(ev).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'referral_signup', user_id: r.body.user.id }),
      expect.objectContaining({ event: 'friend_joined', user_id: ctx.userId }),
    ]));
    const badge = await db.get("SELECT 1 AS x FROM user_milestones WHERE user_id = ? AND key = 'badge_friend'", [ctx.userId]);
    expect(badge).toBeTruthy();
    const stats = await ctx.request.get('/api/engagement/referral').set(AUTH(ctx.token));
    expect(stats.body.data).toMatchObject({ code, joined: 1, activated: 0 });
  });

  test('a self-invite or unknown code attaches nothing', async () => {
    const referral = require('../services/referral');
    expect(referral.codeFromAcquisition({ site_referrer: 'finman.money/blog' })).toBeNull();
    expect(referral.codeFromAcquisition({ site_referrer: 'x', last_touch: JSON.stringify({ site_referrer: 'invite-abcdefgh' }) })).toBe('abcdefgh');
    const code = await referral.codeFor(ctx.userId);
    expect(await referral.attach({ id: ctx.userId, email: 'test@example.com' }, { site_referrer: `invite-${code}` })).toBeNull();
    expect(await referral.attach({ id: ctx.userId, email: 'test@example.com' }, { site_referrer: 'invite-zzzzzzzz' })).toBeNull();
  });
});
