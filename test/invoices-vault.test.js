/** @jest-environment node */
// test/invoices-vault.test.js — invoices inside Finman Vault (23.11.2026):
//   - the vault engine serves /api/invoices (templates, invoices, payments, repeat, snapshot, PDF);
//   - accounts that already had a vault: the server's invoice rows move in (late import) and the
//     server deletes exactly those rows (scoped purge, re-counted; wrong counts change nothing);
//   - template sharing goes through /api/invoice-shares (explicit choice), import copies locally;
//   - MCP on a vault: invoice tools run on the vault, the PDF link is an encrypted drop whose key
//     never reaches the server (/p/<id>#<key>).
const crypto = require('crypto');
const { makeApp } = require('./helpers/app');
const C = require('../public/js/vault/crypto');

jest.setTimeout(90000);
globalThis.__FM_NODE_INVOICE_PDF = require('../services/invoice/pdf');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => { db.run(sql, params, function (err) { if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes }); }); });
}
function dbGet(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r)))); }
function dbAll(db, sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r)))); }
const auth = (t) => ({ Authorization: `Bearer ${t}` });
async function engineLib() {
  const SQL = await require('sql.js')();
  const FE = require('../engine/dist/engine.node.cjs');
  return { SQL, FE: FE.FinmanEngine || FE };
}
const binaryParser = (res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); };

