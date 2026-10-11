// test/demo-seed.test.js — DEMO_SEED_ON_EMPTY: the staging demo household.
//
// Contract (lib/demoSeed.js, server.js boot hook, routes/health.js):
//  - boot with DEMO_SEED_ON_EMPTY=1 on an empty DB -> demo user + partner exist,
//    every account balance equals opening + sum of its transactions, analytics
//    income/expense exclude the opening rows, /api/health reports seeded_at;
//  - a second boot on the same DB seeds nothing;
//  - boot without the flag -> no users at all.
// The in-process tests exercise the seed through fresh modules on a temp DB;
// the last test spawns the real `node server.js` to prove the boot wiring.

const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-fixed';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-fixed';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
// Cheap hashes: the seed creates two users per boot and the suite boots several times.
process.env.BCRYPT_ROUNDS = '4';

const ROOT = path.join(__dirname, '..');
const silent = { info() {}, warn() {}, error() {} };

function tmpDbPath() {
  return path.join(os.tmpdir(), `finman-demo-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
}

// Fresh module registry bound to a new temp DB (same trick as test/helpers/app.js).
async function freshDb(dbFile) {
  process.env.DATABASE_PATH = dbFile;
  jest.resetModules();
  const database = require(path.join(ROOT, 'db', 'database.js'));
  await database.initDatabase();
  return database;
}

function rm(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch (e) {
      /* ignore */
    }
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('DEMO_SEED_ON_EMPTY — in-process seed', () => {
  let database;
  let dbFile;

  beforeAll(async () => {
    process.env.DEMO_SEED_ON_EMPTY = '1';
    delete process.env.DEMO_MODE;
    delete process.env.DEMO_PASSWORD;
    dbFile = tmpDbPath();
    database = await freshDb(dbFile);
  });

  afterAll(async () => {
    delete process.env.DEMO_SEED_ON_EMPTY;
    delete process.env.DEMO_MODE;
    try {
      await database.closeDatabase();
    } catch (e) {
      /* ignore */
    }
    rm(dbFile);
  });

  test('bootHook seeds the household once; a second call is a no-op', async () => {
    const demoSeed = require(path.join(ROOT, 'lib', 'demoSeed.js'));
    const first = await demoSeed.bootHook(silent);
    expect(first.seeded).toBe(true);
    expect(first.counts.transactions).toBeGreaterThanOrEqual(170);
    expect(first.counts.transfers).toBe(2);
    expect(demoSeed.getState().outcome).toBe('seeded');
    expect(demoSeed.getState().seededAt).toBeTruthy();

    const users = await database.query('SELECT username, email FROM users ORDER BY id');
    expect(users.map((u) => u.username)).toEqual(['demo', 'demo-partner']);
    expect(users[0].email).toBe('demo@finman.money');

    const second = await demoSeed.bootHook(silent);
    expect(second.seeded).toBe(false);
    expect(second.reason).toBe('users_exist');
    const again = await database.get('SELECT COUNT(*) AS n FROM users');
    expect(again.n).toBe(2);
    const txCount = await database.get('SELECT COUNT(*) AS n FROM transactions');
    expect(txCount.n).toBe(first.counts.transactions + 2 * first.counts.transfers + 3 /* openings */ + 6 /* partner */ + 1 /* partner opening */);
  }, 180000); // seeds the household: slow on a loaded shared machine

  test('demo password works through the model layer', async () => {
    const User = require(path.join(ROOT, 'models', 'user.js'));
    const demo = await User.findByUsername('demo');
    expect(demo).toBeTruthy();
    expect(await User.verifyPassword(demo, 'finman-demo-2026')).toBe(true);
    expect(await User.verifyPassword(demo, 'wrong')).toBe(false);
    expect(demo.timezone).toBe('America/Toronto');
  });

  test('three demo accounts; balance = opening + sum(transactions) on every account', async () => {
    const demo = await database.get(`SELECT id FROM users WHERE username = 'demo'`);
    const accounts = await database.query('SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [demo.id]);
    expect(accounts).toHaveLength(3);
    expect(accounts.map((a) => [a.currency, a.account_type])).toEqual([
      ['CAD', 'checking'],
      ['CAD', 'credit'],
      ['USD', 'savings'],
    ]);
    for (const a of accounts) {
      const opening = await database.get(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND type = 'opening'`,
        [a.id]
      );
      const rest = await database.get(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND type != 'opening'`,
        [a.id]
      );
      expect(Math.round(a.balance * 100)).toBe(Math.round((opening.s + rest.s) * 100));
      expect(opening.s).not.toBe(0);
    }
    // Credit card: opening is negative, two transfer legs landed on it.
    const legs = await database.get(
      `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND type = 'transfer'`,
      [accounts[1].id]
    );
    expect(legs.n).toBe(2);
  });

  test('the rest of the household is there', async () => {
    const demo = await database.get(`SELECT id FROM users WHERE username = 'demo'`);
    const count = async (sql, params = [demo.id]) => (await database.get(sql, params)).n;
    expect(await count('SELECT COUNT(*) AS n FROM budgets WHERE user_id = ?')).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM savings_goals WHERE user_id = ?')).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM debts WHERE user_id = ?')).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM debt_payments WHERE debt_id IN (SELECT id FROM debts WHERE user_id = ?)`)).toBe(5);
    expect(await count(`SELECT COUNT(*) AS n FROM investments WHERE portfolio_id IN (SELECT id FROM investment_portfolios WHERE user_id = ?)`)).toBe(3);
    expect(await count('SELECT COUNT(*) AS n FROM recurring_payments WHERE user_id = ?')).toBe(6);
    expect(await count('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?')).toBe(4);
    expect(await count('SELECT COUNT(*) AS n FROM category_rules WHERE user_id = ?')).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM family_members WHERE family_id IN (SELECT id FROM families WHERE owner_id = ?)`)).toBe(2);
    const settings = await database.get('SELECT base_currency FROM user_currency_settings WHERE user_id = ?', [demo.id]);
    expect(settings.base_currency).toBe('CAD');
    // Every payment is linked to a real ledger row with the same amount.
    const unlinked = await count(
      `SELECT COUNT(*) AS n FROM debt_payments p LEFT JOIN transactions t ON t.id = p.transaction_id
       WHERE p.transaction_id IS NULL OR ROUND(ABS(t.amount) - p.amount, 2) != 0`,
      []
    );
    expect(unlinked).toBe(0);
    // Nothing dated in the future.
    const dates = require(path.join(ROOT, 'lib', 'dates.js'));
    const future = await count('SELECT COUNT(*) AS n FROM transactions WHERE date > ?', [dates.todayISO('America/Toronto')]);
    expect(future).toBe(0);
  });

  test('analytics income/expense exclude opening balances; health reports demo + seeded_at', async () => {
    const config = require(path.join(ROOT, 'config', 'config.js'));
    const app = require(path.join(ROOT, 'server.js'));
    const supertest = require('supertest');
    const jwt = require('jsonwebtoken');
    const demo = await database.get(`SELECT id FROM users WHERE username = 'demo'`);
    const token = jwt.sign({ id: demo.id }, config.jwtSecret, { expiresIn: '1h' });

    const sums = await database.get(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) END), 0) AS expense,
         COALESCE(SUM(CASE WHEN type = 'opening' THEN amount END), 0) AS opening
       FROM transactions WHERE user_id = ?`,
      [demo.id]
    );
    expect(sums.opening).not.toBe(0);

    const res = await supertest(app)
      .get('/api/analytics/overview?startDate=2000-01-01&endDate=2099-12-31')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Math.round(res.body.income * 100)).toBe(Math.round(sums.income * 100));
    // /overview returns expense as the signed ledger sum (negative); compare magnitudes.
    expect(Math.round(Math.abs(res.body.expense) * 100)).toBe(Math.round(sums.expense * 100));
    expect(Math.round(res.body.income * 100)).not.toBe(Math.round((sums.income + sums.opening) * 100));

    const health = await supertest(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.data.demo).toBe(false); // DEMO_MODE unset
    expect(health.body.data.seeded_at).toBeTruthy();

    process.env.DEMO_MODE = '1';
    const demoInfo = await supertest(app).get('/api/health/demo');
    expect(demoInfo.status).toBe(200);
    expect(demoInfo.body.data.demo).toBe(true);
    expect(demoInfo.body.data.seed_on_empty).toBe(true);
    expect(demoInfo.body.data.demo_user).toBe('demo');
    expect(demoInfo.body.data.message).toMatch(/Demo instance/);
    delete process.env.DEMO_MODE;
  });

  test('buildPlan is deterministic for a given day and spans six months', () => {
    const demoSeed = require(path.join(ROOT, 'lib', 'demoSeed.js'));
    const a = demoSeed.buildPlan('2026-10-10');
    const b = demoSeed.buildPlan('2026-10-10');
    expect(a.tx).toEqual(b.tx);
    expect(a.start).toBe('2026-04-01');
    expect(a.tx[0].date >= '2026-04-01').toBe(true);
    expect(a.tx[a.tx.length - 1].date <= '2026-10-10').toBe(true);
    // DST boundary month end: still a valid first-of-month.
    expect(demoSeed.buildPlan('2026-03-31').start).toBe('2025-09-01');
  });
});

