/** @jest-environment node */
// test/vault.test.js — server side of Finman Vault (docs/E2E-ENCRYPTION.md):
// prelogin, register/setup switching to authToken, blob versions, legacy export,
// purge only on matching counts, rewrap, password change with the wrap, account
// deletion, jobs that skip vault users, and lib/vaultTables.js against the schema.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const C = require('../public/js/vault/crypto');
const { makeApp } = require('./helpers/app');

jest.setTimeout(60000);

let ctx, db, config;
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const token = () => 'fm1$' + crypto.randomBytes(32).toString('hex');

async function boot() {
  ctx = await makeApp();
  db = require('../db/database');
  config = require('../config/config');
}

async function mkUser(name, { password = 'password123', google = null } = {}) {
  const r = await db.run(
    'INSERT INTO users (username, email, password, google_id) VALUES (?, ?, ?, ?)',
    [name, `${name}@example.com`, await bcrypt.hash(password, 4), google],
  );
  return { id: r.id, email: `${name}@example.com`, token: jwt.sign({ id: r.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
}

// A dataset across parent/child vault tables (no links to other users).
async function seed(uid, tag) {
  const ins = async (sql, params) => (await db.run(sql, params)).id;
  const acc = await ins('INSERT INTO accounts (user_id, name, balance) VALUES (?, ?, 100)', [uid, `${tag} chequing`]);
  const tx = await ins(`INSERT INTO transactions (account_id, user_id, date, amount, type, description) VALUES (?, ?, '2026-11-01', 12.5, 'expense', ?)`, [acc, uid, `${tag} coffee`]);
  await ins(`INSERT INTO transactions (account_id, user_id, date, amount, type, description) VALUES (?, ?, '2026-11-02', 900, 'income', 'pay')`, [acc, uid]);
  await ins(`INSERT INTO categories (user_id, name, type) VALUES (?, ?, 'expense')`, [uid, `${tag} food`]);
  await ins(`INSERT INTO budgets (user_id, name, amount, start_date) VALUES (?, ?, 300, '2026-11-01')`, [uid, `${tag} groceries`]);
  const tagId = await ins('INSERT INTO tags (user_id, name) VALUES (?, ?)', [uid, `${tag}-tag`]);
  await db.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', [tx, tagId]);
  const goal = await ins('INSERT INTO savings_goals (user_id, name, target_amount) VALUES (?, ?, 1000)', [uid, `${tag} trip`]);
  await ins('INSERT INTO goal_contributions (goal_id, amount, transaction_id) VALUES (?, 20, ?)', [goal, tx]);
  const grp = await ins('INSERT INTO split_groups (user_id, name) VALUES (?, ?)', [uid, `${tag} flat`]);
  const m1 = await ins('INSERT INTO split_members (group_id, user_id, name, is_registered) VALUES (?, ?, ?, 1)', [grp, uid, tag]);
  const m2 = await ins(`INSERT INTO split_members (group_id, name) VALUES (?, 'roommate')`, [grp]);
  const exp = await ins(`INSERT INTO split_expenses (group_id, paid_by, description, amount, date) VALUES (?, ?, 'pizza', 30, '2026-11-01')`, [grp, m1]);
  await ins('INSERT INTO split_shares (expense_id, member_id, amount) VALUES (?, ?, 15)', [exp, m2]);
  const pf = await ins('INSERT INTO investment_portfolios (user_id, name) VALUES (?, ?)', [uid, `${tag} pf`]);
  await ins(`INSERT INTO investments (portfolio_id, symbol, name, type, quantity, buy_price, buy_date) VALUES (?, 'VFV', 'VFV', 'etf', 1, 100, '2026-01-01')`, [pf]);
  await ins('INSERT INTO receipts (user_id, transaction_id) VALUES (?, ?)', [uid, tx]);
  const conv = await ins('INSERT INTO ai_conversations (user_id) VALUES (?)', [uid]);
  await ins(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'user', 'how much did I spend')`, [conv]);
  await ins(`INSERT INTO bank_connections (user_id, bank_id, access_token) VALUES (?, 'td', ?)`, [uid, config.encryptToken('bank-secret')]);
  await ins(`INSERT INTO user_ai_keys (user_id, provider, key_enc, key_hint) VALUES (?, 'openai', ?, 'abcd')`, [uid, config.encryptToken(`sk-${tag}-abcd`)]);
  return { acc, tx };
}

async function countsOf(uid) {
  return require('../services/vault').legacyCounts(uid);
}

// A real encrypted vault + wraps from the client crypto module.
async function makeVault(uid, plain = Buffer.from('SQLite format 3\0 pretend')) {
  const vk = C.newVaultKey();
  const blob = Buffer.from(await C.encryptVault(vk, new Uint8Array(plain), uid));
  const kek = C.randomBytes(32);
  const rk = C.newRecoveryKey();
  return {
    vk,
    blob,
    wrapped_pw: await C.wrap(kek, vk, C.wrapAad(uid, 'pw')),
    wrapped_rc: await C.wrap(await C.kekFromRecovery(rk.bytes), vk, C.wrapAad(uid, 'rc')),
  };
}

async function setupBody(uid, extra = {}) {
  const v = await makeVault(uid);
  return {
    v,
    body: {
      blob_b64: v.blob.toString('base64'), wrapped_pw: v.wrapped_pw, wrapped_rc: v.wrapped_rc,
      kdf_salt: C.newSalt(), kdf_params: C.DEFAULT_PARAMS, ...extra,
    },
  };
}

const login = (username, password) => ctx.request.post('/api/auth/login').send({ username, password });

// ---------------------------------------------------------------------------
describe('schema: lib/vaultTables.js matches the real database', () => {
  beforeAll(boot);
  afterAll(() => ctx.close());

  test('migration 028 columns and tables', async () => {
    const cols = (await db.query('PRAGMA table_info(users)')).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['kdf', 'kdf_salt', 'kdf_params', 'vault_state']));
    const u = await db.get('SELECT kdf, vault_state FROM users WHERE id = ?', [ctx.userId]);
    expect(u).toEqual({ kdf: 'legacy', vault_state: 'none' });
    const vcols = (await db.query('PRAGMA table_info(user_vaults)')).map((c) => c.name);
    expect(vcols).toEqual(['user_id', 'version', 'blob', 'size', 'wrapped_pw', 'wrapped_rc', 'created_at', 'updated_at']);
    const gcols = (await db.query('PRAGMA table_info(vault_grants)')).map((c) => c.name);
    expect(gcols).toEqual(['id', 'user_id', 'token_hash', 'wrapped_vk', 'label', 'created_at', 'last_used_at', 'revoked_at']);
    // idempotent: running it again changes nothing
    const { columnExists } = require('../lib/migrate');
    await require('../migrations/028_vault').up(db, { columnExists });
  });

  test('every table and every column in the where clauses exists', async () => {
    const { VAULT_TABLES, paramsFor } = require('../lib/vaultTables');
    const tables = new Set((await db.query(`SELECT name FROM sqlite_master WHERE type='table'`)).map((t) => t.name));
    const columnsOf = async (t) => new Set((await db.query(`PRAGMA table_info(${t})`)).map((c) => c.name));
    const names = VAULT_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    // Exists only on databases that started on the old prod line (test/migration-017.test.js).
    const PROD_ONLY = new Set(['ai_chat_sessions']);
    // onboarding_progress: created lazily by routes/onboarding.js — create it the same way.
    await ctx.request.get('/api/onboarding/status').set(auth(ctx.token));
    const tables2 = new Set((await db.query(`SELECT name FROM sqlite_master WHERE type='table'`)).map((t) => t.name));
    for (const n of tables2) tables.add(n);
    for (const t of VAULT_TABLES) {
      if (PROD_ONLY.has(t.name)) { expect(tables.has(t.name)).toBe(false); continue; }
      expect({ table: t.name, exists: tables.has(t.name) }).toEqual({ table: t.name, exists: true });
      // "col = ?" / "col IN (SELECT id FROM parent WHERE pcol = ? ...)": check each pair.
      const own = await columnsOf(t.name);
      const head = t.where.match(/^(\w+)\s/)[1];
      expect({ table: t.name, col: head, ok: own.has(head) }).toEqual({ table: t.name, col: head, ok: true });
      for (const m of t.where.matchAll(/SELECT id FROM (\w+) WHERE (\w+)/g)) {
        expect(tables.has(m[1])).toBe(true);
        expect({ table: m[1], col: m[2], ok: (await columnsOf(m[1])).has(m[2]) }).toEqual({ table: m[1], col: m[2], ok: true });
      }
      expect((t.where.match(/\?/g) || []).length).toBe(t.params);
      await db.get(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${t.where}`, paramsFor(t, 1));
    }
  });
});