describe('invoices in the vault engine', () => {
  test('templates, invoice, payment, repeat, snapshot and PDF run locally', async () => {
    const { SQL, FE } = await engineLib();
    const eng = await FE.open({ SQL, bytes: null, user: { id: 7, email: 'v@example.com', username: 'v' } });
    const call = (method, url, body) => eng.handle({ method, url, headers: {}, body });
    expect(FE.MCP_LOCAL_TOOLS || (require('../engine/dist/engine.node.cjs').MCP_LOCAL_TOOLS)).toEqual(expect.arrayContaining(['create_invoice', 'get_invoice_pdf']));
    const p = await call('POST', '/api/invoices/profiles', { name: 'Studio', currency: 'CAD', number_format: 'V-{SEQ}', data: { seller: { name: 'Vault Studio' }, card_fee: { pct: 3 } } });
    expect(p.status).toBe(201);
    const pid = JSON.parse(p.body).profile.id;
    const i = await call('POST', '/api/invoices', { profile_id: pid, client_name: 'Client', items: [{ description: 'Work', qty: 1, price: '500.00' }] });
    expect(i.status).toBe(201);
    const inv = JSON.parse(i.body).invoice;
    expect(inv.number).toBe('V-1');
    expect((await call('POST', `/api/invoices/${inv.id}/payments`, { amount: '100' })).status).toBe(201);
    expect((await call('PUT', `/api/invoices/${inv.id}/repeat`, { every: 'month' })).status).toBe(200);
    const snap = JSON.parse((await call('GET', `/api/invoices/${inv.id}/snapshot`)).body).snapshot;
    expect(snap.paid_cents).toBe(10000);
    expect(snap.view.card_total_cents).toBe(51500);
    const pdf = await call('GET', `/api/invoices/${inv.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(pdf.body).slice(0, 4).toString()).toBe('%PDF');
    const csv = await call('GET', '/api/invoices/export.csv');
    expect(String(csv.body)).toContain('V-1');
    expect(eng.counts().invoices).toBe(1);
    eng.close();
  });
});

describe('invoices move into an existing vault', () => {
  let ctx; let user;
  beforeAll(async () => {
    ctx = await makeApp();
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const ins = await dbRun(ctx.db, 'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)', ['nora', 'nora@example.com', 'x', 'Nora']);
    user = { id: ins.id, token: jwt.sign({ id: ins.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
  });
  afterAll(async () => { await ctx.close(); });
  const H = () => auth(user.token);

  test('legacy-export -> engine import -> scoped purge: rows move, hashes match, wrong counts change nothing', async () => {
    // Invoices made on the server before the move; the account already has a vault.
    const p = (await ctx.request.post('/api/invoices/profiles').set(H()).send({ name: 'Old', currency: 'EUR', data: { seller: { name: 'Nora Ltd' } }, logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' })).body.profile;
    const a = (await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, client_name: 'A', items: [{ description: 'x', qty: 2, price: '10' }] })).body.invoice;
    await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, client_name: 'B', items: [{ description: 'y', qty: 1, price: '5' }] });
    await ctx.request.post(`/api/invoices/${a.id}/payments`).set(H()).send({ amount: '5' });
    await ctx.request.put(`/api/invoices/${a.id}/repeat`).set(H()).send({ every: 'month' });
    const { SQL, FE } = await engineLib();
    const eng0 = await FE.open({ SQL, bytes: null, user: { id: user.id, email: 'nora@example.com', username: 'nora' } });
    await eng0.handle({ method: 'POST', url: '/api/accounts', headers: {}, body: { name: 'Chequing', currency: 'EUR', balance: 0 } });
    const vk = C.newVaultKey();
    let blob = await C.encryptVault(vk, eng0.export(), user.id);
    eng0.close();
    await dbRun(ctx.db, 'INSERT INTO user_vaults (user_id, version, blob, size, wrapped_pw, wrapped_rc) VALUES (?, 1, ?, ?, ?, ?)', [user.id, Buffer.from(blob), blob.length, 'w1.x.y', 'w1.x.y']);
    await dbRun(ctx.db, "UPDATE users SET vault_state = 'active' WHERE id = ?", [user.id]);

    const meta = await ctx.request.get('/api/vault/meta').set(H());
    expect(meta.body.legacyRows).toBe(1 + 2 + 1 + 1);
    const hashOf = async () => {
      const out = {};
      for (const t of ['invoice_profiles', 'invoices', 'invoice_payments', 'invoice_repeats']) {
        const rows = await dbAll(ctx.db, `SELECT * FROM ${t} WHERE user_id = ? ORDER BY id`, [user.id]);
        out[t] = crypto.createHash('sha256').update(JSON.stringify(rows.map((r) => ({ ...r, logo: r.logo || null })))).digest('hex');
      }
      return out;
    };
    const before = await hashOf();
    // What the browser does (public/js/vault/vault.js lateImport).
    const dump = (await ctx.request.get('/api/vault/legacy-export').set(H())).body;
    const tables = {}; const counts = {};
    for (const [n, rows] of Object.entries(dump.tables)) if (rows.length) { tables[n] = rows; counts[n] = rows.length; }
    expect(Object.keys(tables).sort()).toEqual(['invoice_payments', 'invoice_profiles', 'invoice_repeats', 'invoices']);
    const v1 = await dbGet(ctx.db, 'SELECT blob FROM user_vaults WHERE user_id = ?', [user.id]);
    const eng = await FE.open({ SQL, bytes: await C.decryptVault(vk, new Uint8Array(v1.blob), user.id), user: { id: user.id } });
    const r = await eng.importLegacy({ tables });
    for (const n of Object.keys(counts)) expect(r.counts[n]).toBe(counts[n]);
    // the same rows inside the vault: hash per table equals the server's
    const after = {};
    for (const t of Object.keys(before)) {
      const rows = await eng.query(`SELECT * FROM ${t} WHERE user_id = ? ORDER BY id`, [user.id]);
      after[t] = crypto.createHash('sha256').update(JSON.stringify(rows.map((x) => ({ ...x, logo: x.logo || null })))).digest('hex');
    }
    expect(after).toEqual(before);
    expect((await eng.query('SELECT COUNT(*) n FROM accounts')).at(0).n).toBe(1); // the vault's own data stays
    blob = await C.encryptVault(vk, eng.export(), user.id);
    eng.close();
    const put = await ctx.request.put('/api/vault/blob').set(H()).set('If-Match', '1').set('Content-Type', 'application/octet-stream').send(Buffer.from(blob));
    expect(put.status).toBe(200);
    // A wrong count changes nothing.
    const wrong = await ctx.request.post('/api/vault/purge-legacy').set(H()).send({ counts: { ...counts, invoices: 1 }, scope: Object.keys(counts) });
    expect(wrong.status).toBe(409);
    expect((await dbGet(ctx.db, 'SELECT COUNT(*) n FROM invoices WHERE user_id = ?', [user.id])).n).toBe(2);
    const ok = await ctx.request.post('/api/vault/purge-legacy').set(H()).send({ counts, scope: Object.keys(counts) });
    expect(ok.status).toBe(200);
    for (const t of Object.keys(before)) expect((await dbGet(ctx.db, `SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, [user.id])).n).toBe(0);
    expect((await ctx.request.get('/api/vault/meta').set(H())).body.legacyRows).toBe(0);
    // the purged file has no invoice text left
    const raw = await dbAll(ctx.db, "SELECT name FROM sqlite_master WHERE type='table'");
    expect(raw.length).toBeGreaterThan(0);
  });

  test('template sharing by link: explicit share keeps one template, import copies it once', async () => {
    const tpl = { name: 'Shared', layout: 'classic', currency: 'CAD', number_format: '{SEQ}', due_days: 10, data: { seller: { name: 'Nora Ltd' } } };
    const s = await ctx.request.post('/api/invoice-shares').set(H()).send({ template: tpl });
    expect(s.status).toBe(201);
    expect(s.body.url).toContain(`tpl=${s.body.code}`);
    const pub = await ctx.request.get(`/api/invoices/shared/${s.body.code}`);
    expect(pub.body.template.seller_name).toBe('Nora Ltd');
    const full = await ctx.request.get(`/api/invoice-shares/${s.body.code}`).set(H());
    expect(full.body.template.due_days).toBe(10);
    expect((await ctx.request.get(`/api/invoice-shares/${s.body.code}`)).status).toBe(401);
    const { SQL, FE } = await engineLib();
    const eng = await FE.open({ SQL, bytes: null, user: { id: 99, email: 'x@example.com', username: 'x' } });
    const imp = await eng.handle({ method: 'POST', url: '/api/invoices/profiles/import', headers: {}, body: { template: full.body.template, code: s.body.code } });
    expect(imp.status).toBe(201);
    const again = await eng.handle({ method: 'POST', url: '/api/invoices/profiles/import', headers: {}, body: { template: full.body.template, code: s.body.code } });
    expect(again.status).toBe(200);
    expect(eng.counts().invoice_profiles).toBe(1);
    eng.close();
  });
});

