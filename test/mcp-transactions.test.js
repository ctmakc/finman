// test/mcp-transactions.test.js — MCP: ChatGPT-compatible OAuth (RFC 9207 iss, offline_access,
// open CORS on /mcp), accounts and transactions tools (add / edit / delete / summary),
// shared-account permissions and isolation between accounts.
const crypto = require('crypto');
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes }); });
  });
}
async function makeUser(ctx, username) {
  const jwt = require('jsonwebtoken');
  const config = require('../config/config');
  const ins = await dbRun(ctx.db, 'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)', [username, `${username}@example.com`, 'x', username]);
  return { id: ins.id, token: jwt.sign({ id: ins.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const b64url = (buf) => buf.toString('base64url');
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';

async function connectChatGPT(ctx, userToken) {
  const reg = await ctx.request.post('/oauth/register').send({ client_name: 'ChatGPT', redirect_uris: [CHATGPT] });
  expect(reg.status).toBe(201);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const params = { response_type: 'code', client_id: reg.body.client_id, redirect_uri: CHATGPT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'gpt-1', scope: 'finman offline_access', resource: 'https://app.finman.money/mcp' };
  const check = await ctx.request.get('/api/oauth/authorize/check').query(params);
  expect(check.body).toMatchObject({ ok: true, app: 'ChatGPT', return_host: 'chatgpt.com' });
  const d = await ctx.request.post('/api/oauth/authorize/decision').set(auth(userToken)).send({ params, approve: true });
  const url = new URL(d.body.redirect);
  expect(url.searchParams.get('iss')).toBe('https://app.finman.money');
  const t = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: url.searchParams.get('code'),
    redirect_uri: CHATGPT, client_id: reg.body.client_id, code_verifier: verifier, resource: 'https://app.finman.money/mcp' });
  expect(t.status).toBe(200);
  expect(t.body.refresh_token).toMatch(/^finman_ort_/);
  return t.body.access_token;
}

let rpcId = 0;
async function tool(ctx, token, name, args) {
  const r = await ctx.request.post('/mcp').set(auth(token)).send({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return r.body.result;
}

describe('MCP: ChatGPT compatibility and transactions', () => {
  let ctx; let ann; let bob; let annMcp; let bobMcp; let acc; let usd;
  beforeAll(async () => {
    ctx = await makeApp();
    ann = await makeUser(ctx, 'ann');
    bob = await makeUser(ctx, 'bob');
    const a1 = await ctx.request.post('/api/accounts').set(auth(ann.token)).send({ name: 'Chequing', currency: 'CAD', balance: 1000 });
    const a2 = await ctx.request.post('/api/accounts').set(auth(ann.token)).send({ name: 'Dollars', currency: 'USD', balance: 0 });
    expect(a1.status).toBe(201);
    acc = a1.body.id; usd = a2.body.id;
    annMcp = await connectChatGPT(ctx, ann.token);
    bobMcp = await connectChatGPT(ctx, bob.token);
  });
  afterAll(async () => { await ctx.close(); });

  test('discovery advertises iss and offline_access; /mcp answers any origin', async () => {
    const as = await ctx.request.get('/.well-known/oauth-authorization-server');
    expect(as.body.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.body.scopes_supported).toEqual(expect.arrayContaining(['finman', 'offline_access']));
    expect(as.body.token_endpoint_auth_methods_supported).toContain('none');
    const pr = await ctx.request.get('/.well-known/oauth-protected-resource/mcp');
    expect(pr.body.resource).toBe('https://app.finman.money/mcp');

    const pre = await ctx.request.options('/mcp').set('Origin', 'https://inspector.example').set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type, mcp-protocol-version');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(pre.headers['access-control-allow-headers']).toMatch(/Mcp-Protocol-Version/i);
    const no = await ctx.request.post('/mcp').set('Origin', 'https://inspector.example').send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(no.status).toBe(401);
    expect(no.headers['access-control-expose-headers']).toMatch(/WWW-Authenticate/);
    // The rest of the API keeps the app's own CORS list.
    const api = await ctx.request.get('/api/accounts').set('Origin', 'https://inspector.example');
    expect(api.headers['access-control-allow-origin']).not.toBe('*');
  });

  test('tools/list: transactions tools present, one JSON type per field, every tool annotated', async () => {
    const r = await ctx.request.post('/mcp').set(auth(annMcp)).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const list = r.body.result.tools;
    const names = list.map((t) => t.name);
    for (const n of ['list_accounts', 'list_transactions', 'get_spending_summary', 'list_categories', 'add_transaction', 'update_transaction', 'delete_transaction', 'create_invoice']) {
      expect(names).toContain(n);
    }
    const walk = (schema) => {
      if (!schema || typeof schema !== 'object') return;
      expect(Array.isArray(schema.type)).toBe(false);
      if (schema.type === 'array') expect(schema.items).toBeTruthy();
      Object.values(schema.properties || {}).forEach(walk);
      if (schema.items) walk(schema.items);
    };
    for (const t of list) {
      expect(t.name.length).toBeLessThan(64);
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      walk(t.inputSchema);
    }
    expect(list.find((t) => t.name === 'list_transactions').annotations.readOnlyHint).toBe(true);
    expect(list.find((t) => t.name === 'delete_transaction').annotations.destructiveHint).toBe(true);
  });

  test('add, list, summarize, edit and delete transactions; balance follows', async () => {
    const accs = await tool(ctx, annMcp, 'list_accounts', {});
    expect(accs.structuredContent.accounts.map((a) => a.name).sort()).toEqual(['Chequing', 'Dollars']);

    const e = await tool(ctx, annMcp, 'add_transaction', { account_id: acc, amount: 42.5, type: 'expense', description: 'Groceries Metro', category: 'Food', date: '2026-11-03' });
    expect(e.isError).toBe(false);
    expect(e.structuredContent.transaction).toMatchObject({ amount: -42.5, type: 'expense', category: 'Food', currency: 'CAD', account: 'Chequing' });
    const inc = await tool(ctx, annMcp, 'add_transaction', { account_id: acc, amount: '1200', type: 'income', description: 'Salary', category: 'Salary', date: '2026-11-01' });
    expect(inc.structuredContent.transaction.amount).toBe(1200);
    // Idempotency key: the same call twice adds once.
    const k1 = await tool(ctx, annMcp, 'add_transaction', { account_id: acc, amount: 10, type: 'expense', category: 'Coffee', date: '2026-11-04', client_tx_id: 'gpt-abc' });
    const k2 = await tool(ctx, annMcp, 'add_transaction', { account_id: acc, amount: 10, type: 'expense', category: 'Coffee', date: '2026-11-04', client_tx_id: 'gpt-abc' });
    expect(k2.structuredContent.already_added).toBe(true);
    expect(k2.structuredContent.transaction.id).toBe(k1.structuredContent.transaction.id);

    const big = await tool(ctx, annMcp, 'list_transactions', { type: 'expense', min_amount: 20 });
    expect(big.structuredContent.transactions.map((t) => t.description)).toEqual(['Groceries Metro']);
    const found = await tool(ctx, annMcp, 'list_transactions', { search: 'metro' });
    expect(found.structuredContent.count).toBe(1);

    const sum = await tool(ctx, annMcp, 'get_spending_summary', { start_date: '2026-11-01', end_date: '2026-11-30' });
    expect(sum.structuredContent).toMatchObject({ income: 1200, expenses: 52.5, net: 1147.5 });
    expect(sum.structuredContent.by_category.find((c) => c.category === 'Food').total).toBe(42.5);
    const months = await tool(ctx, annMcp, 'get_spending_summary', { start_date: '2026-11-01', end_date: '2026-11-30', group_by: 'month' });
    expect(months.structuredContent.by_month).toEqual([{ month: '2026-11', income: 1200, expenses: 52.5, net: 1147.5 }]);
    const cats = await tool(ctx, annMcp, 'list_categories', {});
    expect(cats.structuredContent.categories.map((c) => c.name)).toEqual(expect.arrayContaining(['Food', 'Salary', 'Coffee']));
    expect(cats.structuredContent.categories.map((c) => c.name)).not.toContain('Opening balance');

    const id = e.structuredContent.transaction.id;
    const up = await tool(ctx, annMcp, 'update_transaction', { transaction_id: id, amount: 50, category: 'Groceries' });
    expect(up.structuredContent.transaction).toMatchObject({ amount: -50, category: 'Groceries' });
    const bal = async () => (await tool(ctx, annMcp, 'list_accounts', {})).structuredContent.accounts.find((a) => a.id === acc).balance;
    expect(await bal()).toBe(1000 - 50 + 1200 - 10);
    const del = await tool(ctx, annMcp, 'delete_transaction', { transaction_id: id });
    expect(del.structuredContent.deleted).toBe(true);
    expect(await bal()).toBe(1000 + 1200 - 10);
  });

  test('bad input comes back as a tool error the model can fix', async () => {
    const r1 = await tool(ctx, annMcp, 'add_transaction', { account_id: acc, amount: 'abc', type: 'expense' });
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toMatch(/amount/);
    const r2 = await tool(ctx, annMcp, 'add_transaction', { account_id: acc, amount: 5, type: 'transfer' });
    expect(r2.isError).toBe(true);
    const r3 = await tool(ctx, annMcp, 'add_transaction', { account_id: acc, amount: 5, type: 'expense', date: '13/11/2026' });
    expect(r3.content[0].text).toMatch(/YYYY-MM-DD/);
    const r4 = await tool(ctx, annMcp, 'update_transaction', { transaction_id: 999999, amount: 1 });
    expect(r4.isError).toBe(true);
  });

  test('isolation: another account sees nothing and cannot write to my accounts', async () => {
    const t = await tool(ctx, bobMcp, 'list_transactions', {});
    expect(t.structuredContent.count).toBe(0);
    const a = await tool(ctx, bobMcp, 'list_accounts', {});
    expect(a.structuredContent.accounts).toEqual([]);
    const w = await tool(ctx, bobMcp, 'add_transaction', { account_id: acc, amount: 5, type: 'expense' });
    expect(w.isError).toBe(true);
    const mine = await tool(ctx, annMcp, 'list_transactions', { limit: 1 });
    const d = await tool(ctx, bobMcp, 'delete_transaction', { transaction_id: mine.structuredContent.transactions[0].id });
    expect(d.isError).toBe(true);
  });

  test('shared account: view-only cannot add; with can_add_transactions the row goes to the owner ledger', async () => {
    await dbRun(ctx.db, 'INSERT INTO account_permissions (account_id, user_id, can_view, can_add_transactions, granted_by) VALUES (?,?,1,0,?)', [usd, bob.id, ann.id]);
    const seen = await tool(ctx, bobMcp, 'list_accounts', {});
    expect(seen.structuredContent.accounts).toEqual([expect.objectContaining({ id: usd, shared_by: 'ann', can_add_transactions: false })]);
    const no = await tool(ctx, bobMcp, 'add_transaction', { account_id: usd, amount: 7, type: 'expense' });
    expect(no.content[0].text).toMatch(/permission/i);
    await dbRun(ctx.db, 'UPDATE account_permissions SET can_add_transactions = 1 WHERE account_id = ? AND user_id = ?', [usd, bob.id]);
    const yes = await tool(ctx, bobMcp, 'add_transaction', { account_id: usd, amount: 7, type: 'expense', description: 'Taxi' });
    expect(yes.isError).toBe(false);
    const annSees = await tool(ctx, annMcp, 'list_transactions', { account_id: usd });
    expect(annSees.structuredContent.transactions.map((x) => x.description)).toContain('Taxi');
  });
});
