// test/account-delete.test.js — DELETE /api/auth/me (Settings > Danger zone).
//
//   - guards: auth, confirm:"DELETE", current password (only when the account has one);
//   - every row the user owns is gone, and another user's data is byte-for-byte
//     the same afterwards;
//   - shared data: family ownership passes on, permissions and split rows of
//     other people survive, transfers to other people are unpaired;
//   - Apple refresh token revoked when the SIWA key is configured;
//   - account_deleted tracked with no user id, IP or email.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { makeApp } = require('./helpers/app');

let ctx, db, config;

async function mkUser(name, { password = 'password123', apple = null, google = null } = {}) {
  const r = await db.run(
    'INSERT INTO users (username, email, password, google_id, apple_id) VALUES (?, ?, ?, ?, ?)',
    [name, `${name}@example.com`, await bcrypt.hash(password, 4), google, apple]
  );
  return { id: r.id, token: jwt.sign({ id: r.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
}

// A full personal dataset for user `uid` (no links to anybody else).
async function seedOwnData(uid, tag) {
  const ins = async (sql, params) => (await db.run(sql, params)).id;
  const acc = await ins('INSERT INTO accounts (user_id, name, balance) VALUES (?, ?, 100)', [uid, `${tag} chequing`]);
  const acc2 = await ins('INSERT INTO accounts (user_id, name, balance) VALUES (?, ?, 50)', [uid, `${tag} savings`]);
  const tx = await ins(`INSERT INTO transactions (account_id, user_id, date, amount, type, description) VALUES (?, ?, '2026-11-01', 12.5, 'expense', ?)`, [acc, uid, `${tag} coffee`]);
  await ins(`INSERT INTO transactions (account_id, user_id, date, amount, type, transfer_id) VALUES (?, ?, '2026-11-02', 10, 'expense', ?)`, [acc, uid, `${tag}-tr`]);
  await ins(`INSERT INTO transactions (account_id, user_id, date, amount, type, transfer_id) VALUES (?, ?, '2026-11-02', 10, 'income', ?)`, [acc2, uid, `${tag}-tr`]);
  await ins(`INSERT INTO categories (user_id, name, type) VALUES (?, ?, 'expense')`, [uid, `${tag} food`]);
  const budget = await ins(`INSERT INTO budgets (user_id, name, amount, start_date) VALUES (?, ?, 300, '2026-11-01')`, [uid, `${tag} groceries`]);
  await ins(`INSERT INTO recurring_payments (user_id, account_id, name, amount, start_date, next_payment_date) VALUES (?, ?, 'rent', 900, '2026-01-01', '2026-12-01')`, [uid, acc]);
  const tagId = await ins('INSERT INTO tags (user_id, name) VALUES (?, ?)', [uid, `${tag}-tag`]);
  await db.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', [tx, tagId]);
  const goal = await ins('INSERT INTO savings_goals (user_id, name, target_amount) VALUES (?, ?, 1000)', [uid, `${tag} trip`]);
  await ins('INSERT INTO goal_contributions (goal_id, amount, transaction_id) VALUES (?, 20, ?)', [goal, tx]);
  const debt = await ins(`INSERT INTO debts (user_id, name, type, amount, start_date) VALUES (?, 'loan', 'owe', 500, '2026-01-01')`, [uid]);
  await ins(`INSERT INTO debt_payments (debt_id, amount, payment_date) VALUES (?, 50, '2026-02-01')`, [debt]);
  const grp = await ins('INSERT INTO split_groups (user_id, name) VALUES (?, ?)', [uid, `${tag} flat`]);
  const m1 = await ins('INSERT INTO split_members (group_id, user_id, name, is_registered) VALUES (?, ?, ?, 1)', [grp, uid, tag]);
  const m2 = await ins(`INSERT INTO split_members (group_id, name) VALUES (?, 'roommate')`, [grp]);
  const exp = await ins(`INSERT INTO split_expenses (group_id, paid_by, description, amount, date) VALUES (?, ?, 'pizza', 30, '2026-11-01')`, [grp, m1]);
  await ins('INSERT INTO split_shares (expense_id, member_id, amount) VALUES (?, ?, 15)', [exp, m2]);
  await ins(`INSERT INTO split_settlements (group_id, from_member, to_member, amount, date) VALUES (?, ?, ?, 15, '2026-11-03')`, [grp, m2, m1]);
  await ins(`INSERT INTO notifications (user_id, type, title) VALUES (?, 'info', 'hi')`, [uid]);
  await ins('INSERT INTO notification_settings (user_id) VALUES (?)', [uid]);
  const pf = await ins('INSERT INTO investment_portfolios (user_id, name) VALUES (?, ?)', [uid, `${tag} pf`]);
  await ins(`INSERT INTO investments (portfolio_id, symbol, name, type, quantity, buy_price, buy_date) VALUES (?, 'VFV', 'VFV', 'etf', 1, 100, '2026-01-01')`, [pf]);
  await ins(`INSERT INTO subscriptions (user_id, name, amount, start_date, account_id) VALUES (?, 'music', 11, '2026-01-01', ?)`, [uid, acc]);
  await ins('INSERT INTO receipts (user_id, transaction_id) VALUES (?, ?)', [uid, tx]);
  const conv = await ins('INSERT INTO ai_conversations (user_id) VALUES (?)', [uid]);
  await ins(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'user', 'how much did I spend')`, [conv]);
  await ins(`INSERT INTO category_rules (user_id, match_value, set_category) VALUES (?, 'tim', 'coffee')`, [uid]);
  await ins(`INSERT INTO personal_access_tokens (user_id, name, token_hash) VALUES (?, 'cli', ?)`, [uid, crypto.randomBytes(16).toString('hex')]);
  await ins(`INSERT INTO manual_assets (user_id, name, type, value) VALUES (?, 'car', 'vehicle', 9000)`, [uid]);
  await ins(`INSERT INTO networth_snapshots (user_id, total_assets, total_liabilities, net_worth, snapshot_date) VALUES (?, 1, 0, 1, '2026-11-01')`, [uid]);
  await ins(`INSERT INTO dashboard_widgets (user_id, widget_type) VALUES (?, 'balance')`, [uid]);
  await ins(`INSERT INTO calendar_events (user_id, title, event_type, event_date) VALUES (?, 'pay', 'bill', '2026-11-20')`, [uid]);
  await ins(`INSERT INTO reports (user_id, report_type, title) VALUES (?, 'monthly', 'Nov')`, [uid]);
  await ins(`INSERT INTO bank_connections (user_id, bank_id) VALUES (?, 'td')`, [uid]);
  await ins(`INSERT INTO custom_banks (user_id, bank_key, name, country, api_url) VALUES (?, ?, 'B', 'CA', 'https://b.example')`, [uid, `${tag}-bank`]);
  await ins('INSERT INTO user_currency_settings (user_id) VALUES (?)', [uid]);
  await ins(`INSERT INTO ai_insights (user_id, period, type, content) VALUES (?, '2026-11', 'tip', 'x')`, [uid]);
  await ins(`INSERT INTO analytics_events (user_id, event) VALUES (?, 'page_view')`, [uid]);
  await db.run(`INSERT INTO lifecycle_emails (user_id, kind) VALUES (?, 'welcome')`, [uid]);
  await db.run(`INSERT INTO user_acquisition (user_id, method) VALUES (?, 'password')`, [uid]);
  const fam = await ins('INSERT INTO families (name, owner_id) VALUES (?, ?)', [`${tag} family`, uid]);
  await ins(`INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'owner')`, [fam, uid]);
  await ins(`INSERT INTO family_invites (family_id, email, invite_token, expires_at, created_by) VALUES (?, 'x@example.com', ?, '2027-01-01', ?)`, [fam, crypto.randomBytes(8).toString('hex'), uid]);
  return { acc, acc2, budget, tx, fam, grp };
}

// Every table, every row, ordered — for "untouched" comparisons.
async function dumpAll(skip = []) {
  const tables = (await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`))
    .map((t) => t.name).filter((t) => !skip.includes(t));
  const out = {};
  for (const t of tables) out[t] = await db.query(`SELECT * FROM "${t}" ORDER BY rowid`);
  return out;
}

