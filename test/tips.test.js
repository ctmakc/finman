// test/tips.test.js — the new users' tips: windows, one per run, 2-day gap, skip what is done,
// opt-out, test accounts, language, unsubscribe link, no money figures, owner's tone rules.
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => { db.run(sql, params, function (err) { if (err) reject(err); else resolve({ id: this.lastID }); }); });
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => { db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))); });
}

describe('tips for new users', () => {
  let ctx; let sent;
  beforeEach(async () => {
    ctx = await makeApp();
    process.env.LIFECYCLE_EMAILS = '1';
    process.env.LIFECYCLE_FROM = 'Finman <hello@finman.money>';
    sent = [];
    const emailService = require('../services/emailService');
    jest.spyOn(emailService, 'sendEmail').mockImplementation(async (m) => { sent.push(m); return { sent: true }; });
  });
  afterEach(async () => { jest.restoreAllMocks(); delete process.env.LIFECYCLE_EMAILS; await ctx.close(); });

  async function user(name, hoursAgo, { lang = 'en-CA', email, optOut = 0 } = {}) {
    const u = await dbRun(ctx.db, `INSERT INTO users (username,email,password,full_name,created_at,lifecycle_opt_out) VALUES (?,?,?,?,datetime('now', ?),?)`,
      [name, email || `${name}@example.com`, 'x', `${name} Doe`, `-${hoursAgo} hours`, optOut]);
    await dbRun(ctx.db, 'INSERT INTO user_acquisition (user_id, backfilled, lang) VALUES (?, 0, ?)', [u.id, lang]);
    return u.id;
  }

  test('day 2 gets the invoice tip, day 4 the import tip, day 8 the next tip; one each, then quiet', async () => {
    const tips = require('../services/tips');
    const a = await user('ann', 30);
    const b = await user('bob', 80, { lang: 'ru-RU' });
    const c = await user('cat', 8 * 24, { lang: 'uk' });
    const r = await tips.runTips();
    expect(r.sent).toBe(3);
    const kinds = await dbGet(ctx.db, 'SELECT user_id, kind FROM lifecycle_emails ORDER BY user_id');
    expect(kinds).toEqual([{ user_id: a, kind: 'tip_invoice' }, { user_id: b, kind: 'tip_invoice' }, { user_id: c, kind: 'tip_import' }]);
    const bobMail = sent.find((m) => m.to[0] === 'bob@example.com');
    expect(bobMail.subject).toMatch(/Первый счёт/);
    expect(bobMail.headers['List-Unsubscribe']).toMatch(/\/api\/t\/unsubscribe\?u=\d+&t=[0-9a-f]{32}/);
    expect(sent.find((m) => m.to[0] === 'cat@example.com').subject).toMatch(/Виписка/);
    // Next run the same day: the 2-day gap holds everyone.
    const r2 = await tips.runTips();
    expect(r2.sent).toBe(0);
  });

  test('a done step is skipped for good; opted-out and test accounts get nothing', async () => {
    const tips = require('../services/tips');
    const a = await user('dan', 80);
    await dbRun(ctx.db, "INSERT INTO analytics_events (user_id, event) VALUES (?, 'import_done')", [a]);
    await dbRun(ctx.db, "INSERT INTO invoice_profiles (user_id, name) VALUES (?, 'x')", [a]);
    await dbRun(ctx.db, "INSERT INTO invoices (user_id, number, issue_date, currency) VALUES (?, '1', '2026-11-20', 'CAD')", [a]);
    await user('eve', 30, { optOut: 1 });
    await user('fay', 30, { email: 'fay@finman.test' });
    const r = await tips.runTips();
    expect(r.sent).toBe(0);
    expect(r.skipped_done).toBe(2); // in both windows (day 3): invoice made, statement imported
    const rows = await dbGet(ctx.db, 'SELECT kind FROM lifecycle_emails WHERE user_id = ? ORDER BY kind', [a]);
    expect(rows.map((x) => x.kind)).toEqual(['tip_import:skip', 'tip_invoice:skip']);
  });

  test('texts: three languages, no money figures, no "free", no sentence opening with a negation', () => {
    const tips = require('../services/tips');
    for (const lang of ['en', 'ru', 'uk']) {
      for (const t of tips.TIPS) {
        const m = tips.render(t.kind, { full_name: 'Ann Lee', lang }, 'https://app.finman.money/api/t/unsubscribe?u=1&t=x');
        expect(m.subject.length).toBeGreaterThan(10);
        expect(m.text).toContain('unsubscribe');
        expect(m.text).not.toMatch(/free|бесплат|безкошт|beta|бета/i);
        expect(m.text).not.toMatch(/\$\s?\d|\d+[.,]\d\d\s?(CAD|USD|EUR)/);
        for (const sentence of m.text.split(/(?<=[.!?])\s+|\n+/)) expect(sentence.trim()).not.toMatch(/^(No|Not|Don't|Не|Ні|Нет)\b/);
      }
    }
  });
  test('day 20 still gets the next tip (window to day 30) with the feedback line; 3 unanswered emails = quiet', async () => {
    const tips = require('../services/tips');
    const g = await user('gus', 20 * 24);
    const h = await user('hal', 20 * 24);
    // hal: three Finman emails and no visit since -> left alone.
    for (const k of ['nudge_not_activated', 'tip_invoice', 'week:2026-11-16']) {
      await dbRun(ctx.db, "INSERT INTO lifecycle_emails (user_id, kind, sent_at) VALUES (?, ?, datetime('now', '-5 days'))", [h, k]);
    }
    // team digest rows are not emails to the person (neither for the 2-day gap nor for the quiet rule)
    await dbRun(ctx.db, "INSERT INTO lifecycle_emails (user_id, kind, sent_at) VALUES (?, 'digest_1d', datetime('now', '-2 hours'))", [g]);
    await dbRun(ctx.db, "INSERT INTO lifecycle_emails (user_id, kind, sent_at) VALUES (?, 'digest_7d', datetime('now', '-5 days'))", [g]);
    const r = await tips.runTips();
    expect(r.quiet).toBe(1);
    const toG = sent.filter((m) => m.to[0] === 'gus@example.com');
    expect(toG).toHaveLength(1);
    expect(toG[0].text).toMatch(/\/feedback/);
    expect(sent.find((m) => m.to[0] === 'hal@example.com')).toBeUndefined();
    expect(await tips.unanswered(h)).toBe(3);
    // A visit resets the count.
    await dbRun(ctx.db, "INSERT INTO analytics_events (user_id, event, created_at) VALUES (?, 'app_open', datetime('now', '-1 days'))", [h]);
    expect(await tips.unanswered(h)).toBe(0);
  });
});
