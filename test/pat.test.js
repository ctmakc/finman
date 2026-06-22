// test/pat.test.js — Personal Access Tokens service (публичный REST API).
//
// apiV1.js — НОВЫЙ, ещё не смонтированный роутер, поэтому тестируем СЕРВИСНЫЙ
// слой напрямую против БД харнеса makeApp() (миграция 013 применяется в
// initDatabase). require('../services/patService') ВНУТРИ тестов — после
// makeApp(), т.к. харнес делает jest.resetModules() и сервис должен биндиться
// к свежей БД.

const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

describe('patService (Personal Access Tokens)', () => {
  let ctx;
  let patService;

  beforeAll(async () => {
    ctx = await makeApp();
    patService = require('../services/patService');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('migration 013 created personal_access_tokens table', async () => {
    const row = await dbGet(
      ctx.db,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='personal_access_tokens'`
    );
    expect(row).toBeTruthy();
    expect(row.name).toBe('personal_access_tokens');
  });

  test('create returns plaintext token ONCE with expected prefix + shape', async () => {
    const created = await patService.create(ctx.userId, 'My CI token');
    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe('My CI token');
    expect(typeof created.token).toBe('string');
    expect(created.token.startsWith('finman_pat_')).toBe(true);
    expect(created.token.length).toBeGreaterThan('finman_pat_'.length + 40);
  });

  test('plaintext is NOT stored — DB holds only a hash', async () => {
    const created = await patService.create(ctx.userId, 'hash-check');
    const row = await dbGet(
      ctx.db,
      `SELECT token_hash FROM personal_access_tokens WHERE id = ?`,
      [created.id]
    );
    expect(row).toBeTruthy();
    // В БД лежит sha-256 hex (64 символа), не сам plaintext.
    expect(row.token_hash).not.toBe(created.token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_hash).toBe(patService.hashToken(created.token));
  });

  test('create -> verify roundtrip returns the owning userId', async () => {
    const created = await patService.create(ctx.userId, 'roundtrip');
    const uid = await patService.verify(created.token);
    expect(Number(uid)).toBe(Number(ctx.userId));
  });

  test('verify updates last_used_at', async () => {
    const created = await patService.create(ctx.userId, 'last-used');
    let row = await dbGet(
      ctx.db,
      `SELECT last_used_at FROM personal_access_tokens WHERE id = ?`,
      [created.id]
    );
    expect(row.last_used_at == null).toBe(true);
    await patService.verify(created.token);
    row = await dbGet(
      ctx.db,
      `SELECT last_used_at FROM personal_access_tokens WHERE id = ?`,
      [created.id]
    );
    expect(row.last_used_at).toBeTruthy();
  });

  test('wrong / malformed token -> null (no throw)', async () => {
    expect(await patService.verify('finman_pat_deadbeefdeadbeefdeadbeef')).toBeNull();
    expect(await patService.verify('not-a-finman-token')).toBeNull();
    expect(await patService.verify('')).toBeNull();
    expect(await patService.verify(null)).toBeNull();
    expect(await patService.verify(undefined)).toBeNull();
  });

  test('revoke invalidates the token; verify then returns null', async () => {
    const created = await patService.create(ctx.userId, 'to-revoke');
    expect(Number(await patService.verify(created.token))).toBe(Number(ctx.userId));
    const ok = await patService.revoke(ctx.userId, created.id);
    expect(ok).toBe(true);
    expect(await patService.verify(created.token)).toBeNull();
  });

  test('revoke is scoped to owner — cannot revoke another user\'s token', async () => {
    const other = await dbRun(
      ctx.db,
      `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
      ['other', 'other@example.com', 'x', 'Other']
    );
    const created = await patService.create(other.id, 'foreign');
    // Текущий пользователь не может отозвать чужой токен.
    const revokedByWrong = await patService.revoke(ctx.userId, created.id);
    expect(revokedByWrong).toBe(false);
    // Токен всё ещё валиден и принадлежит other.
    expect(Number(await patService.verify(created.token))).toBe(Number(other.id));
  });

  test('revoke of a non-existent token returns false', async () => {
    const ok = await patService.revoke(ctx.userId, 99999999);
    expect(ok).toBe(false);
  });

  test('list returns owner tokens without plaintext/hash', async () => {
    const fresh = await dbRun(
      ctx.db,
      `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
      ['listowner', 'list@example.com', 'x', 'List Owner']
    );
    await patService.create(fresh.id, 'alpha');
    await patService.create(fresh.id, 'beta');
    const tokens = await patService.list(fresh.id);
    expect(tokens.length).toBe(2);
    for (const t of tokens) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('createdAt');
      expect(t).toHaveProperty('lastUsedAt');
      expect(t).not.toHaveProperty('token');
      expect(t).not.toHaveProperty('token_hash');
    }
    const names = tokens.map((t) => t.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  test('create rejects empty/blank name', async () => {
    await expect(patService.create(ctx.userId, '')).rejects.toThrow();
    await expect(patService.create(ctx.userId, '   ')).rejects.toThrow();
  });

  test('distinct tokens hash differently and verify to their own owner', async () => {
    const u1 = await dbRun(
      ctx.db,
      `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
      ['multi1', 'm1@example.com', 'x', 'M1']
    );
    const u2 = await dbRun(
      ctx.db,
      `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
      ['multi2', 'm2@example.com', 'x', 'M2']
    );
    const t1 = await patService.create(u1.id, 't1');
    const t2 = await patService.create(u2.id, 't2');
    expect(t1.token).not.toBe(t2.token);
    expect(Number(await patService.verify(t1.token))).toBe(Number(u1.id));
    expect(Number(await patService.verify(t2.token))).toBe(Number(u2.id));
  });
});
