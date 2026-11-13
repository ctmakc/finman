// test/mcp-oauth.test.js — MCP connector: OAuth 2.1 (discovery, DCR, PKCE, rotation,
// revocation, password change), the /mcp JSON-RPC endpoint and the invoice tools
// (numbering from the counter, tax from the template, partial payments, drafts-only
// delete, signed PDF links) and isolation between accounts.
const crypto = require('crypto');
const { makeApp } = require('./helpers/app');
const presets = require('../services/invoice/presets');

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
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function register(ctx, extra = {}) {
  const r = await ctx.request.post('/oauth/register').send({ client_name: 'Claude', redirect_uris: [REDIRECT], ...extra });
  expect(r.status).toBe(201);
  return r.body;
}

// Full flow: register -> consent (Allow) -> code -> tokens.
async function connect(ctx, userToken, client) {
  const c = client || await register(ctx);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const params = { response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-1', scope: 'finman', resource: 'https://app.finman.money/mcp' };
  const d = await ctx.request.post('/api/oauth/authorize/decision').set(auth(userToken)).send({ params, approve: true });
  expect(d.status).toBe(200);
  const url = new URL(d.body.redirect);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('st-1');
  const code = url.searchParams.get('code');
  const t = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: c.client_id, code_verifier: verifier });
  expect(t.status).toBe(200);
  return { client: c, tokens: t.body, code, verifier };
}

let rpcId = 0;
async function rpc(ctx, token, method, params) {
  const r = await ctx.request.post('/mcp').set(auth(token)).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: ++rpcId, method, params });
  return r;
}
async function tool(ctx, token, name, args) {
  const r = await rpc(ctx, token, 'tools/call', { name, arguments: args });
  expect(r.status).toBe(200);
  return r.body.result;
}

async function ohTemplate(ctx, userToken, nextSeq = 5) {
  const p = await ctx.request.post('/api/invoices/profiles').set(auth(userToken))
    .send({ name: 'OH! Catering', layout: 'light', currency: 'CAD', number_format: '{SEQ}', next_seq: nextSeq, data: presets.OWNER_PRESETS['oh-catering'].data });
  expect(p.status).toBe(201);
  return p.body.profile;
}

