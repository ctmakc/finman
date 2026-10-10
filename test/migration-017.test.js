// test/migration-017.test.js — migration 017 (prod parity: organizations,
// invites, ai_insights, users.google_id/avatar_url/org_id, 16 indexes).
//
// Two starting points must converge:
//   (a) a FRESH database: wave2 initDatabase() + all migrations;
//   (b) a database shaped by PRODUCTION's db/database.js (fixture
//       test/fixtures/prod_schema.sql, captured from the app.finman.money
//       lineage) holding one prod-style user, then wave2 initDatabase().
// Both must finish without errors and end with the same tables, the same
// columns per table and the same indexes. Known, documented exclusions:
//   - prod's legacy `ai_chat_sessions` stays in (b) (wave2 keeps chat in
//     ai_conversations/ai_messages; migration 017 does not create or drop it);
//   - column ORDER and CREATE-time DEFAULT values (prod 'USD', wave2 'UAH')
//     cannot be changed by an additive migration and are not compared.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-fixed';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-fixed';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const PROJECT_ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'prod_schema.sql');
const migration017 = require(path.join(PROJECT_ROOT, 'migrations', '017_org_google_indexes.js'));

const LEGACY_PROD_ONLY_TABLES = new Set(['ai_chat_sessions']);

function tmpDbPath() {
  return path.join(os.tmpdir(), `finman-m017-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
}

// Raw sqlite3 helpers (independent from the app's db module).
function rawOpen(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(db)));
  });
}
function rawExec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve())));
}
function rawRun(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); })
  );
}
function rawAll(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}
function rawClose(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

// Boot the APP's database module against `file` (fresh module registry each time).
async function bootApp(file) {
  process.env.DATABASE_PATH = file;
  jest.resetModules();
  require(path.join(PROJECT_ROOT, 'config', 'config.js'));
  const database = require(path.join(PROJECT_ROOT, 'db', 'database.js'));
  const migrate = require(path.join(PROJECT_ROOT, 'lib', 'migrate.js'));
  await database.initDatabase();
  return { database, migrate };
}

// Snapshot: { tables: Set, columns: {table: sorted names}, indexes: Set }.
async function snapshot(db) {
  const rows = await rawAll(
    db,
    `SELECT type, name, tbl_name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
  );
  const tables = rows.filter((r) => r.type === 'table').map((r) => r.name);
  const indexes = rows.filter((r) => r.type === 'index').map((r) => r.name);
  const columns = {};
  for (const t of tables) {
    const cols = await rawAll(db, `PRAGMA table_info(${t})`);
    columns[t] = cols.map((c) => c.name).sort();
  }
  return { tables: new Set(tables), columns, indexes: new Set(indexes) };
}

const created = [];
afterAll(() => {
  for (const f of created) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(f + suffix); } catch (e) { /* ignore */ }
    }
  }
});