describe('MCP invoice tools on a vault: encrypted PDF drop', () => {
  let ctx; let user; let vk;
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
  beforeAll(async () => {
    ctx = await makeApp();
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const ins = await dbRun(ctx.db, 'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)', ['mia', 'mia@example.com', 'x', 'Mia']);
    user = { id: ins.id, token: jwt.sign({ id: ins.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
    const { SQL, FE } = await engineLib();
    const eng = await FE.open({ SQL, bytes: null, user: { id: user.id, email: 'mia@example.com', username: 'mia' } });
    await eng.handle({ method: 'POST', url: '/api/invoices/profiles', headers: {}, body: { name: 'Mia', currency: 'CAD', number_format: 'M-{SEQ}', data: { seller: { name: 'Mia Catering' } } } });
    vk = C.newVaultKey();
    const blob = await C.encryptVault(vk, eng.export(), user.id);
    eng.close();
    await dbRun(ctx.db, 'INSERT INTO user_vaults (user_id, version, blob, size, wrapped_pw, wrapped_rc) VALUES (?, 1, ?, ?, ?, ?)', [user.id, Buffer.from(blob), blob.length, 'w1.x.y', 'w1.x.y']);
    await dbRun(ctx.db, "UPDATE users SET vault_state = 'active' WHERE id = ?", [user.id]);
  });
  afterAll(async () => { await ctx.close(); });

  test('create_invoice on the vault returns /p/<id>#<key>; the server holds ciphertext only', async () => {
    const reg = (await ctx.request.post('/oauth/register').send({ client_name: 'Claude', redirect_uris: [REDIRECT] })).body;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'finman', resource: 'https://app.finman.money/mcp' };
    const secret = C.randomBytes(32);
    const d = await ctx.request.post('/api/oauth/authorize/decision').set(auth(user.token)).send({ params, approve: true,
      vault: { wrapped_vk: await C.wrap(await C.kekFromGrant(secret), vk, C.wrapAad(user.id, 'grant')), secret: Buffer.from(secret).toString('base64url') } });
    const code = new URL(d.body.redirect).searchParams.get('code');
    const tok = (await ctx.request.post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier })).body.access_token;
    const r = await ctx.request.post('/mcp').set(auth(tok)).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_invoice', arguments: { client_name: 'Lakeside Cafe', items: [{ description: 'Lunch', qty: 10, price: 25 }] } } });
    expect(r.status).toBe(200);
    const res = r.body.result;
    if (res.isError) console.log('TOOL ERROR', JSON.stringify(res.content));
    expect(res.isError).toBeFalsy();
    const pdfUrl = res.structuredContent.invoice.pdf_url;
    expect(pdfUrl).toMatch(/\/p\/[A-Za-z0-9_-]{22,40}#[A-Za-z0-9_-]{43}$/);
    expect((await dbGet(ctx.db, 'SELECT COUNT(*) n FROM invoices WHERE user_id = ?', [user.id])).n).toBe(0);
    const [path, key] = pdfUrl.replace(/^https?:\/\/[^/]+/, '').split('#');
    const stored = await dbGet(ctx.db, 'SELECT blob FROM mcp_pdf_drops');
    expect(Buffer.from(stored.blob).toString('latin1')).not.toMatch(/Lakeside|%PDF/);
    const page = await ctx.request.get(path);
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/Lakeside/);
    const b = (await ctx.request.get(`${path}/blob`).buffer(true).parse(binaryParser)).body;
    const dec = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), b.slice(4, 16));
    dec.setAAD(b.slice(0, 4)); dec.setAuthTag(b.slice(b.length - 16));
    const plain = Buffer.concat([dec.update(b.slice(16, b.length - 16)), dec.final()]);
    const n = plain.readUInt16BE(0);
    expect(plain.slice(2, 2 + n).toString()).toMatch(/^Invoice_Mia_M-1\.pdf$/);
    expect(plain.slice(2 + n, 2 + n + 4).toString()).toBe('%PDF');
    // the invoice is inside the vault
    const v = await dbGet(ctx.db, 'SELECT blob FROM user_vaults WHERE user_id = ?', [user.id]);
    const { SQL, FE } = await engineLib();
    const eng = await FE.open({ SQL, bytes: await C.decryptVault(vk, new Uint8Array(v.blob), user.id), user: { id: user.id } });
    expect((await eng.query('SELECT client_name FROM invoices')).map((x) => x.client_name)).toEqual(['Lakeside Cafe']);
    eng.close();
  });
});