async function rowsOf(uid) {
  const tables = (await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)).map((t) => t.name);
  const hits = {};
  for (const t of tables) {
    const cols = (await db.query(`PRAGMA table_info("${t}")`)).map((c) => c.name)
      .filter((c) => ['user_id', 'owner_id', 'created_by', 'granted_by'].includes(c));
    for (const c of cols) {
      const n = (await db.get(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${c} = ?`, [uid])).n;
      if (n) hits[`${t}.${c}`] = n;
    }
  }
  if ((await db.get('SELECT COUNT(*) AS n FROM users WHERE id = ?', [uid])).n) hits.users = 1;
  return hits;
}

const del = (token, body) => ctx.request.delete('/api/auth/me').set('Authorization', 'Bearer ' + token).send(body);

beforeAll(async () => {
  ctx = await makeApp();
  db = require('../db/database');
  config = require('../config/config');
});
afterAll(async () => { await ctx.close(); });

describe('DELETE /api/auth/me — guards', () => {
  test('requires auth', async () => {
    expect((await ctx.request.delete('/api/auth/me').send({ confirm: 'DELETE' })).status).toBe(401);
  });

  test('requires confirm "DELETE" and the current password', async () => {
    const u = await mkUser('guard1');
    expect((await del(u.token, {})).status).toBe(400);
    expect((await del(u.token, { confirm: 'delete', password: 'password123' })).body.code).toBe('confirm_required');
    const noPw = await del(u.token, { confirm: 'DELETE' });
    expect(noPw.status).toBe(400);
    expect(noPw.body.code).toBe('wrong_password');
    expect((await del(u.token, { confirm: 'DELETE', password: 'nope' })).body.code).toBe('wrong_password');
    expect((await db.get('SELECT id FROM users WHERE id = ?', [u.id]))).toBeTruthy();
    const ok = await del(u.token, { confirm: 'DELETE', password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    // the token is dead afterwards
    expect((await ctx.request.get('/api/auth/me').set('Authorization', 'Bearer ' + u.token)).status).toBe(401);
  });

  test('Google-only account: no password needed; GET /me says hasPassword false', async () => {
    const u = await mkUser('guser', { google: 'g-del-1' });
    const me = await ctx.request.get('/api/auth/me').set('Authorization', 'Bearer ' + u.token);
    expect(me.body).toMatchObject({ google: true, apple: false, hasPassword: false });
    expect((await del(u.token, { confirm: 'DELETE' })).status).toBe(200);
  });

  test('password account: GET /me says hasPassword true', async () => {
    const me = await ctx.request.get('/api/auth/me').set('Authorization', 'Bearer ' + ctx.token);
    expect(me.body).toMatchObject({ google: false, apple: false, hasPassword: true });
  });
});

describe('DELETE /api/auth/me — data', () => {
  test('removes every row of the user and leaves another user untouched', async () => {
    const bob = await mkUser('bob');
    await seedOwnData(bob.id, 'bob');
    const victim = await mkUser('victim');
    // Baseline is taken BEFORE the victim's data exists, so the comparison
    // below proves the delete touched nothing else.
    const baseline = await dumpAll(['analytics_events', 'sqlite_sequence']);
    await seedOwnData(victim.id, 'victim');
    expect(Object.keys(await rowsOf(victim.id)).length).toBeGreaterThan(30);

    const r = await del(victim.token, { confirm: 'DELETE', password: 'password123' });
    expect(r.status).toBe(200);
    expect(await rowsOf(victim.id)).toEqual({});

    // Orphans: child tables keyed by a parent the victim owned.
    for (const [t, parent, col] of [
      ['ai_messages', 'ai_conversations', 'conversation_id'], ['transaction_tags', 'transactions', 'transaction_id'],
      ['goal_contributions', 'savings_goals', 'goal_id'], ['debt_payments', 'debts', 'debt_id'],
      ['investments', 'investment_portfolios', 'portfolio_id'], ['split_members', 'split_groups', 'group_id'],
      ['split_expenses', 'split_groups', 'group_id'], ['family_members', 'families', 'family_id'],
    ]) {
      const n = (await db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} NOT IN (SELECT id FROM ${parent})`)).n;
      expect([t, n]).toEqual([t, 0]);
    }

    const after = await dumpAll(['analytics_events', 'sqlite_sequence']);
    baseline.users = baseline.users.filter((u) => u.id !== victim.id);
    expect(after).toEqual(baseline);
    // bob's analytics rows are still there
    expect((await db.get('SELECT COUNT(*) AS n FROM analytics_events WHERE user_id = ?', [bob.id])).n).toBe(1);
    expect((await db.query('PRAGMA foreign_key_check'))).toEqual([]);
  });

  test('account_deleted is tracked without user id, ip or email', async () => {
    const u = await mkUser('tracked');
    await del(u.token, { confirm: 'DELETE', password: 'password123' });
    await require('../services/tracker').flush();
    const ev = await db.query(`SELECT * FROM analytics_events WHERE event = 'account_deleted' ORDER BY id DESC LIMIT 1`);
    expect(ev).toHaveLength(1);
    expect(ev[0].user_id).toBeNull();
    expect(ev[0].ip).toBeNull();
    expect(ev[0].props).not.toMatch(/tracked|@/);
    expect(JSON.parse(ev[0].props)).toEqual({ method: 'password' });
  });

  test('shared data: family passes to an admin, others keep their rows', async () => {
    const owner = await mkUser('famowner');
    const admin = await mkUser('famadmin');
    const member = await mkUser('fammember');
    const fam = (await db.run('INSERT INTO families (name, owner_id) VALUES (?, ?)', ['Shared', owner.id])).id;
    await db.run(`INSERT INTO family_members (family_id, user_id, role, joined_at) VALUES (?, ?, 'owner', '2026-01-01')`, [fam, owner.id]);
    await db.run(`INSERT INTO family_members (family_id, user_id, role, joined_at) VALUES (?, ?, 'member', '2026-01-02')`, [fam, member.id]);
    await db.run(`INSERT INTO family_members (family_id, user_id, role, joined_at) VALUES (?, ?, 'admin', '2026-01-03')`, [fam, admin.id]);
    const invite = await db.run(`INSERT INTO family_invites (family_id, email, invite_token, expires_at, created_by) VALUES (?, 'n@example.com', 'tok-admin', '2027-01-01', ?)`, [fam, admin.id]);

    // Accounts: owner shares one with member; member shares one with owner,
    // and admin granted something on member's account (re-attributed later).
    const ownerAcc = (await db.run(`INSERT INTO accounts (user_id, name) VALUES (?, 'owner acc')`, [owner.id])).id;
    const memberAcc = (await db.run(`INSERT INTO accounts (user_id, name) VALUES (?, 'member acc')`, [member.id])).id;
    await db.run('INSERT INTO account_permissions (account_id, user_id, granted_by) VALUES (?, ?, ?)', [ownerAcc, member.id, owner.id]);
    await db.run('INSERT INTO account_permissions (account_id, user_id, granted_by) VALUES (?, ?, ?)', [memberAcc, owner.id, member.id]);
    await db.run('INSERT INTO account_permissions (account_id, user_id, granted_by) VALUES (?, ?, ?)', [memberAcc, admin.id, owner.id]);
    const memberBudget = (await db.run(`INSERT INTO budgets (user_id, name, amount, start_date) VALUES (?, 'b', 1, '2026-11-01')`, [member.id])).id;
    await db.run('INSERT INTO budget_permissions (budget_id, user_id, granted_by) VALUES (?, ?, ?)', [memberBudget, owner.id, member.id]);
    await db.run('INSERT INTO budget_permissions (budget_id, user_id, granted_by) VALUES (?, ?, ?)', [memberBudget, admin.id, owner.id]);

    // Transfer from owner's account to member's (shared) account; member's
    // subscription and recurring payment point at the owner's account.
    await db.run(`INSERT INTO transactions (account_id, user_id, date, amount, type, transfer_id) VALUES (?, ?, '2026-11-05', 40, 'expense', 'x-tr')`, [ownerAcc, owner.id]);
    const keptLeg = (await db.run(`INSERT INTO transactions (account_id, user_id, date, amount, type, transfer_id) VALUES (?, ?, '2026-11-05', 40, 'income', 'x-tr')`, [memberAcc, member.id])).id;
    const sub = (await db.run(`INSERT INTO subscriptions (user_id, name, amount, start_date, account_id) VALUES (?, 's', 5, '2026-01-01', ?)`, [member.id, ownerAcc])).id;
    await db.run(`INSERT INTO recurring_payments (user_id, account_id, name, amount, start_date, next_payment_date) VALUES (?, ?, 'r', 1, '2026-01-01', '2026-12-01')`, [member.id, ownerAcc]);

    // Split group of member that includes the owner as a registered member.
    const grp = (await db.run(`INSERT INTO split_groups (user_id, name) VALUES (?, 'trip')`, [member.id])).id;
    const sm = (await db.run(`INSERT INTO split_members (group_id, user_id, name, email, is_registered) VALUES (?, ?, 'Owner', 'famowner@example.com', 1)`, [grp, owner.id])).id;
    const sm2 = (await db.run(`INSERT INTO split_members (group_id, user_id, name, is_registered) VALUES (?, ?, 'Member', 1)`, [grp, member.id])).id;
    const exp = (await db.run(`INSERT INTO split_expenses (group_id, paid_by, description, amount, date) VALUES (?, ?, 'hotel', 200, '2026-11-01')`, [grp, sm])).id;
    await db.run('INSERT INTO split_shares (expense_id, member_id, amount) VALUES (?, ?, 100)', [exp, sm2]);

    const r = await del(owner.token, { confirm: 'DELETE', password: 'password123' });
    expect(r.status).toBe(200);
    expect(await rowsOf(owner.id)).toEqual({});

    expect(await db.get('SELECT owner_id FROM families WHERE id = ?', [fam])).toEqual({ owner_id: admin.id });
    const roles = await db.query('SELECT user_id, role FROM family_members WHERE family_id = ? ORDER BY user_id', [fam]);
    expect(roles).toEqual([{ user_id: admin.id, role: 'owner' }, { user_id: member.id, role: 'member' }].sort((a, b) => a.user_id - b.user_id));
    expect(await db.get('SELECT id FROM family_invites WHERE id = ?', [invite.id])).toBeTruthy();

    // Member's account and admin's permission survive; the grant is re-attributed.
    expect(await db.get('SELECT id FROM accounts WHERE id = ?', [memberAcc])).toBeTruthy();
    expect(await db.query('SELECT user_id, granted_by FROM account_permissions WHERE account_id = ?', [memberAcc]))
      .toEqual([{ user_id: admin.id, granted_by: member.id }]);
    expect(await db.query('SELECT user_id, granted_by FROM budget_permissions WHERE budget_id = ?', [memberBudget]))
      .toEqual([{ user_id: admin.id, granted_by: member.id }]);
    expect(await db.query('SELECT * FROM account_permissions WHERE account_id = ?', [ownerAcc])).toEqual([]);

    // Kept transfer leg is unpaired, subscription unlinked, recurring on the gone account removed.
    expect(await db.get('SELECT transfer_id FROM transactions WHERE id = ?', [keptLeg])).toEqual({ transfer_id: null });
    expect(await db.get('SELECT account_id FROM subscriptions WHERE id = ?', [sub])).toEqual({ account_id: null });
    expect((await db.get('SELECT COUNT(*) AS n FROM recurring_payments WHERE account_id = ?', [ownerAcc])).n).toBe(0);

    // Split row stays for member's ledger, unlinked and without the email.
    expect(await db.get('SELECT user_id, name, email, is_registered FROM split_members WHERE id = ?', [sm]))
      .toEqual({ user_id: null, name: 'Owner', email: null, is_registered: 0 });
    expect(await db.get('SELECT paid_by FROM split_expenses WHERE id = ?', [exp])).toEqual({ paid_by: sm });
    expect((await db.query('PRAGMA foreign_key_check'))).toEqual([]);
  });

  test('a family with nobody else left is deleted', async () => {
    const solo = await mkUser('solo');
    const fam = (await db.run('INSERT INTO families (name, owner_id) VALUES (?, ?)', ['Solo', solo.id])).id;
    await db.run(`INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'owner')`, [fam, solo.id]);
    await del(solo.token, { confirm: 'DELETE', password: 'password123' });
    expect(await db.get('SELECT id FROM families WHERE id = ?', [fam])).toBeUndefined();
  });

  test('a failure rolls everything back', async () => {
    const u = await mkUser('rollback');
    await seedOwnData(u.id, 'rb');
    const before = await rowsOf(u.id);
    // Fail the very last step (the users row) through a trigger.
    await db.run(`CREATE TEMP TRIGGER block_user_delete BEFORE DELETE ON users WHEN old.username = 'rollback'
                  BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await del(u.token, { confirm: 'DELETE', password: 'password123' });
    spy.mockRestore();
    await db.run('DROP TRIGGER block_user_delete');
    expect(r.status).toBe(500);
    expect(await rowsOf(u.id)).toEqual(before);
  });
});

describe('DELETE /api/auth/me — Apple', () => {
  test('revokes the stored Apple refresh token when SIWA is configured', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyPath = path.join(os.tmpdir(), `siwa-del-${process.pid}.p8`);
    fs.writeFileSync(keyPath, ec.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    Object.assign(config.apple, { keyPath, keyId: 'KEYID12345', teamId: 'TEAMID1234' });
    const u = await mkUser('appleuser', { apple: 'apple-sub-del' });
    await db.run('UPDATE users SET apple_refresh_token_enc = ? WHERE id = ?', [config.encryptToken('rt-to-revoke'), u.id]);
    let revokeBody;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      if (String(url) === 'https://appleid.apple.com/auth/revoke') {
        revokeBody = new URLSearchParams(opts.body);
        return { ok: true, status: 200 };
      }
      throw new Error('unexpected');
    });
    try {
      const r = await del(u.token, { confirm: 'DELETE' }); // Apple-only: no password
      expect(r.status).toBe(200);
      expect(revokeBody.get('token')).toBe('rt-to-revoke');
      expect(revokeBody.get('token_type_hint')).toBe('refresh_token');
      expect(revokeBody.get('client_id')).toBe('money.finman.app');
      expect(await rowsOf(u.id)).toEqual({});
    } finally {
      fetchSpy.mockRestore();
      Object.assign(config.apple, { keyPath: '', keyId: '', teamId: '' });
      fs.unlinkSync(keyPath);
    }
  });

  test('without SIWA env the delete still succeeds and nothing is fetched', async () => {
    const u = await mkUser('appleuser2', { apple: 'apple-sub-del-2' });
    await db.run('UPDATE users SET apple_refresh_token_enc = ? WHERE id = ?', [config.encryptToken('rt'), u.id]);
    const fetchSpy = jest.spyOn(global, 'fetch');
    const r = await del(u.token, { confirm: 'DELETE' });
    expect(r.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
