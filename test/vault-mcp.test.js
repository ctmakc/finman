/** @jest-environment node */
// test/vault-mcp.test.js — MCP by explicit consent for a Finman Vault account
// (docs/E2E-ENCRYPTION.md §6.3, services/mcp/vaultGrant.js):
//   - without a grant the tools answer "encrypted, connect again", nothing leaks;
//   - Allow with a wrapped key → the token carries the grant secret, the server stores
//     only the wrap; list_accounts reads the vault, add_transaction writes a new
//     encrypted version (no plaintext row on the server);
//   - refresh keeps the secret; revoking the app deletes the wrap.
const crypto = require('crypto');
const { makeApp } = require('./helpers/app');
const C = require('../public/js/vault/crypto');

jest.setTimeout(60000);

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes }); });
  });
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function engineLib() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const FE = require('../engine/dist/engine.node.cjs');
  return { SQL, FE: FE.FinmanEngine || FE };
}

describe('MCP on an encrypted vault (consent)', () => {
  let ctx; let user; let vk;
  beforeAll(async () => {
    ctx = await makeApp();
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const ins = await dbRun(ctx.db, 'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)', ['vera', 'vera@example.com', 'x', 'Vera']);
    user = { id: ins.id, token: jwt.sign({ id: ins.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
    // A vault with one account, built by the same engine the browser runs.
    const { SQL, FE } = await engineLib();
    const eng = await FE.open({ SQL, bytes: null, user: { id: user.id, email: 'vera@example.com', username: 'vera' } });
    const r = await eng.handle({ method: 'POST', url: '/api/accounts', headers: {}, body: { name: 'Vault Chequing', currency: 'CAD', balance: 500 } });
    expect(r.status).toBeLessThan(300);
    vk = C.newVaultKey();
    const blob = await C.encryptVault(vk, eng.export(), user.id);
    eng.close();
    await dbRun(ctx.db, 'INSERT INTO user_vaults (user_id, version, blob, size, wrapped_pw, wrapped_rc) VALUES (?, 1, ?, ?, ?, ?)',
      [user.id, Buffer.from(blob), blob.length, 'w1.x.y', 'w1.x.y']);
    await dbRun(ctx.db, "UPDATE users SET vault_state = 'active' WHERE id = ?", [user.id]);
  });
  afterAll(async () => { await ctx.close(); });

  async function connect(withVault) {
    const reg = await ctx.request.post('/oauth/register').send({ client_name: 'Claude', redirect_uris: [REDIRECT] });
    const c = reg.body;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = { response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
      code_challenge_method: 'S256', state: 's', scope: 'finman', resource: 'https://app.finman.money/mcp' };
    const body = { params, approve: true };
    if (withVault) {
      const secret = C.randomBytes(32);
      body.vault = {
        wrapped_vk: await C.wrap(await C.kekFromGrant(secret), vk, C.wrapAad(user.id, 'grant')),
        secret: Buffer.from(secret).toString('base64url'),
      };
    }
    const d = await ctx.request.post('/api/oauth/authorize/decision').set(auth(user.token)).send(body);
    expect(d.status).toBe(200);
    const code = new URL(d.body.redirect).searchParams.get('code');
    const t = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: c.client_id, code_verifier: verifier });
    expect(t.status).toBe(200);
    return { client: c, tokens: t.body };
  }
  let id = 0;
  async function tool(token, name, args = {}) {
    const r = await ctx.request.post('/mcp').set(auth(token)).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    expect(r.status).toBe(200);
    return r.body.result;
  }
  const text = (res) => (res.content || []).map((c) => c.text).join('\n');

  test('without consent the tools refuse and show no data', async () => {
    const { tokens } = await connect(false);
    expect(tokens.access_token).not.toMatch(/\.v\./);
    const res = await tool(tokens.access_token, 'list_accounts');
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/encrypted/i);
    expect(text(res)).not.toMatch(/Vault Chequing/);
  });

  test('with consent: read and write through the vault, server keeps only ciphertext', async () => {
    const { client, tokens } = await connect(true);
    expect(tokens.access_token).toMatch(/\.v\.[A-Za-z0-9_-]{43}$/);
    const grant = await dbGet(ctx.db, 'SELECT * FROM vault_grants WHERE user_id = ?', [user.id]);
    expect(grant.wrapped_vk).toMatch(/^w1\./);
    // the secret itself is nowhere in the database
    const secret = tokens.access_token.split('.v.')[1];
    const dump = JSON.stringify(await new Promise((res) => ctx.db.all('SELECT * FROM oauth_tokens', (e, r) => res(r))));
    expect(dump).not.toContain(secret);

    const list = await tool(tokens.access_token, 'list_accounts');
    expect(list.isError).toBeFalsy();
    expect(text(list)).toMatch(/Vault Chequing/);

    const acc = JSON.parse(JSON.stringify(list.structuredContent || {}));
    const accountId = (acc.accounts && acc.accounts[0] && acc.accounts[0].id) || 1;
    const add = await tool(tokens.access_token, 'add_transaction', { account_id: accountId, amount: 12.34, type: 'expense', description: 'MCP vault coffee', date: '2026-11-21' });
    expect(add.isError).toBeFalsy();
    const v = await dbGet(ctx.db, 'SELECT version, blob FROM user_vaults WHERE user_id = ?', [user.id]);
    expect(v.version).toBe(2);
    expect(Buffer.from(v.blob).toString('latin1')).not.toMatch(/MCP vault coffee/);
    const plain = await dbGet(ctx.db, 'SELECT COUNT(*) n FROM transactions WHERE user_id = ?', [user.id]);
    expect(plain.n).toBe(0);
    // decrypt with the user's key: the transaction is inside
    const { SQL, FE } = await engineLib();
    const eng = await FE.open({ SQL, bytes: await C.decryptVault(vk, new Uint8Array(v.blob), user.id), user: { id: user.id } });
    const rows = await eng.query('SELECT description, amount FROM transactions WHERE user_id = ?', [user.id]);
    eng.close();
    expect(rows.map((r) => r.description)).toContain('MCP vault coffee');

    // refresh keeps the secret
    const rt = await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(rt.status).toBe(200);
    expect(rt.body.access_token.split('.v.')[1]).toBe(secret);
    expect(text(await tool(rt.body.access_token, 'list_accounts'))).toMatch(/Vault Chequing/);

    // disconnect in settings: the wrap is gone
    const conns = await ctx.request.get('/api/mcp/connections').set(auth(user.token));
    for (const c of conns.body.connections) await ctx.request.delete(`/api/mcp/connections/${c.id}`).set(auth(user.token));
    const left = await dbGet(ctx.db, 'SELECT COUNT(*) n FROM vault_grants WHERE user_id = ?', [user.id]);
    expect(left.n).toBe(0);
  });

  test('a personal access token cannot read an encrypted account', async () => {
    const r = await ctx.request.post('/api/v1/tokens').set(auth(user.token)).send({ name: 'cli' });
    const t = (r.body.data && r.body.data.token) || r.body.token;
    const pat = typeof t === 'string' ? t : t && t.token;
    expect(pat).toBeTruthy();
    const a = await ctx.request.get('/api/v1/accounts').set(auth(pat));
    expect(a.status).toBe(409);
    expect(a.body.code).toBe('VAULT_ENCRYPTED');
  });
});