describe('migration 017 — org/google/indexes parity', () => {
  let fresh; // snapshot (a)
  let onProd; // snapshot (b)
  let prodFile;

  beforeAll(async () => {
    // (a) fresh DB
    const freshFile = tmpDbPath();
    created.push(freshFile);
    const a = await bootApp(freshFile);
    await a.database.closeDatabase();
    const dbA = await rawOpen(freshFile);
    fresh = await snapshot(dbA);
    await rawClose(dbA);

    // (b) prod-shaped DB + one prod-style user, then wave2 init
    prodFile = tmpDbPath();
    created.push(prodFile);
    const seed = await rawOpen(prodFile);
    await rawExec(seed, fs.readFileSync(FIXTURE, 'utf8'));
    await rawRun(
      seed,
      `INSERT INTO users (username, email, password, full_name, google_id, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['produser', 'prod@example.com', 'hash', 'Prod User', 'g-123', 'https://x/avatar.png']
    );
    await rawClose(seed);

    const b = await bootApp(prodFile);
    // second run must be a no-op (nothing left to apply)
    const again = await b.migrate.runMigrations();
    expect(again).toEqual([]);
    await b.database.closeDatabase();
    const dbB = await rawOpen(prodFile);
    onProd = await snapshot(dbB);
    await rawClose(dbB);
  }, 60000);

  test('fresh DB: migration 017 recorded once and creates every object', async () => {
    const dbA = await rawOpen(created[0]);
    const rows = await rawAll(dbA, `SELECT name FROM schema_migrations WHERE name = ?`, ['017_org_google_indexes']);
    await rawClose(dbA);
    expect(rows).toHaveLength(1);

    for (const t of ['organizations', 'organization_members', 'invites', 'ai_insights']) {
      expect(fresh.tables.has(t)).toBe(true);
    }
    for (const c of ['google_id', 'avatar_url', 'org_id']) {
      expect(fresh.columns.users).toContain(c);
    }
    expect(fresh.indexes.has('idx_users_google_id')).toBe(true);
    for (const idx of migration017.PERF_INDEX_NAMES) {
      expect(fresh.indexes.has(idx)).toBe(true);
    }
    expect(migration017.PERF_INDEX_NAMES).toHaveLength(15);
  });

  test('prod-shaped DB converges to the same tables (modulo legacy ai_chat_sessions)', () => {
    const tablesB = new Set([...onProd.tables].filter((t) => !LEGACY_PROD_ONLY_TABLES.has(t)));
    expect([...tablesB].sort()).toEqual([...fresh.tables].sort());
  });

  test('prod-shaped DB converges to the same columns per table', () => {
    for (const t of fresh.tables) {
      expect(onProd.columns[t]).toEqual(fresh.columns[t]);
    }
  });

  test('prod-shaped DB converges to the same indexes', () => {
    expect([...onProd.indexes].sort()).toEqual([...fresh.indexes].sort());
  });

  test('prod user row survives: google_id kept, wave2 columns back-filled', async () => {
    const db = await rawOpen(prodFile);
    const rows = await rawAll(db, `SELECT username, email, google_id, avatar_url, org_id, subscription_tier FROM users`);
    await rawClose(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'produser',
      email: 'prod@example.com',
      google_id: 'g-123',
      avatar_url: 'https://x/avatar.png',
      org_id: null,
      subscription_tier: 'free',
    });
  });

  test('idx_users_google_id is a partial UNIQUE index (NULLs free, ids unique)', async () => {
    const db = await rawOpen(created[0]);
    await rawRun(db, `INSERT INTO users (username, email, password) VALUES ('u1', 'u1@x', 'p')`);
    await rawRun(db, `INSERT INTO users (username, email, password) VALUES ('u2', 'u2@x', 'p')`); // two NULL google_id
    await rawRun(db, `INSERT INTO users (username, email, password, google_id) VALUES ('u3', 'u3@x', 'p', 'dup')`);
    await expect(
      rawRun(db, `INSERT INTO users (username, email, password, google_id) VALUES ('u4', 'u4@x', 'p', 'dup')`)
    ).rejects.toThrow(/UNIQUE/);
    await rawClose(db);
  });

  test('organizations tables accept rows with the prod constraints', async () => {
    const db = await rawOpen(created[0]);
    await rawExec(db, 'PRAGMA foreign_keys = ON');
    const org = await rawRun(db, `INSERT INTO organizations (name, slug) VALUES ('Acme', 'acme')`);
    await expect(
      rawRun(db, `INSERT INTO organizations (name, slug) VALUES ('Acme 2', 'acme')`)
    ).rejects.toThrow(/UNIQUE/);
    const u = await rawRun(db, `INSERT INTO users (username, email, password) VALUES ('o1', 'o1@x', 'p')`);
    await rawRun(db, `INSERT INTO organization_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, [org.lastID, u.lastID]);
    await expect(
      rawRun(db, `INSERT INTO organization_members (org_id, user_id) VALUES (?, ?)`, [org.lastID, u.lastID])
    ).rejects.toThrow(/UNIQUE/);
    await rawRun(
      db,
      `INSERT INTO ai_insights (org_id, user_id, period, type, content) VALUES (?, ?, '2026-10', 'monthly_story', 'x')`,
      [org.lastID, u.lastID]
    );
    await expect(
      rawRun(
        db,
        `INSERT INTO ai_insights (org_id, user_id, period, type, content) VALUES (?, ?, '2026-10', 'monthly_story', 'y')`,
        [org.lastID, u.lastID]
      )
    ).rejects.toThrow(/UNIQUE/);
    await rawClose(db);
  });
});