describe('DEMO_SEED_ON_EMPTY unset — nothing is seeded', () => {
  test('bootHook without the flag leaves the users table empty', async () => {
    delete process.env.DEMO_SEED_ON_EMPTY;
    const dbFile = tmpDbPath();
    const database = await freshDb(dbFile);
    try {
      const demoSeed = require(path.join(ROOT, 'lib', 'demoSeed.js'));
      const r = await demoSeed.bootHook(silent);
      expect(r.seeded).toBe(false);
      expect(r.reason).toBe('disabled');
      const n = await database.get('SELECT COUNT(*) AS n FROM users');
      expect(n.n).toBe(0);
      const info = await demoSeed.seedInfo();
      expect(info.seeded_at).toBeNull();
      expect(info.demo_user).toBeNull();
    } finally {
      await database.closeDatabase();
      rm(dbFile);
    }
  });

  test('seedIfEmpty refuses a database that already has a user', async () => {
    const dbFile = tmpDbPath();
    const database = await freshDb(dbFile);
    try {
      await database.run(`INSERT INTO users (username, email, password) VALUES ('real', 'real@example.com', 'x')`);
      const demoSeed = require(path.join(ROOT, 'lib', 'demoSeed.js'));
      const r = await demoSeed.seedIfEmpty();
      expect(r).toEqual({ seeded: false, reason: 'users_exist', users: 1 });
      const n = await database.get('SELECT COUNT(*) AS n FROM users');
      expect(n.n).toBe(1);
      // seedDemo without --force behaves the same; with force it adds the demo user.
      const r2 = await demoSeed.seedDemo();
      expect(r2.seeded).toBe(false);
      const r3 = await demoSeed.seedDemo({ force: true });
      expect(r3.seeded).toBe(true);
      const r4 = await demoSeed.seedDemo({ force: true });
      expect(r4.reason).toBe('demo_exists');
    } finally {
      await database.closeDatabase();
      rm(dbFile);
    }
  }, 180000); // a full seed (force) takes 25-100s on a loaded shared machine
});

