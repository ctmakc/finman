// test/journal-beacon.test.js — POST /api/t/me (routes/track.js) and the shared
// activity rules (lib/activityRules.js).
//
// Encrypted (vault) users run the app's routes in the browser, so the server
// journal (middleware/activity.js) never sees their writes. The browser reports
// the same event name through /api/t/me; the server accepts names only:
//   - sign-in required; unknown names and free text are dropped;
//   - activity names from eventFor() and screen milestones are stored;
//   - props keep a short allowlist (no questions, amounts or descriptions);
//   - report_viewed is stored once per user, page and day;
//   - the engine bundle exposes the same eventFor().
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { makeApp } = require('./helpers/app');

let ctx, db, config, alice;

async function mkUser(name) {
  const r = await db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
    [name, `${name}@example.com`, await bcrypt.hash('password123', 4)]);
  return { id: r.id, token: jwt.sign({ id: r.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
}
const me = (body, token) => {
  const r = ctx.request.post('/api/t/me').send(body);
  return token ? r.set('Authorization', 'Bearer ' + token) : r;
};
const settle = () => new Promise((r) => setTimeout(r, 60));
const rows = (uid, event) => db.query('SELECT event, props FROM analytics_events WHERE user_id = ? AND event = ?', [uid, event]);

beforeAll(async () => {
  ctx = await makeApp();
  db = require('../db/database');
  config = require('../config/config');
  alice = await mkUser('alice');
});
afterAll(async () => { await ctx.close(); });

describe('activity rules', () => {
  const { eventFor, isActivityEvent } = require('../lib/activityRules');
  test('same names as the server journal', () => {
    expect(eventFor('POST', '/api/transactions', true)).toBe('transaction_added');
    expect(eventFor('POST', '/api/bank-api/import/commit', true)).toBe('import_done');
    expect(eventFor('POST', '/api/bank-api/import/preview', false)).toBe('import_failed');
    expect(eventFor('POST', '/api/accounts', true)).toBe('account_created');
    expect(eventFor('GET', '/api/accounts', true)).toBe(null);
  });
  test('isActivityEvent accepts journal names only', () => {
    expect(isActivityEvent('transaction_added')).toBe(true);
    expect(isActivityEvent('budget_created')).toBe(true);
    expect(isActivityEvent('import_failed')).toBe(true);
    expect(isActivityEvent('drop table')).toBe(false);
    expect(isActivityEvent('weekly_email_sent')).toBe(false);
  });
  test('the vault engine exports the same eventFor', () => {
    const eng = require('../engine/dist/engine.node.cjs');
    expect(typeof eng.eventFor).toBe('function');
    expect(eng.eventFor('POST', '/api/transactions', true)).toBe('transaction_added');
  });
});

describe('POST /api/t/me', () => {
  test('needs a sign-in', async () => {
    expect((await me({ event: 'transaction_added' })).status).toBe(401);
  });

  test('stores a vault action with allowed flags only', async () => {
    const r = await me({ event: 'transaction_added', props: { local: true, amount: 120.5, description: 'Rent', q: 'how much' } }, alice.token);
    expect(r.status).toBe(204);
    await settle();
    const got = await rows(alice.id, 'transaction_added');
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0].props)).toEqual({ local: true });
  });

  test('keeps the failure code of an import', async () => {
    await me({ event: 'import_failed', props: { local: true, code: 'FILE_PDF' } }, alice.token);
    await settle();
    expect(JSON.parse((await rows(alice.id, 'import_failed'))[0].props)).toEqual({ local: true, code: 'FILE_PDF' });
  });

  test('screen milestones are stored, unknown names are dropped', async () => {
    await me({ event: 'vault_key_saved' }, alice.token);
    await me({ event: 'onboarding_firstrun_shown', props: { emailVerified: false } }, alice.token);
    await me({ event: 'email_sent' }, alice.token);
    await me({ event: 'anything_at_all; DROP' }, alice.token);
    await settle();
    expect(await rows(alice.id, 'vault_key_saved')).toHaveLength(1);
    expect(await rows(alice.id, 'onboarding_firstrun_shown')).toHaveLength(1);
    expect(await rows(alice.id, 'email_sent')).toHaveLength(0);
  });

  test('string flags with free text are dropped', async () => {
    await me({ event: 'onboarding_bank_picked', props: { bank: 'td', source: 'My salary is <b>5000</b> & more text here' } }, alice.token);
    await settle();
    expect(JSON.parse((await rows(alice.id, 'onboarding_bank_picked'))[0].props)).toEqual({ bank: 'td' });
  });

  test('report_viewed once per page and day', async () => {
    await me({ event: 'report_viewed', props: { page: 'reports' } }, alice.token);
    await settle();
    await me({ event: 'report_viewed', props: { page: 'reports' } }, alice.token);
    await me({ event: 'report_viewed', props: { page: 'money-map' } }, alice.token);
    await settle();
    const got = await rows(alice.id, 'report_viewed');
    expect(got.map((g) => JSON.parse(g.props).page).sort()).toEqual(['money-map', 'reports']);
  });
});
