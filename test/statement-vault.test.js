// test/statement-vault.test.js — PDF statements for Finman Vault (encrypted) users.
//
// The server cannot keep their statement task, so:
//   POST /api/statements/read          needs consent=1, returns the reading, writes no task on the
//                                      server; only a 'statement_read' event (no content) for the cap;
//   POST /api/statements/from-reading  (served by the in-browser engine) stores the reading as a task,
//                                      proves the arithmetic again: a reading the server did not prove
//                                      stays unproven; a proven reading with broken rows is refused;
//   the engine treats /api/statements as local and POST /read as remote;
//   statement_tasks belongs to the vault tables.
process.env.STATEMENT_AI_PROVIDER = 'google';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaTestPlatform000000000000000000';
process.env.STATEMENT_PLATFORM_DAILY = '2';
const jwt = require('jsonwebtoken');
const { makeApp } = require('./helpers/app');

let ctx, db, config, ann, agent;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const settle = () => new Promise((r) => setTimeout(r, 60));

const ROWS = [
  { date: '2026-10-02', description: 'GROCERY MART #12', cents: -8450, balance_cents: 91550, page: 1 },
  { date: '2026-10-05', description: 'RENT E-TRANSFER', cents: -120000, balance_cents: -28450, page: 1 },
  { date: '2026-10-15', description: 'PAYROLL DEPOSIT', cents: 265000, balance_cents: 236550, page: 1 },
  { date: '2026-10-20', description: 'NETFLIX.COM', cents: -5600, balance_cents: 230950, page: 1 },
];
function fakeReading(over = {}) {
  const proof = require('../services/statement/proof');
  const meta = { statement_type: 'bank', institution: 'Test Bank', account_last4: '2233', currency: 'CAD',
    period_start: '2026-10-01', period_end: '2026-10-31', opening_cents: 100000, closing_cents: 230950, notes: null };
  const rows = ROWS.map((r) => ({ ...r }));
  const p = proof.prove({ opening_cents: meta.opening_cents, closing_cents: meta.closing_cents, rows, kind: 'bank' });
  return { meta, rows, proof: p, attempts: [{ attempt: 1, status: p.status }], usage: { input: 900, output: 200, calls: 1, provider: 'google', model: 'test' },
    ms: 1200, mode: 'text', pages: 1, sha256: 'a'.repeat(64), ...over };
}

beforeAll(async () => {
  ctx = await makeApp();
  db = require('../db/database');
  config = require('../config/config');
  agent = require('../services/statement/agent');
  const r = await db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', ['ann_v', 'ann_v@example.com', 'x']);
  ann = { id: r.id, token: jwt.sign({ id: r.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
});
afterAll(async () => { jest.restoreAllMocks(); await ctx.close(); });

const PDF = Buffer.from('%PDF-1.4\n% test statement\n');
const readReq = (consent) => {
  const r = ctx.request.post('/api/statements/read').set(auth(ann.token)).attach('file', PDF, 'statement.pdf');
  return consent ? r.field('consent', '1') : r;
};

describe('POST /api/statements/read (server, consent)', () => {
  test('refused without consent; the AI is not called', async () => {
    const spy = jest.spyOn(agent, 'read');
    const r = await readReq(false);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('STATEMENT_CONSENT');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('with consent: returns the reading and stores nothing about the file on the server', async () => {
    const spy = jest.spyOn(agent, 'read').mockResolvedValue(fakeReading());
    const r = await readReq(true);
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ai: { source: 'platform' } }));
    expect(r.body.reading).toMatchObject({ mode: 'text', pages: 1, file_name: 'statement.pdf' });
    expect(r.body.reading.rows).toHaveLength(4);
    await settle();
    expect(await db.query('SELECT id FROM statement_tasks WHERE user_id = ?', [ann.id])).toHaveLength(0);
    const ev = await db.query("SELECT props FROM analytics_events WHERE user_id = ? AND event = 'statement_read'", [ann.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0].props).not.toMatch(/GROCERY|PAYROLL|2233|statement\.pdf/);
    spy.mockRestore();
  });

  test('daily cap per person', async () => {
    const spy = jest.spyOn(agent, 'read').mockResolvedValue(fakeReading());
    expect((await readReq(true)).status).toBe(200); // 2nd of 2
    await settle();
    const r = await readReq(true);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('STATEMENT_DAILY_LIMIT');
    spy.mockRestore();
  });
});

describe('POST /api/statements/from-reading (vault engine)', () => {
  const store = (reading) => ctx.request.post('/api/statements/from-reading').set(auth(ann.token)).send({ reading });

  test('a proven reading becomes an importable task', async () => {
    const r = await store(fakeReading());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'proven', can_import: true, currency: 'CAD', account_last4: '2233' });
    expect(r.body.rows).toHaveLength(4);
  });

  test('a reading marked proven whose rows do not add up is not importable', async () => {
    const bad = fakeReading();
    bad.rows[0].cents = -9999;
    const r = await store(bad);
    expect(r.status).toBe(201);
    expect(r.body.status).not.toBe('proven');
    expect(r.body.can_import).toBe(false);
  });

  test('a reading the server did not prove stays unproven', async () => {
    const gap = fakeReading();
    gap.proof = { ...gap.proof, status: 'gap', line: '1 amount(s) are not printed on their page; nothing is written' };
    const r = await store(gap);
    expect(r.body.status).toBe('gap');
    expect(r.body.can_import).toBe(false);
  });

  test('empty reading is refused', async () => {
    expect((await store({ rows: [] })).status).toBe(400);
  });
});

describe('vault engine routing', () => {
  const routes = require('../engine/routes');
  test('statements are local, the consent read goes to the server', () => {
    expect(routes.isLocal('POST', '/api/statements/from-reading')).toBe(true);
    expect(routes.isLocal('GET', '/api/statements/12')).toBe(true);
    expect(routes.isLocal('POST', '/api/statements/12/commit')).toBe(true);
    expect(routes.isLocal('POST', '/api/statements/read')).toBe(false);
  });
  test('statement_tasks is a vault table', () => {
    const { VAULT_TABLES } = require('../lib/vaultTables');
    expect(VAULT_TABLES.map((t) => t.name)).toContain('statement_tasks');
  });
});