// ---------------------------------------------------------------------------
describe('prelogin and register with fm1', () => {
  beforeAll(boot);
  afterAll(() => ctx.close());

  test('legacy account by email and by username', async () => {
    for (const body of [{ email: 'test@example.com' }, { username: 'testuser' }, { email: 'TEST@example.com' }]) {
      const r = await ctx.request.post('/api/auth/prelogin').send(body);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ kdf: 'legacy', salt: null, params: null });
    }
  });

  test('unknown login: fm1 with a stable fake salt and default params', async () => {
    const a = await ctx.request.post('/api/auth/prelogin').send({ email: 'nobody@example.com' });
    const b = await ctx.request.post('/api/auth/prelogin').send({ email: 'Nobody@Example.com' });
    const c = await ctx.request.post('/api/auth/prelogin').send({ email: 'other@example.com' });
    expect(a.body.kdf).toBe('fm1');
    expect(a.body.params).toEqual({ alg: 'argon2id', m: 65536, t: 3, p: 1, len: 32 });
    expect(Buffer.from(a.body.salt, 'base64')).toHaveLength(16);
    expect(b.body.salt).toBe(a.body.salt);
    expect(c.body.salt).not.toBe(a.body.salt);
    expect((await ctx.request.post('/api/auth/prelogin').send({})).status).toBe(400);
  });

  test('register with kdf_salt requires an authToken, then prelogin/login use it', async () => {
    const salt = C.newSalt();
    const raw = await ctx.request.post('/api/auth/register')
      .send({ email: 'newbie@example.com', password: 'plain-password', kdf_salt: salt, kdf_params: C.DEFAULT_PARAMS });
    expect(raw.status).toBe(400);
    expect(raw.body.code).toBe('BAD_AUTH_TOKEN');

    // Real derivation once: the same path the browser takes.
    const master = await C.deriveMaster('correct horse', salt, C.DEFAULT_PARAMS);
    const at = await C.authToken(master);
    const r = await ctx.request.post('/api/auth/register')
      .send({ email: 'newbie@example.com', password: at, kdf_salt: salt, kdf_params: C.DEFAULT_PARAMS });
    expect(r.status).toBe(200);
    expect(r.body.user.kdf).toBe('fm1');
    const row = await db.get('SELECT kdf, kdf_salt, kdf_params, vault_state FROM users WHERE email = ?', ['newbie@example.com']);
    expect(row).toMatchObject({ kdf: 'fm1', kdf_salt: salt, vault_state: 'none' });
    expect(JSON.parse(row.kdf_params)).toEqual(C.DEFAULT_PARAMS);

    const p = await ctx.request.post('/api/auth/prelogin').send({ email: 'newbie@example.com' });
    expect(p.body).toEqual({ kdf: 'fm1', salt, params: C.DEFAULT_PARAMS });
    expect((await login('newbie@example.com', at)).status).toBe(200);

    const me = await ctx.request.get('/api/auth/me').set(auth(r.body.token));
    expect(me.body).toMatchObject({ kdf: 'fm1', vault_state: 'none', vault_version: null, hasPassword: true, email: 'newbie@example.com' });

    // fm1 user from register: setup proves the hash with auth_token, salt must stay.
    const uid = r.body.user.id;
    const { body } = await setupBody(uid, { kdf_salt: salt, auth_token: token() });
    expect((await ctx.request.post('/api/vault/setup').set(auth(r.body.token)).send(body)).body.code).toBe('wrong_password');
    const other = await setupBody(uid, { auth_token: at });
    expect((await ctx.request.post('/api/vault/setup').set(auth(r.body.token)).send(other.body)).body.code).toBe('SALT_MISMATCH');
    const ok = await ctx.request.post('/api/vault/setup').set(auth(r.body.token)).send({ ...other.body, kdf_salt: salt });
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('vault lifecycle for a legacy password account', () => {
  let alice, bob, at, setupV;
  beforeAll(async () => {
    await boot();
    alice = await mkUser('alice', { password: 'alice-pass-1' });
    bob = await mkUser('bob', { password: 'bob-pass-1' });
    // prod-shaped database: the legacy chat table exists there
    await db.run('CREATE TABLE ai_chat_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT)');
    await seed(alice.id, 'alice');
    await seed(bob.id, 'bob');
    await db.run(`INSERT INTO ai_chat_sessions (user_id, title) VALUES (?, 'alice chat'), (?, 'bob chat')`, [alice.id, bob.id]);
    at = token();
  });
  afterAll(() => ctx.close());

  test('auth is required', async () => {
    expect((await ctx.request.get('/api/vault/meta')).status).toBe(401);
  });

  test('meta before setup: no vault, legacy rows counted', async () => {
    const r = await ctx.request.get('/api/vault/meta').set(auth(alice.token));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ state: 'none', version: null, kdf: 'legacy', salt: null, hasPassword: true });
    const c = await countsOf(alice.id);
    expect(r.body.legacyRows).toBe(Object.values(c).reduce((a, b) => a + b, 0));
    expect(r.body.legacyRows).toBeGreaterThan(15);
    expect((await ctx.request.get('/api/vault/blob').set(auth(alice.token))).status).toBe(404);
    const put = await ctx.request.put('/api/vault/blob').set(auth(alice.token)).set('If-Match', '0')
      .set('Content-Type', 'application/octet-stream').send(Buffer.concat([Buffer.from('FMV1'), crypto.randomBytes(40)]));
    expect(put.status).toBe(404);
  });

  test('legacy-export returns the seeded rows, decrypts AI keys, strips bank tokens', async () => {
    const r = await ctx.request.get('/api/vault/legacy-export').set(auth(alice.token));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.schema).toBe(1);
    expect(r.body.user).toMatchObject({ id: alice.id, email: 'alice@example.com' });
    expect(r.body.user.password).toBeUndefined();
    const t = r.body.tables;
    const { VAULT_TABLES } = require('../lib/vaultTables');
    expect(Object.keys(t)).toEqual(VAULT_TABLES.map((x) => x.name));
    expect(t.transactions.map((x) => x.description)).toEqual(['alice coffee', 'pay']);
    expect(t.transaction_tags).toHaveLength(1);
    expect(t.split_shares).toHaveLength(1);
    expect(t.ai_messages[0].content).toBe('how much did I spend');
    expect(t.ai_chat_sessions.map((x) => x.title)).toEqual(['alice chat']);
    expect(t.user_ai_keys[0].key_plain).toBe('sk-alice-abcd');
    expect(t.bank_connections[0].access_token).toBeNull();
    expect(JSON.stringify(t)).not.toContain('bob');
    const c = await countsOf(alice.id);
    for (const [name, rows] of Object.entries(t)) expect(rows.length).toBe(c[name]);
  });

  test('setup: wrong password refused, plaintext blob refused', async () => {
    const { body } = await setupBody(alice.id, { auth_token: at, current_password: 'nope' });
    let r = await ctx.request.post('/api/vault/setup').set(auth(alice.token)).send(body);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('wrong_password');
    r = await ctx.request.post('/api/vault/setup').set(auth(alice.token))
      .send({ ...body, current_password: 'alice-pass-1', blob_b64: Buffer.from('SQLite format 3\0........................').toString('base64') });
    expect(r.body.code).toBe('NOT_ENCRYPTED');
    r = await ctx.request.post('/api/vault/setup').set(auth(alice.token)).send({ ...body, current_password: 'alice-pass-1', auth_token: 'alice-pass-1' });
    expect(r.body.code).toBe('BAD_AUTH_TOKEN');
    r = await ctx.request.post('/api/vault/setup').set(auth(alice.token))
      .send({ ...body, current_password: 'alice-pass-1', kdf_params: { alg: 'argon2id', m: 1024, t: 1, p: 1, len: 32 } });
    expect(r.body.code).toBe('BAD_PARAMS');
    expect(await db.get('SELECT 1 FROM user_vaults WHERE user_id = ?', [alice.id])).toBeUndefined();
  });

  test('setup switches login from the raw password to the authToken', async () => {
    const s = await setupBody(alice.id, { auth_token: at, current_password: 'alice-pass-1' });
    setupV = s;
    const r = await ctx.request.post('/api/vault/setup').set(auth(alice.token)).send(s.body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, state: 'none' });
    expect((await login('alice', 'alice-pass-1')).status).toBe(401);
    const ok = await login('alice@example.com', at);
    expect(ok.status).toBe(200);
    // other sessions survive: the password did not change, only its form
    expect((await ctx.request.get('/api/vault/meta').set(auth(alice.token))).status).toBe(200);

    const meta = (await ctx.request.get('/api/vault/meta').set(auth(alice.token))).body;
    expect(meta).toMatchObject({ state: 'none', version: 1, size: s.v.blob.length, kdf: 'fm1', salt: s.body.kdf_salt,
      params: C.DEFAULT_PARAMS, wrapped_pw: s.v.wrapped_pw, wrapped_rc: s.v.wrapped_rc });
    expect((await ctx.request.post('/api/auth/prelogin').send({ username: 'alice' })).body)
      .toEqual({ kdf: 'fm1', salt: s.body.kdf_salt, params: C.DEFAULT_PARAMS });
    const again = await ctx.request.post('/api/vault/setup').set(auth(alice.token)).send({ ...s.body, auth_token: at });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('VAULT_EXISTS');
    const me = await ctx.request.get('/api/auth/me').set(auth(alice.token));
    expect(me.body).toMatchObject({ kdf: 'fm1', vault_state: 'none', vault_version: 1 });
  });

  test('blob: GET bytes, PUT needs If-Match, version conflict is 409, one vault_sync a day', async () => {
    const g = await ctx.request.get('/api/vault/blob').set(auth(alice.token))
      .buffer(true).parse((res, cb) => { const ch = []; res.on('data', (d) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(g.status).toBe(200);
    expect(g.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(g.headers['x-vault-version']).toBe('1');
    expect(g.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(g.body, setupV.v.blob)).toBe(0);
    const back = await C.decryptVault(setupV.v.vk, new Uint8Array(g.body), alice.id);
    expect(Buffer.from(back).toString()).toContain('SQLite format 3');

    const next = Buffer.from(await C.encryptVault(setupV.v.vk, new Uint8Array(crypto.randomBytes(12 * 1024 * 1024)), alice.id));
    const put = (ver, body = next) => {
      const q = ctx.request.put('/api/vault/blob').set(auth(alice.token)).set('Content-Type', 'application/octet-stream');
      if (ver != null) q.set('If-Match', String(ver));
      return q.send(body);
    };
    expect((await put(null)).status).toBe(428);
    expect((await put(1, Buffer.from('SQLite format 3\0........................'))).body.code).toBe('NOT_ENCRYPTED');
    const p1 = await put(1);
    expect(p1.status).toBe(200); // > 10 MB: the vault parser runs before the global one
    expect(p1.body).toEqual({ version: 2 });
    const p2 = await put(1);
    expect(p2.status).toBe(409);
    expect(p2.body).toMatchObject({ code: 'VERSION_CONFLICT', version: 2 });
    expect((await put('"2"')).body).toEqual({ version: 3 });
    const row = await db.get('SELECT version, size FROM user_vaults WHERE user_id = ?', [alice.id]);
    expect(row).toEqual({ version: 3, size: next.length });
    await require('../services/tracker').flush();
    const ev = await db.query(`SELECT event FROM analytics_events WHERE user_id = ? AND event LIKE 'vault%'`, [alice.id]);
    expect(ev.filter((e) => e.event === 'vault_sync')).toHaveLength(1);
    // the activity journal stays out of /api/vault
    expect(ev.map((e) => e.event)).not.toContain('vault_updated');
  });

  test('purge-legacy refuses on mismatch and deletes everything on match', async () => {
    const counts = await countsOf(alice.id);
    const bobBefore = await countsOf(bob.id);
    const wrong = { ...counts, transactions: counts.transactions - 1 };
    delete wrong.categories;
    let r = await ctx.request.post('/api/vault/purge-legacy').set(auth(alice.token)).send({ counts: wrong });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('COUNT_MISMATCH');
    expect(r.body.server.transactions).toBe(2);
    expect(r.body.client.transactions).toBe(1);
    expect(r.body.client.categories).toBe(0);
    expect(await countsOf(alice.id)).toEqual(counts);
    expect((await ctx.request.post('/api/vault/purge-legacy').set(auth(bob.token)).send({ counts: bobBefore })).body.code).toBe('NO_VAULT');

    r = await ctx.request.post('/api/vault/purge-legacy').set(auth(alice.token)).send({ counts });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('active');
    expect(r.body.deleted).toEqual(counts);
    const after = await countsOf(alice.id);
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    expect(await countsOf(bob.id)).toEqual(bobBefore);
    const exp = (await ctx.request.get('/api/vault/legacy-export').set(auth(alice.token))).body.tables;
    expect(Object.values(exp).every((rows) => rows.length === 0)).toBe(true);
    const meta = (await ctx.request.get('/api/vault/meta').set(auth(alice.token))).body;
    expect(meta).toMatchObject({ state: 'active', legacyRows: 0, version: 3 });
    expect((await db.get('SELECT vault_state FROM users WHERE id = ?', [alice.id])).vault_state).toBe('active');
    expect(require('../services/vault').scheduleVacuum()).toBe(false); // already scheduled by the purge
    require('../services/vault')._resetVacuum();
  });

  test('rewrap: new recovery wrap; password change needs the current token and returns a new JWT', async () => {
    const kek2 = C.randomBytes(32);
    const rc2 = await C.wrap(kek2, setupV.v.vk, C.wrapAad(alice.id, 'rc'));
    let r = await ctx.request.post('/api/vault/rewrap').set(auth(alice.token)).send({ wrapped_rc: rc2 });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeUndefined();
    expect((await db.get('SELECT wrapped_rc FROM user_vaults WHERE user_id = ?', [alice.id])).wrapped_rc).toBe(rc2);

    const pw2 = await C.wrap(C.randomBytes(32), setupV.v.vk, C.wrapAad(alice.id, 'pw'));
    const at2 = token();
    r = await ctx.request.post('/api/vault/rewrap').set(auth(alice.token)).send({ wrapped_pw: pw2 });
    expect(r.body.code).toBe('BAD_AUTH_TOKEN');
    r = await ctx.request.post('/api/vault/rewrap').set(auth(alice.token)).send({ wrapped_pw: pw2, auth_token: at2, current_auth_token: token() });
    expect(r.body.code).toBe('wrong_password');
    r = await ctx.request.post('/api/vault/rewrap').set(auth(alice.token)).send({ auth_token: at2, current_auth_token: at });
    expect(r.body.code).toBe('VAULT_REWRAP_REQUIRED');
    r = await ctx.request.post('/api/vault/rewrap').set(auth(alice.token)).send({ wrapped_pw: pw2, auth_token: at2, current_auth_token: at });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect((await ctx.request.get('/api/vault/meta').set(auth(alice.token))).status).toBe(401); // old JWT revoked
    alice.token = r.body.token;
    const meta = (await ctx.request.get('/api/vault/meta').set(auth(alice.token))).body;
    expect(meta.wrapped_pw).toBe(pw2);
    expect(await bcrypt.compare(at2, (await db.get('SELECT password FROM users WHERE id = ?', [alice.id])).password)).toBe(true);
    at = at2;
  });

  test('PUT /api/auth/me password change of an fm1 vault user carries wrapped_pw', async () => {
    const at3 = token();
    let r = await ctx.request.put('/api/auth/me').set(auth(alice.token)).send({ currentPassword: at, password: at3 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VAULT_REWRAP_REQUIRED');
    r = await ctx.request.put('/api/auth/me').set(auth(alice.token)).send({ currentPassword: at, password: 'raw-password', wrapped_pw: 'w1.x.y' });
    expect(r.body.code).toBe('BAD_AUTH_TOKEN');
    const pw3 = await C.wrap(C.randomBytes(32), setupV.v.vk, C.wrapAad(alice.id, 'pw'));
    r = await ctx.request.put('/api/auth/me').set(auth(alice.token)).send({ currentPassword: at, password: at3, wrapped_pw: pw3 });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    alice.token = r.body.token;
    expect((await db.get('SELECT wrapped_pw FROM user_vaults WHERE user_id = ?', [alice.id])).wrapped_pw).toBe(pw3);
    expect(await bcrypt.compare(at3, (await db.get('SELECT password FROM users WHERE id = ?', [alice.id])).password)).toBe(true);
    at = at3;
  });

  test('jobs leave vault users out of number-based mail and nudges', async () => {
    // bob has transactions and no vault; alice is a vault user.
    const em = require('../services/engagementMail');
    const ids = (await em.candidates()).map((u) => u.id);
    expect(ids).toContain(bob.id);
    expect(ids).not.toContain(alice.id);
    const lc = require('../services/lifecycle');
    const s = await lc.activitySummary(alice.id);
    expect(s.vault).toBe(true);
    expect((await lc.activitySummary(bob.id)).vault).toBe(false);
  });

  test('account deletion removes the vault and grants', async () => {
    await db.run(`INSERT INTO vault_grants (user_id, token_hash, wrapped_vk, label) VALUES (?, ?, 'w1.a.b', 'Claude')`,
      [alice.id, crypto.randomBytes(16).toString('hex')]);
    const r = await ctx.request.delete('/api/auth/me').set(auth(alice.token)).send({ confirm: 'DELETE', password: at });
    expect(r.status).toBe(200);
    expect((await db.get('SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?', [alice.id])).n).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM vault_grants WHERE user_id = ?', [alice.id])).n).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM users WHERE id = ?', [alice.id])).n).toBe(0);
    expect((await countsOf(bob.id)).transactions).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('Google-only account', () => {
  beforeAll(boot);
  afterAll(() => ctx.close());

  test('setup stores salt/params only; the hash is untouched; rewrap of the passphrase wrap needs no token', async () => {
    const g = await mkUser('gina', { google: 'g-123' });
    const before = (await db.get('SELECT password FROM users WHERE id = ?', [g.id])).password;
    const { body, v } = await setupBody(g.id);
    const r = await ctx.request.post('/api/vault/setup').set(auth(g.token)).send(body);
    expect(r.status).toBe(200);
    const row = await db.get('SELECT password, kdf, kdf_salt FROM users WHERE id = ?', [g.id]);
    expect(row).toEqual({ password: before, kdf: 'legacy', kdf_salt: body.kdf_salt });
    // Login scheme untouched: a linked password (if any) still signs in the old way.
    const pre = await ctx.request.post('/api/auth/prelogin').send({ email: g.email });
    expect(pre.body.kdf).toBe('legacy');
    const meta = (await ctx.request.get('/api/vault/meta').set(auth(g.token))).body;
    expect(meta).toMatchObject({ hasPassword: false, version: 1, salt: body.kdf_salt });
    const pw2 = await C.wrap(C.randomBytes(32), v.vk, C.wrapAad(g.id, 'pw'));
    const rw = await ctx.request.post('/api/vault/rewrap').set(auth(g.token)).send({ wrapped_pw: pw2 });
    expect(rw.status).toBe(200);
    expect(rw.body.token).toBeUndefined();
  });
});