describe('MCP connector', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.close(); });

  test('discovery documents and the 401 challenge', async () => {
    const pr = await ctx.request.get('/.well-known/oauth-protected-resource');
    expect(pr.status).toBe(200);
    expect(pr.body.resource).toBe('https://app.finman.money/mcp');
    expect(pr.body.authorization_servers).toEqual(['https://app.finman.money']);
    const pr2 = await ctx.request.get('/.well-known/oauth-protected-resource/mcp');
    expect(pr2.body.resource).toBe('https://app.finman.money/mcp');
    const as = await ctx.request.get('/.well-known/oauth-authorization-server');
    expect(as.status).toBe(200);
    expect(as.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.body.registration_endpoint).toBe('https://app.finman.money/oauth/register');
    const nf = await ctx.request.get('/.well-known/something-else');
    expect(nf.status).toBe(404);
    expect(nf.headers['content-type']).toMatch(/json/);

    const no = await ctx.request.post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(no.status).toBe(401);
    expect(no.headers['www-authenticate']).toMatch(/resource_metadata="https:\/\/app\.finman\.money\/\.well-known\/oauth-protected-resource"/);
    const badTok = await ctx.request.post('/mcp').set(auth('finman_oat_nope')).send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(badTok.status).toBe(401);
    expect(badTok.headers['www-authenticate']).toMatch(/error="invalid_token"/);
    // A normal app JWT is no MCP token.
    const jwtTok = await ctx.request.post('/mcp').set(auth(ctx.token)).send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(jwtTok.status).toBe(401);
    const get = await ctx.request.get('/mcp');
    expect(get.status).toBe(405);
  });

  test('client registration validates redirect URIs', async () => {
    const bad1 = await ctx.request.post('/oauth/register').send({ redirect_uris: ['http://evil.example/cb'] });
    expect(bad1.status).toBe(400);
    expect(bad1.body.error).toBe('invalid_redirect_uri');
    const bad2 = await ctx.request.post('/oauth/register').send({ redirect_uris: ['javascript:alert(1)'] });
    expect(bad2.status).toBe(400);
    const bad3 = await ctx.request.post('/oauth/register').send({});
    expect(bad3.status).toBe(400);
    const local = await ctx.request.post('/oauth/register').send({ redirect_uris: ['http://localhost:33418/callback'], client_name: 'Claude Code' });
    expect(local.status).toBe(201);
    expect(local.body.client_secret).toBeUndefined();
    const conf = await ctx.request.post('/oauth/register').send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' });
    expect(conf.status).toBe(201);
    expect(conf.body.client_secret).toMatch(/^fmcs_/);
  });

  test('consent page and its check endpoint', async () => {
    const c = await register(ctx);
    const page = await ctx.request.get('/oauth/authorize').query({ client_id: c.client_id });
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/oauth-authorize\.js/);
    expect(page.headers['x-frame-options']).toBe('DENY');

    const unknown = await ctx.request.get('/api/oauth/authorize/check').query({ client_id: 'fmc_nope', redirect_uri: REDIRECT });
    expect(unknown.status).toBe(400);
    expect(unknown.body.fatal).toBeTruthy();
    const wrongRedirect = await ctx.request.get('/api/oauth/authorize/check').query({ client_id: c.client_id, redirect_uri: 'https://evil.example/cb' });
    expect(wrongRedirect.status).toBe(400);
    const noPkce = await ctx.request.get('/api/oauth/authorize/check').query({ client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code' });
    expect(noPkce.body.ok).toBe(false);
    expect(new URL(noPkce.body.redirect).searchParams.get('error')).toBe('invalid_request');
    const good = await ctx.request.get('/api/oauth/authorize/check').query({ client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
    expect(good.body).toEqual({ ok: true, app: 'Claude', return_host: 'claude.ai' });

    // Decision needs a signed-in Finman user.
    const anon = await ctx.request.post('/api/oauth/authorize/decision').send({ params: { client_id: c.client_id }, approve: true });
    expect(anon.status).toBe(401);
    // Cancel -> access_denied back to the app.
    const deny = await ctx.request.post('/api/oauth/authorize/decision').set(auth(ctx.token)).send({
      params: { client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'x' }, approve: false });
    const u = new URL(deny.body.redirect);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('code')).toBeNull();
  });

  test('code exchange: PKCE, one use, refresh rotation, revocation, password change', async () => {
    const user = await makeUser(ctx, 'oauthflow');
    const { client, tokens, code, verifier } = await connect(ctx, user.token);
    expect(tokens.access_token).toMatch(/^finman_oat_/);
    expect(tokens.refresh_token).toMatch(/^finman_ort_/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);

    // The code works once.
    const again = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');

    // Wrong verifier fails.
    const c2 = await register(ctx);
    const challenge = b64url(crypto.createHash('sha256').update('v'.repeat(50)).digest());
    const d = await ctx.request.post('/api/oauth/authorize/decision').set(auth(user.token)).send({ approve: true,
      params: { response_type: 'code', client_id: c2.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' } });
    const code2 = new URL(d.body.redirect).searchParams.get('code');
    const wrong = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: c2.client_id, code_verifier: 'w'.repeat(50) });
    expect(wrong.status).toBe(400);
    // …and burns the code.
    const right = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: c2.client_id, code_verifier: 'v'.repeat(50) });
    expect(right.status).toBe(400);

    // Another client cannot use this client's refresh token.
    const steal = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: c2.client_id });
    expect(steal.status).toBe(400);

    // Rotation: new pair, old refresh and old access stop working.
    const ref = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(ref.status).toBe(200);
    expect(ref.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await rpc(ctx, tokens.access_token, 'ping')).status).toBe(401);
    expect((await rpc(ctx, ref.body.access_token, 'ping')).status).toBe(200);
    const old = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(old.status).toBe(400);

    // Connected apps list + disconnect.
    const list = await ctx.request.get('/api/mcp/connections').set(auth(user.token));
    expect(list.body.connections.length).toBe(1);
    expect(list.body.connections[0].app).toBe('Claude');

    // RFC 7009 revoke kills the grant.
    const rv = await ctx.request.post('/oauth/revoke').type('form').send({ token: ref.body.refresh_token, client_id: client.client_id });
    expect(rv.status).toBe(200);
    expect((await rpc(ctx, ref.body.access_token, 'ping')).status).toBe(401);

    // Password change (token_version bump) signs the app out.
    const { tokens: t3 } = await connect(ctx, user.token);
    expect((await rpc(ctx, t3.access_token, 'ping')).status).toBe(200);
    await dbRun(ctx.db, 'UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?', [user.id]);
    expect((await rpc(ctx, t3.access_token, 'ping')).status).toBe(401);
  });

  test('confidential client must authenticate at the token endpoint', async () => {
    const user = await makeUser(ctx, 'confidential');
    const c = await register(ctx, { token_endpoint_auth_method: 'client_secret_basic' });
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const d = await ctx.request.post('/api/oauth/authorize/decision').set(auth(user.token)).send({ approve: true,
      params: { response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' } });
    const code = new URL(d.body.redirect).searchParams.get('code');
    const noSecret = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, client_id: c.client_id, code_verifier: verifier });
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe('invalid_client');
  });

  test('MCP handshake and tool list', async () => {
    const user = await makeUser(ctx, 'handshake');
    const { tokens } = await connect(ctx, user.token);
    const init = await rpc(ctx, tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.capabilities.tools).toBeTruthy();
    expect(init.body.result.serverInfo.name).toBe('finman');
    const odd = await rpc(ctx, tokens.access_token, 'initialize', { protocolVersion: '1999-01-01' });
    expect(odd.body.result.protocolVersion).toBe('2025-11-25');

    const note = await ctx.request.post('/mcp').set(auth(tokens.access_token)).send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);

    const list = await rpc(ctx, tokens.access_token, 'tools/list');
    const names = list.body.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_invoice_templates', 'create_invoice', 'list_invoices', 'get_invoice',
      'get_invoice_pdf', 'record_payment', 'list_clients', 'delete_draft_invoice', 'set_invoice_status']));
    const create = list.body.result.tools.find((t) => t.name === 'create_invoice');
    expect(Object.keys(create.inputSchema.properties)).not.toContain('number');

    const unknown = await rpc(ctx, tokens.access_token, 'tools/call', { name: 'nope', arguments: {} });
    expect(unknown.body.error.code).toBe(-32602);
    const nomethod = await rpc(ctx, tokens.access_token, 'resources/read', {});
    expect(nomethod.body.error.code).toBe(-32601);
  });

  test('invoices through the tools: counter number, template tax, deposit, payment, PDF, delete', async () => {
    const user = await makeUser(ctx, 'nastya');
    const tpl = await ohTemplate(ctx, user.token, 5);
    const { tokens } = await connect(ctx, user.token);
    const T = tokens.access_token;

    const templates = (await tool(ctx, T, 'list_invoice_templates', {})).structuredContent.templates;
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ id: tpl.id, currency: 'CAD', next_number: '5' });
    expect(templates[0].tax.rate_percent).toBe(13);

    const created = await tool(ctx, T, 'create_invoice', {
      template_id: tpl.id, client_name: 'Maple Events Inc.', client_details: '12 King St W\nToronto ON',
      items: [{ description: 'Buffet, 22 Nov', guests: 40, price_per_guest: '38.40' }], delivery: 60,
      issue_date: '2026-11-13', due_date: '2026-11-20', number: '999', notes: 'Event 22 Nov, 6 pm',
    });
    expect(created.isError).toBe(false);
    const inv = created.structuredContent.invoice;
    expect(inv.number).toBe('5'); // counter, never the number the model sent
    expect(inv.status).toBe('draft');
    expect(inv.items).toHaveLength(2);
    expect(inv.items[1]).toMatchObject({ description: 'Delivery', qty: 1, price: '60.00 CAD' });
    // 40 × 38.40 + 60 = 1,596.00; 13 % = 207.48; total 1,803.48
    expect(inv.subtotal).toBe('1,596.00 CAD');
    expect(inv.tax.amount).toBe('207.48 CAD');
    expect(inv.total).toBe('1,803.48 CAD');
    expect(inv.due_date).toBe('2026-11-20');
    expect(inv.pdf_url).toMatch(/^https:\/\/app\.finman\.money\/api\/mcp\/pdf\/\d+\?u=\d+&exp=\d+&sig=/);

    const second = (await tool(ctx, T, 'create_invoice', { client_name: 'Second', items: [{ description: 'x', qty: 1, price: 100 }] })).structuredContent.invoice;
    expect(second.number).toBe('6');

    // 30 % deposit -> sent, balance left.
    const dep = await tool(ctx, T, 'record_payment', { invoice_id: inv.id, percent: 30, method: 'e-Transfer', paid_on: '2026-11-14' });
    expect(dep.isError).toBe(false);
    expect(dep.structuredContent.invoice.status).toBe('sent');
    expect(dep.structuredContent.invoice.paid).toBe('541.04 CAD');
    expect(dep.structuredContent.invoice.balance_due).toBe('1,262.44 CAD');
    expect(dep.structuredContent.invoice.payments).toHaveLength(1);

    const tooMuch = await tool(ctx, T, 'record_payment', { invoice_id: inv.id, amount: 5000 });
    expect(tooMuch.isError).toBe(true);
    // The rest -> paid.
    const rest = await tool(ctx, T, 'record_payment', { invoice_id: inv.id });
    expect(rest.structuredContent.invoice.status).toBe('paid');
    expect(rest.structuredContent.invoice.balance_due).toBe('0.00 CAD');
    const more = await tool(ctx, T, 'record_payment', { invoice_id: inv.id, amount: 1 });
    expect(more.isError).toBe(true);

    // The app's list shows the same paid/balance figures.
    const appList = await ctx.request.get('/api/invoices').set(auth(user.token));
    const appInv = appList.body.invoices.find((i) => i.id === inv.id);
    expect(appInv.paid_cents).toBe(180348);
    expect(appInv.balance_cents).toBe(0);

    const found = await tool(ctx, T, 'list_invoices', { search: 'Maple' });
    expect(found.structuredContent.invoices.map((i) => i.number)).toEqual(['5']);
    const byNumber = await tool(ctx, T, 'get_invoice', { number: '5' });
    expect(byNumber.structuredContent.invoice.payments).toHaveLength(2);

    const clients = (await tool(ctx, T, 'list_clients', {})).structuredContent.clients;
    expect(clients.map((c) => c.name).sort()).toEqual(['Maple Events Inc.', 'Second']);

    // Signed PDF link opens without login; a tampered one does not.
    const link = (await tool(ctx, T, 'get_invoice_pdf', { invoice_id: inv.id })).structuredContent.pdf_url;
    const path = link.replace('https://app.finman.money', '');
    const pdf = await ctx.request.get(path).buffer(true).parse((res, cb) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    expect((await ctx.request.get(path.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
    expect((await ctx.request.get(path.replace(/u=\d+/, `u=${ctx.userId}`))).status).toBe(403);

    // Delete: drafts only.
    const delPaid = await tool(ctx, T, 'delete_draft_invoice', { invoice_id: inv.id });
    expect(delPaid.isError).toBe(true);
    const delDraft = await tool(ctx, T, 'delete_draft_invoice', { invoice_id: second.id });
    expect(delDraft.isError).toBe(false);
    expect((await tool(ctx, T, 'get_invoice', { invoice_id: second.id })).isError).toBe(true);

    // Status tool and validation errors come back as tool errors.
    const v = await tool(ctx, T, 'set_invoice_status', { invoice_id: inv.id, status: 'paid' });
    expect(v.isError).toBe(true);
    const noItems = await tool(ctx, T, 'create_invoice', { client_name: 'X', items: [] });
    expect(noItems.isError).toBe(true);
    const badPrice = await tool(ctx, T, 'create_invoice', { client_name: 'X', items: [{ description: 'a', price: 'lots' }] });
    expect(badPrice.isError).toBe(true);
  });

  test('accounts are isolated (IDOR)', async () => {
    const a = await makeUser(ctx, 'iso_a');
    const b = await makeUser(ctx, 'iso_b');
    await ohTemplate(ctx, a.token, 1);
    await ohTemplate(ctx, b.token, 1);
    const ta = (await connect(ctx, a.token)).tokens.access_token;
    const tb = (await connect(ctx, b.token)).tokens.access_token;
    const invA = (await tool(ctx, ta, 'create_invoice', { client_name: 'Secret client A', items: [{ description: 'x', price: 10 }] })).structuredContent.invoice;

    expect((await tool(ctx, tb, 'get_invoice', { invoice_id: invA.id })).isError).toBe(true);
    expect((await tool(ctx, tb, 'get_invoice_pdf', { invoice_id: invA.id })).isError).toBe(true);
    expect((await tool(ctx, tb, 'record_payment', { invoice_id: invA.id, amount: 1 })).isError).toBe(true);
    expect((await tool(ctx, tb, 'delete_draft_invoice', { invoice_id: invA.id })).isError).toBe(true);
    expect((await tool(ctx, tb, 'set_invoice_status', { invoice_id: invA.id, status: 'void' })).isError).toBe(true);
    const listB = (await tool(ctx, tb, 'list_invoices', {})).structuredContent;
    expect(listB.invoices.find((i) => i.id === invA.id)).toBeUndefined();
    const clientsB = (await tool(ctx, tb, 'list_clients', { search: 'Secret' })).structuredContent.clients;
    expect(clientsB).toHaveLength(0);
    const tplA = (await tool(ctx, ta, 'list_invoice_templates', {})).structuredContent.templates[0];
    const crossTpl = await tool(ctx, tb, 'create_invoice', { template_id: tplA.id, client_name: 'x', items: [{ description: 'x', price: 1 }] });
    expect(crossTpl.isError).toBe(true);
    // b cannot disconnect a's apps.
    const conns = (await ctx.request.get('/api/mcp/connections').set(auth(a.token))).body.connections;
    expect((await ctx.request.delete(`/api/mcp/connections/${conns[0].id}`).set(auth(b.token))).status).toBe(404);
    expect((await ctx.request.delete(`/api/mcp/connections/${conns[0].id}`).set(auth(a.token))).status).toBe(200);
    expect((await rpc(ctx, ta, 'ping')).status).toBe(401);
  });

  test('personal access token works on /mcp (Claude Code)', async () => {
    const user = await makeUser(ctx, 'patuser');
    await ohTemplate(ctx, user.token, 1);
    const created = await ctx.request.post('/api/v1/tokens').set(auth(user.token)).send({ name: 'Claude Code' });
    expect(created.status).toBeLessThan(300);
    const pat = created.body.data.token.token;
    expect(pat).toMatch(/^finman_pat_/);
    const r = await tool(ctx, pat, 'list_invoice_templates', {});
    expect(r.structuredContent.templates).toHaveLength(1);
  });
});