describe('demo seed safety: atomic cleanup + production guard', () => {
  afterEach(() => {
    delete process.env.DEMO_SEED_ON_EMPTY;
    delete process.env.DEMO_SEED_ALLOW_PRODUCTION;
    process.env.NODE_ENV = 'test';
  });

  test('a failure late in the seed removes every demo row; the next boot seeds cleanly', async () => {
    const dbFile = tmpDbPath();
    const database = await freshDb(dbFile);
    try {
      const Family = require(path.join(ROOT, 'models', 'family.js'));
      const orig = Family.joinByCode;
      Family.joinByCode = async () => {
        throw new Error('disk full (simulated)');
      };
      process.env.DEMO_SEED_ON_EMPTY = '1';
      const demoSeed = require(path.join(ROOT, 'lib', 'demoSeed.js'));
      let r;
      try {
        r = await demoSeed.bootHook(silent);
      } finally {
        Family.joinByCode = orig;
      }
      expect(r).toMatchObject({ seeded: false, reason: 'error' });
      expect(r.error).toContain('disk full');

      const tables = await database.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations')`
      );
      for (const { name } of tables) {
        const n = await database.get(`SELECT COUNT(*) AS n FROM "${name}"`);
        expect([name, n.n]).toEqual([name, 0]);
      }
      expect(await database.query('PRAGMA foreign_key_check')).toEqual([]);

      const again = await demoSeed.bootHook(silent);
      expect(again.seeded).toBe(true);
      const users = await database.query('SELECT username FROM users ORDER BY id');
      expect(users.map((u) => u.username)).toEqual(['demo', 'demo-partner']);
    } finally {
      await database.closeDatabase();
      rm(dbFile);
    }
  }, 180000);

  test('NODE_ENV=production refuses DEMO_SEED_ON_EMPTY unless DEMO_SEED_ALLOW_PRODUCTION=1', async () => {
    const dbFile = tmpDbPath();
    const database = await freshDb(dbFile);
    try {
      const demoSeed = require(path.join(ROOT, 'lib', 'demoSeed.js'));
      const flags = require(path.join(ROOT, 'lib', 'demoFlag.js'));
      process.env.DEMO_SEED_ON_EMPTY = '1';
      process.env.NODE_ENV = 'production';
      const warns = [];
      const r = await demoSeed.bootHook({ info() {}, error() {}, warn: (m) => warns.push(m) });
      expect(r).toEqual({ seeded: false, reason: 'production_refused' });
      expect(warns.join(' ')).toContain('DEMO_SEED_ALLOW_PRODUCTION');
      expect(flags.isSeedOnEmpty()).toBe(false);
      expect((await database.get('SELECT COUNT(*) AS n FROM users')).n).toBe(0);

      process.env.DEMO_SEED_ALLOW_PRODUCTION = '1';
      expect(flags.isSeedOnEmpty()).toBe(true);
      process.env.NODE_ENV = 'test';
      const ok = await demoSeed.bootHook(silent);
      expect(ok.seeded).toBe(true);
    } finally {
      await database.closeDatabase();
      rm(dbFile);
    }
  }, 180000);
});

