// test/migration-024.test.js — native app columns + app_auth_handoff.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-fixed';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-fixed';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const ROOT = path.join(__dirname, '..');
const migration = require(path.join(ROOT, 'migrations', '024_native_app.js'));

const files = [];
afterAll(() => {
  for (const f of files) for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + s); } catch (e) { /* ignore */ } }
});

async function boot() {
  const file = path.join(os.tmpdir(), `finman-m024-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
  files.push(file);
  process.env.DATABASE_PATH = file;
  jest.resetModules();
  require(path.join(ROOT, 'config', 'config.js'));
  const database = require(path.join(ROOT, 'db', 'database.js'));
  const migrate = require(path.join(ROOT, 'lib', 'migrate.js'));
  await database.initDatabase();
  return { database, migrate };
}

describe('migration 024 — native app', () => {
  let database;
  let migrate;
  beforeAll(async () => { ({ database, migrate } = await boot()); }, 30000);
  afterAll(async () => { await database.closeDatabase(); });

  test('recorded once, re-run is a no-op', async () => {
    const rows = await database.query(`SELECT name FROM schema_migrations WHERE name = '024_native_app'`);
    expect(rows).toHaveLength(1);
    expect(await migrate.runMigrations()).toEqual([]);
    // up() itself is idempotent too
    await migration.up(database, { columnExists: migrate.columnExists });
  });

  test('users gain apple_id and apple_refresh_token_enc', async () => {
    const cols = (await database.query(`PRAGMA table_info(users)`)).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['apple_id', 'apple_refresh_token_enc']));
  });

  test('apple_id is unique when set, NULL allowed many times', async () => {
    const ins = (u, a) => database.run(
      `INSERT INTO users (username, email, password, apple_id) VALUES (?, ?, 'x', ?)`, [u, `${u}@example.com`, a]
    );
    await ins('m24a', null);
    await ins('m24b', null);
    await ins('m24c', 'apple-sub-1');
    await expect(ins('m24d', 'apple-sub-1')).rejects.toThrow(/UNIQUE/);
  });

  test('app_auth_handoff has the expected shape', async () => {
    const cols = await database.query(`PRAGMA table_info(app_auth_handoff)`);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(['created_at', 'error', 'expires_at', 'nonce_hash', 'token']);
    expect(byName.nonce_hash.pk).toBe(1);
    await database.run(`INSERT INTO app_auth_handoff (nonce_hash, token, expires_at) VALUES ('h1', 't', 1)`);
    await expect(
      database.run(`INSERT INTO app_auth_handoff (nonce_hash, token, expires_at) VALUES ('h1', 't', 1)`)
    ).rejects.toThrow(/UNIQUE|PRIMARY/);
  });
});
