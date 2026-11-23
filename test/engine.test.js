// test/engine.test.js — the Finman Vault engine (engine/, docs/E2E-ENCRYPTION.md §4, §6):
// the server's own routes over one user's sql.js database, built into
// engine/dist/engine.node.cjs (same code as public/js/vault/engine.js).
'use strict';

const path = require('path');
const initSqlJs = require('sql.js');

const ROOT = path.join(__dirname, '..');
let FE;
let SQL;

const USER = { id: 42, email: 'vault-user@example.test', username: 'vaultuser', full_name: 'Vault User', timezone: 'America/Toronto', subscription_tier: 'free' };

async function call(eng, method, url, body, extra = {}) {
  const r = await eng.handle({ method, url, headers: { 'content-type': 'application/json', ...(extra.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body), files: extra.files });
  let json = null;
  if (typeof r.body === 'string') { try { json = JSON.parse(r.body); } catch (_) { json = null; } }
  return { ...r, json };
}

beforeAll(async () => {
  await require('../engine/build').main();
  FE = require(path.join(ROOT, 'engine', 'dist', 'engine.node.cjs'));
  SQL = await initSqlJs();
}, 120000);

describe('FinmanEngine (Node build)', () => {
  let eng;
  let accountId;

  beforeAll(async () => {
    eng = await FE.open({ SQL, bytes: null, user: USER });
  });
  afterAll(() => eng && eng.close());

  test('the user row exists locally and req.user is that row', () => {
    const rows = eng.query('SELECT id, email, password FROM users');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 42, email: USER.email });
    expect(rows[0].password).toBe('!vault-local');
    expect(eng.dirty).toBe(false);
  });

  test('account with opening balance, expense, balance', async () => {
    const a = await call(eng, 'POST', '/api/accounts', { name: 'Chequing', currency: 'CAD', balance: 1000 });
    expect(a.status).toBe(201);
    accountId = a.json.id;
    expect(eng.dirty).toBe(true);
    eng.dirty = false;

    const t = await call(eng, 'POST', '/api/transactions', { accountId, amount: 40.25, type: 'expense', category: 'Groceries', description: 'Market', date: '2026-11-20' });
    expect(t.status).toBe(201);
    expect(t.json.amount).toBe(-40.25);
    expect(eng.dirty).toBe(true);

    const list = await call(eng, 'GET', '/api/accounts');
    expect(list.status).toBe(200);
    const acc = list.json.all.find((x) => x.id === accountId);
    expect(acc.balance).toBe(959.75);
  });

  test('reports and analytics answer from the vault', async () => {
    const overview = await call(eng, 'GET', '/api/analytics/overview?period=month');
    expect(overview.status).toBe(200);
    const cats = await call(eng, 'GET', '/api/analytics/expenses-by-category?startDate=2026-11-01&endDate=2026-11-30');
    expect(cats.status).toBe(200);
    expect(JSON.stringify(cats.json)).toContain('Groceries');
    const types = await call(eng, 'GET', '/api/reports/types');
    expect(types.status).toBe(200);
  });

  test('route params, query strings, 404s and JSON errors', async () => {
    const one = await call(eng, 'GET', `/api/accounts/${accountId}`);
    expect(one.status).toBe(200);
    expect(one.json.name || (one.json.account && one.json.account.name)).toBe('Chequing');
    const tx = await call(eng, 'GET', `/api/transactions?accountId=${accountId}&limit=10`);
    expect(tx.status).toBe(200);
    const missing = await call(eng, 'GET', '/api/accounts/99999');
    expect(missing.status).toBe(404);
    const unknown = await call(eng, 'GET', '/api/accounts/1/nothing-here');
    expect(unknown.status).toBe(404);
    const bad = await eng.handle({ method: 'POST', url: '/api/accounts', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(bad.status).toBe(400);
  });

  test('CSV statement import through /api/bank-api/import (preview + commit)', async () => {
    const csv = 'Date,Description,Amount\n2026-11-10,COFFEE SHOP,-4.50\n2026-11-11,PAYROLL ACME,2500.00\n2026-11-12,GROCERY MART,-62.10\n';
    const prev = await eng.handle({
      method: 'POST',
      url: '/api/bank-api/import/preview',
      headers: {},
      body: { accountId: String(accountId) },
      files: [{ fieldname: 'file', originalname: 'statement.csv', mimetype: 'text/csv', buffer: new TextEncoder().encode(csv) }],
    });
    expect(prev.status).toBe(200);
    const p = JSON.parse(prev.body);
    expect(p.success).toBe(true);
    expect(p.rows.length).toBe(3);

    const rows = p.rows.map((r) => ({ date: r.date, description: r.description, amount: r.amount, category: r.category, type: r.type }));
    const commit = await call(eng, 'POST', '/api/bank-api/import/commit', { accountId, rows });
    expect(commit.status).toBe(200);
    expect(commit.json.inserted).toBe(3);

    // Re-import of the same statement is deduplicated.
    const again = await call(eng, 'POST', '/api/bank-api/import/commit', { accountId, rows });
    expect(again.json.inserted).toBe(0);

    const acc = await call(eng, 'GET', `/api/accounts/${accountId}`);
    const bal = acc.json.balance !== undefined ? acc.json.balance : acc.json.account.balance;
    expect(bal).toBeCloseTo(959.75 - 4.5 + 2500 - 62.1, 2);
  });

  test('a file the import does not accept is refused like multer would', async () => {
    const r = await eng.handle({ method: 'POST', url: '/api/bank-api/import/preview', body: {}, files: [{ fieldname: 'file', originalname: 'x.exe', buffer: new Uint8Array([1, 2]) }] });
    expect(r.status).toBe(400);
  });

  test('live bank connections and sync answer "not available"', async () => {
    const c = await call(eng, 'POST', '/api/bank-api/connect/monobank/direct', { token: 'x' });
    expect(c.status).toBe(409);
    expect(c.json.code).toBe('VAULT_UNAVAILABLE');
    const s = await call(eng, 'POST', '/api/sync/run');
    expect(s.status).toBe(200);
    expect(s.json.data.available).toBe(false);
  });

  test('server AI without an own key -> AI_KEY_REQUIRED', async () => {
    const r = await call(eng, 'POST', '/api/ai/chat', { message: 'How much did I spend?' });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('AI_KEY_REQUIRED');
  });

  test('own AI key: providers are called with browser fetch (Anthropic header), key kept with vault prefix', async () => {
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const ok = (obj) => ({ status: 200, text: async () => JSON.stringify(obj) });
      if (url.endsWith('/v1/models?limit=100')) return ok({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet' }] });
      if (url.endsWith('/v1/messages')) return ok({ content: [{ type: 'text', text: 'You spent 106.85 CAD.' }], usage: { input_tokens: 10, output_tokens: 5 } });
      return { status: 404, text: async () => '{}' };
    };
    try {
      const add = await call(eng, 'POST', '/api/ai/my/keys', { provider: 'anthropic', key: 'sk-ant-test-1234567890' });
      expect(add.status).toBe(201);
      expect(add.json.key.key_mask).toBe('••••7890');
      const stored = eng.query('SELECT key_enc FROM user_ai_keys')[0].key_enc;
      expect(stored).toBe('vault:sk-ant-test-1234567890');
      expect(calls[0].init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');

      const chat = await call(eng, 'POST', '/api/ai/my/chat', { message: 'How much did I spend?' });
      expect(chat.status).toBe(200);
      expect(JSON.stringify(chat.json)).toContain('106.85');

      // The operator AI route now runs on the same own key.
      const cfo = await call(eng, 'POST', '/api/ai/chat', { message: 'hello' });
      expect(cfo.status).toBe(200);
      expect(calls.every((c) => c.url.startsWith('https://api.anthropic.com/'))).toBe(true);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('MCP tools run on vault data', async () => {
    expect(FE.MCP_LOCAL_TOOLS).toEqual(expect.arrayContaining(['list_accounts', 'add_transaction']));
    expect(eng.mcpListTools().map((t) => t.name)).toEqual(expect.arrayContaining(FE.MCP_LOCAL_TOOLS));
    const r = await eng.mcpCallTool('list_accounts', {});
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('Chequing');
    // Invoices live in the vault since 23.11.2026: their tools run locally too.
    expect((await eng.mcpCallTool('list_invoices', {})).isError).toBeFalsy();
    await expect(eng.mcpCallTool('no_such_tool', {})).rejects.toMatchObject({ code: 'NOT_LOCAL_TOOL' });
  });

  test('export -> reopen from bytes keeps the data', async () => {
    const bytes = eng.export();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes.slice(0, 15)).toString()).toBe('SQLite format 3');
    const again = await FE.open({ SQL, bytes, user: { ...USER, full_name: 'Renamed' } });
    try {
      const list = await call(again, 'GET', '/api/accounts');
      expect(list.json.all.map((a) => a.name)).toEqual(['Chequing']);
      expect(again.counts()).toEqual(eng.counts());
      expect(again.query('SELECT full_name FROM users')[0].full_name).toBe('Renamed');
      // export() re-opens the sql.js DB: foreign keys must still be enforced afterwards.
      expect(eng.query('PRAGMA foreign_keys')[0].foreign_keys).toBe(1);
    } finally {
      again.close();
    }
  });
});

describe('isLocal', () => {
  test('server-only and local endpoints', () => {
    expect(FE.isLocal('GET', '/api/auth/me')).toBe(false);
    for (const p of ['/api/billing/status', '/api/vault/meta', '/api/v1/transactions', '/api/invoice-links', '/api/invoice-shares/abc', '/api/invoices/shared/abc', '/api/health', '/api/t/event', '/api/engagement/push/subscribe', '/api/engagement/referral', '/api/currency/rates', '/api/currency/convert?amount=1&from=USD&to=CAD', '/oauth/token', '/mcp']) {
      expect([p, FE.isLocal('GET', p)]).toEqual([p, false]);
    }
    for (const p of ['/api/accounts', '/api/transactions/5', '/api/bank-api/import/preview', '/api/currency/settings', '/api/currency/tags', '/api/engagement/journey', '/api/engagement/tips', '/api/ai/my/keys', '/api/ai/chat', '/api/reports/types', '/api/sync/status', '/api/accounts?x=1']) {
      expect([p, FE.isLocal('GET', p)]).toEqual([p, true]);
    }
  });
});

describe('importLegacy + counts', () => {
  test('rows go in as-is (ids kept, FKs off) and counts match per table', async () => {
    const eng = await FE.open({ SQL, bytes: null, user: { id: 9, email: 'legacy@example.test', username: 'legacy' } });
    try {
      const tables = {
        accounts: [{ id: 501, user_id: 9, name: 'Old savings', currency: 'USD', balance: 300, account_type: 'savings', is_active: 1 }],
        transactions: [
          { id: 9001, account_id: 501, user_id: 9, date: '2026-10-01', description: 'Opening', category: 'Opening balance', amount: 300, type: 'opening' },
          { id: 9002, account_id: 501, user_id: 9, date: '2026-10-05', description: 'Gift', category: 'Gifts', amount: -20, type: 'expense' },
        ],
        family_members: [{ id: 3, family_id: 777, user_id: 9, role: 'member' }], // family 777 is not in the vault
        budgets: [],
        receipts: [{ id: 70, user_id: 9, image_data: 'data:image/png;base64,AA==', ocr_status: 'failed', notes: 'blob', raw_bytes: { $b64: Buffer.from([1, 2, 3]).toString('base64') } }],
        user_ai_keys: [{ id: 4, user_id: 9, provider: 'openai', key_enc: 'aa:bb:cc', key_plain: 'sk-legacy-plain-key-1234', key_hint: '1234', model: 'gpt-5-mini', is_default: 1 }],
        ai_chat_sessions: [{ id: 1, user_id: 9, title: 'old chat', payload: { $b64: Buffer.from('hi').toString('base64') } }],
        not_a_table: [{ a: 1 }],
      };
      const r = eng.importLegacy({ tables, user: { full_name: 'Legacy Person' } });
      expect(r.counts).toMatchObject({ accounts: 1, transactions: 2, family_members: 1, budgets: 0, receipts: 1, user_ai_keys: 1, ai_chat_sessions: 1 });
      expect(eng.query('SELECT key_enc FROM user_ai_keys')[0].key_enc).toBe('vault:sk-legacy-plain-key-1234');
      const blob = eng.query('SELECT payload FROM ai_chat_sessions')[0].payload;
      expect(blob).toBeInstanceOf(Uint8Array);
      expect(blob.constructor).toBe(Uint8Array);
      expect(Buffer.from(blob).toString()).toBe('hi');
      expect(r.skipped).toEqual({ not_a_table: 1 });
      expect(eng.dirty).toBe(true);
      const c = eng.counts();
      expect(c.accounts).toBe(1);
      expect(c.transactions).toBe(2);
      expect(c.family_members).toBe(1);
      expect(c.ai_chat_sessions).toBe(1);
      expect(c.onboarding_progress).toBe(0);
      expect(Object.keys(c)).toEqual(FE.VAULT_TABLES);
      const tx = await call(eng, 'GET', '/api/transactions/9002');
      expect(tx.status).toBe(200);
      expect(eng.query('SELECT full_name FROM users WHERE id = 9')[0].full_name).toBe('Legacy Person');

      // Round trip through export.
      const again = await FE.open({ SQL, bytes: eng.export(), user: { id: 9, email: 'legacy@example.test' } });
      expect(again.counts()).toEqual(c);
      again.close();
    } finally {
      eng.close();
    }
  });

  test('two engines in one process stay isolated', async () => {
    const a = await FE.open({ SQL, user: { id: 1, email: 'a@example.test' } });
    const b = await FE.open({ SQL, user: { id: 2, email: 'b@example.test' } });
    try {
      await Promise.all([
        call(a, 'POST', '/api/accounts', { name: 'A1', balance: 1 }),
        call(b, 'POST', '/api/accounts', { name: 'B1', balance: 2 }),
        call(a, 'POST', '/api/accounts', { name: 'A2', balance: 3 }),
      ]);
      expect(a.query('SELECT name FROM accounts ORDER BY id').map((r) => r.name)).toEqual(['A1', 'A2']);
      expect(b.query('SELECT name FROM accounts').map((r) => r.name)).toEqual(['B1']);
    } finally {
      a.close();
      b.close();
    }
  });
});