describe('real boot: node server.js with DEMO_SEED_ON_EMPTY=1', () => {
  const dbFile = tmpDbPath();
  const children = [];

  afterAll(async () => {
    for (const c of children) {
      if (c.exitCode === null) c.kill('SIGTERM');
    }
    await sleep(300);
    rm(dbFile);
  });

  async function boot(port) {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        DATABASE_PATH: dbFile,
        DEMO_SEED_ON_EMPTY: '1',
        DEMO_MODE: '1',
        LOG_LEVEL: 'silent',
        AI_PROVIDER: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdout.on('data', (d) => {
      stderr += d.toString();
    });
    const base = `http://127.0.0.1:${port}`;
    let health = null;
    for (let i = 0; i < 600; i += 1) { // up to 150s: the seed is slow on a loaded machine
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) {
          health = (await r.json()).data;
          if (health.seeded_at) break;
        }
      } catch (e) {
        /* not up yet */
      }
      await sleep(250);
    }
    if (!health) throw new Error(`server did not come up: ${stderr.slice(-500)}`);
    if (!health.seeded_at) throw new Error(`seed did not finish: ${stderr.slice(-1500)}`);
    return { child, base, health };
  }

  async function stop(child) {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
  }

  test('first boot seeds; login as demo works; second boot seeds nothing', async () => {
    const { child, base, health } = await boot(await freePort());
    expect(health.demo).toBe(true);
    expect(health.seeded_at).toBeTruthy();

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'finman-demo-2026' }),
    });
    expect(login.status).toBe(200);
    const { token, user } = await login.json();
    expect(user.username).toBe('demo');

    const accounts = await fetch(`${base}/api/accounts?includeShared=false`, { headers: { Authorization: `Bearer ${token}` } });
    expect(accounts.status).toBe(200);
    const body = await accounts.json();
    expect(body.own).toHaveLength(3);

    const seededAt = health.seeded_at;
    await stop(child);

    // Same DB file, second boot: the demo user is still the only household.
    const second = await boot(await freePort());
    expect(second.health.seeded_at).toBe(seededAt);
    const r = await fetch(`${second.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'finman-demo-2026' }),
    });
    const t2 = (await r.json()).token;
    const acc2 = await fetch(`${second.base}/api/accounts?includeShared=false`, { headers: { Authorization: `Bearer ${t2}` } });
    expect((await acc2.json()).own).toHaveLength(3);
    await stop(second.child);

    // Direct count through sqlite: exactly the two demo users.
    const sqlite3 = require('sqlite3');
    const n = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY);
      db.get('SELECT COUNT(*) AS n FROM users', (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row.n);
      });
    });
    expect(n).toBe(2);
  }, 180000);
});
