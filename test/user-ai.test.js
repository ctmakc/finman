// test/user-ai.test.js — "Your AI": the person's own key (encrypted, masked, deletable),
// the assistant loop on OpenAI / Anthropic / Gemini formats, confirm / decline for tools
// that change data, isolation, private-network base URLs. The HTTP layer is faked:
// no request leaves the machine.
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes }); });
  });
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}
async function makeUser(ctx, username) {
  const jwt = require('jsonwebtoken');
  const config = require('../config/config');
  const ins = await dbRun(ctx.db, 'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)', [username, `${username}@example.com`, 'x', username]);
  return { id: ins.id, token: jwt.sign({ id: ins.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const OPENAI_KEY = 'sk-test-openai-0000000000000000AbCd';
const ANTHROPIC_KEY = 'sk-ant-test-1111111111111111WxYz';
const GEMINI_KEY = 'AIzaTest22222222222222222222Gm9q';

// Fake provider: records requests, answers from a per-test script.
const calls = [];
let script = [];
function fakeHttp(cfg) {
  calls.push(cfg);
  const url = cfg.url;
  const key = (cfg.headers.Authorization || '').replace('Bearer ', '') || cfg.headers['x-api-key'] || cfg.headers['x-goog-api-key'];
  if (key === 'sk-bad-key-9999999999') return Promise.resolve({ status: 401, data: { error: { message: `Incorrect API key provided: ${key}` } } });
  if (cfg.method === 'GET' && /api\.openai\.com\/v1\/models$/.test(url)) {
    return Promise.resolve({ status: 200, data: { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }, { id: 'dall-e-3' }] } });
  }
  if (cfg.method === 'GET' && /api\.anthropic\.com\/v1\/models/.test(url)) {
    return Promise.resolve({ status: 200, data: { data: [{ id: 'claude-haiku-4-5', display_name: 'Haiku' }, { id: 'claude-sonnet-4-5', display_name: 'Sonnet' }] } });
  }
  if (cfg.method === 'GET' && /generativelanguage.*\/models/.test(url)) {
    return Promise.resolve({ status: 200, data: { models: [
      { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] } });
  }
  if (cfg.method === 'GET' && /example-llm\.com/.test(url)) return Promise.resolve({ status: 200, data: { data: [{ id: 'my-model' }] } });
  const next = script.shift();
  if (!next) return Promise.resolve({ status: 500, data: { error: { message: 'no scripted answer' } } });
  return Promise.resolve({ status: 200, data: next });
}

describe('Your AI: keys', () => {
  let ctx; let ann; let bob; let providers;
  beforeAll(async () => {
    ctx = await makeApp();
    providers = require('../services/userAi/providers');
    providers._setHttp(fakeHttp);
    ann = await makeUser(ctx, 'ann');
    bob = await makeUser(ctx, 'bob');
  });
  afterAll(async () => { providers._setHttp(null); await ctx.close(); });

  test('providers list is open to every plan and has the main AIs', async () => {
    const r = await ctx.request.get('/api/ai/my/providers').set(auth(ann.token));
    expect(r.status).toBe(200);
    const ids = r.body.providers.map((p) => p.id);
    for (const id of ['openai', 'anthropic', 'google', 'openrouter', 'custom']) expect(ids).toContain(id);
    expect((await ctx.request.get('/api/ai/my/providers')).status).toBe(401);
  });

  test('a key is checked, stored encrypted and shown only as a mask', async () => {
    const r = await ctx.request.post('/api/ai/my/keys').set(auth(ann.token)).send({ provider: 'openai', key: OPENAI_KEY, label: 'Mine' });
    expect(r.status).toBe(201);
    expect(r.body.key).toMatchObject({ provider: 'openai', key_mask: '••••AbCd', model: 'gpt-5-mini', is_default: true, label: 'Mine' });
    expect(r.body.models.map((m) => m.id)).toEqual(['gpt-4o-mini', 'gpt-5-mini']);
    expect(JSON.stringify(r.body)).not.toContain(OPENAI_KEY);
    const check = calls.find((c) => /\/v1\/models$/.test(c.url));
    expect(check.url).not.toContain(OPENAI_KEY);
    expect(check.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);

    const rows = await dbAll(ctx.db, 'SELECT * FROM user_ai_keys WHERE user_id = ?', [ann.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key_enc).not.toContain(OPENAI_KEY);
    expect(rows[0].key_enc.split(':')).toHaveLength(3);
    expect(require('../config/config').decryptToken(rows[0].key_enc)).toBe(OPENAI_KEY);

    const list = await ctx.request.get('/api/ai/my/keys').set(auth(ann.token));
    expect(list.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(list.body)).not.toContain(OPENAI_KEY);
    expect(list.body.keys).toHaveLength(1);
    expect((await ctx.request.get('/api/ai/my/keys').set(auth(bob.token))).body.keys).toHaveLength(0);
  });

  test('a rejected key is not saved and the error does not echo it', async () => {
    const r = await ctx.request.post('/api/ai/my/keys').set(auth(bob.token)).send({ provider: 'openai', key: 'sk-bad-key-9999999999' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('AI_KEY_REJECTED');
    expect(r.body.message).not.toContain('sk-bad-key-9999999999');
    expect((await dbAll(ctx.db, 'SELECT id FROM user_ai_keys WHERE user_id = ?', [bob.id]))).toHaveLength(0);
    const bad = await ctx.request.post('/api/ai/my/keys').set(auth(bob.token)).send({ provider: 'nope', key: 'whatever-123456' });
    expect(bad.body.code).toBe('AI_BAD_PROVIDER');
  });

  test('Anthropic and Gemini keys pick a chat model', async () => {
    const a = await ctx.request.post('/api/ai/my/keys').set(auth(bob.token)).send({ provider: 'anthropic', key: ANTHROPIC_KEY });
    expect(a.status).toBe(201);
    expect(a.body.key.model).toBe('claude-sonnet-4-5');
    const g = await ctx.request.post('/api/ai/my/keys').set(auth(bob.token)).send({ provider: 'google', key: GEMINI_KEY });
    expect(g.status).toBe(201);
    expect(g.body.key.model).toBe('gemini-flash-latest');
    expect(g.body.models.map((m) => m.id)).toEqual(['gemini-flash-latest']);
    const gReq = calls.filter((c) => /generativelanguage/.test(c.url)).pop();
    expect(gReq.url).not.toContain(GEMINI_KEY);
    expect(gReq.headers['x-goog-api-key']).toBe(GEMINI_KEY);
  });

  test('custom base URL: https only, private networks refused', async () => {
    for (const u of ['http://example-llm.com/v1', 'https://127.0.0.1/v1', 'https://localhost:8080/v1', 'https://10.1.2.3/v1', 'https://[::1]/v1', 'https://192.168.0.5/v1', 'https://169.254.169.254/latest', 'https://user:pw@example-llm.com/v1']) {
      const r = await ctx.request.post('/api/ai/my/keys').set(auth(bob.token)).send({ provider: 'custom', key: 'sk-custom-123456789', base_url: u });
      expect([u, r.body.code]).toEqual([u, 'AI_BAD_URL']);
    }
    const ok = await ctx.request.post('/api/ai/my/keys').set(auth(bob.token)).send({ provider: 'custom', key: 'sk-custom-123456789', base_url: 'https://example-llm.com/v1/' });
    expect(ok.status).toBe(201);
    expect(ok.body.key).toMatchObject({ base_url: 'https://example-llm.com/v1', model: 'my-model' });
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) expect([ip, providers.privateIp(ip)]).toEqual([ip, true]);
    for (const ip of ['8.8.8.8', '104.18.1.1', '2606:4700::1111']) expect([ip, providers.privateIp(ip)]).toEqual([ip, false]);
  });

  test('model change, default switch, delete; another person cannot touch the key', async () => {
    const keys = (await ctx.request.get('/api/ai/my/keys').set(auth(bob.token))).body.keys;
    const gem = keys.find((k) => k.provider === 'google');
    expect((await ctx.request.patch(`/api/ai/my/keys/${gem.id}`).set(auth(ann.token)).send({ model: 'x' })).status).toBe(404);
    expect((await ctx.request.delete(`/api/ai/my/keys/${gem.id}`).set(auth(ann.token))).status).toBe(404);
    const p = await ctx.request.patch(`/api/ai/my/keys/${gem.id}`).set(auth(bob.token)).send({ model: 'gemini-pro-latest', is_default: true });
    expect(p.body.key).toMatchObject({ model: 'gemini-pro-latest', is_default: true });
    const after = (await ctx.request.get('/api/ai/my/keys').set(auth(bob.token))).body.keys;
    expect(after.filter((k) => k.is_default).map((k) => k.id)).toEqual([gem.id]);
    const d = await ctx.request.delete(`/api/ai/my/keys/${gem.id}`).set(auth(bob.token));
    expect(d.body.ok).toBe(true);
    const left = (await ctx.request.get('/api/ai/my/keys').set(auth(bob.token))).body.keys;
    expect(left.map((k) => k.id)).not.toContain(gem.id);
    expect(left.filter((k) => k.is_default)).toHaveLength(1);
  });
});

describe('Your AI: the assistant', () => {
  let ctx; let ann; let bob; let providers; let acc;
  const keyOf = async (u, provider, key) => (await ctx.request.post('/api/ai/my/keys').set(auth(u.token)).send({ provider, key })).body.key;
  const lastPost = () => calls.filter((c) => c.method === 'POST').pop();

  beforeAll(async () => {
    ctx = await makeApp();
    providers = require('../services/userAi/providers');
    providers._setHttp(fakeHttp);
    ann = await makeUser(ctx, 'ann');
    bob = await makeUser(ctx, 'bob');
    const a = await ctx.request.post('/api/accounts').set(auth(ann.token)).send({ name: 'Chequing', currency: 'CAD', balance: 1000 });
    acc = a.body.id;
  });
  afterAll(async () => { providers._setHttp(null); await ctx.close(); });

  test('OpenAI format: read tools run at once, the answer uses their result', async () => {
    const k = await keyOf(ann, 'openai', OPENAI_KEY);
    script = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'list_accounts', arguments: '{}' } }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'You have 1,000.00 CAD in Chequing.' } }] },
    ];
    const r = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'How much money do I have?', locale: 'en' });
    expect(r.status).toBe(200);
    expect(r.body.thread.key).toMatchObject({ id: k.id, key_mask: '••••AbCd' });
    expect(JSON.stringify(r.body)).not.toContain(OPENAI_KEY);
    const [u, a1, a2] = r.body.messages;
    expect(u).toMatchObject({ role: 'user', text: 'How much money do I have?' });
    expect(a1.actions[0]).toMatchObject({ tool: 'list_accounts', status: 'auto', needs_confirm: false, is_error: false });
    expect(a2.text).toBe('You have 1,000.00 CAD in Chequing.');

    const req = lastPost();
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.data.model).toBe('gpt-5-mini');
    expect(req.data.max_completion_tokens).toBeGreaterThan(0);
    expect(req.data.temperature).toBeUndefined();
    expect(req.data.messages[0].role).toBe('system');
    const toolMsg = req.data.messages.find((m) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('call_a');
    expect(toolMsg.content).toContain('Chequing');
    const fn = req.data.tools.map((t) => t.function.name);
    for (const n of ['list_accounts', 'add_transaction', 'get_spending_summary', 'list_invoices']) expect(fn).toContain(n);

    const threads = await ctx.request.get('/api/ai/my/threads').set(auth(ann.token));
    expect(threads.body.threads[0]).toMatchObject({ id: r.body.thread.id, title: 'How much money do I have?' });
  });

  test('Anthropic format: a write waits for Confirm, then runs and the model goes on', async () => {
    const k = await keyOf(bob, 'anthropic', ANTHROPIC_KEY);
    const b = await ctx.request.post('/api/accounts').set(auth(bob.token)).send({ name: 'Bob card', currency: 'EUR', balance: 0 });
    script = [{
      content: [{ type: 'text', text: 'Adding it.' }, { type: 'tool_use', id: 'toolu_1', name: 'add_transaction', input: { account_id: b.body.id, amount: 12.5, type: 'expense', date: '2026-11-10', description: 'Coffee' } }],
    }];
    const r = await ctx.request.post('/api/ai/my/chat').set(auth(bob.token)).send({ message: 'I spent 12.50 on coffee on Nov 10', key_id: k.id });
    expect(r.status).toBe(200);
    expect(r.body.pending).toBe(1);
    const act = r.body.messages[1].actions[0];
    expect(act).toMatchObject({ tool: 'add_transaction', status: 'pending', needs_confirm: true });
    expect(act.fields).toEqual(expect.arrayContaining([['amount', '12.5'], ['description', 'Coffee'], ['account_id', 'Bob card']]));
    expect(await dbAll(ctx.db, 'SELECT id FROM transactions WHERE account_id = ?', [b.body.id])).toHaveLength(0);

    const req1 = lastPost();
    expect(req1.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req1.headers['anthropic-version']).toBe('2023-06-01');
    expect(req1.data.max_tokens).toBeGreaterThan(0);
    expect(req1.data.tools[0].input_schema).toBeDefined();

    // Ann cannot answer Bob's card.
    expect((await ctx.request.post(`/api/ai/my/actions/${act.id}`).set(auth(ann.token)).send({ approve: true })).status).toBe(404);

    script = [{ content: [{ type: 'text', text: 'Done: 12.50 EUR coffee.' }] }];
    const c = await ctx.request.post(`/api/ai/my/actions/${act.id}`).set(auth(bob.token)).send({ approve: true });
    expect(c.status).toBe(200);
    expect(c.body.pending).toBe(0);
    expect(c.body.messages[1].actions[0]).toMatchObject({ status: 'done', is_error: false });
    expect(c.body.messages[2].text).toBe('Done: 12.50 EUR coffee.');
    const tx = await dbAll(ctx.db, 'SELECT amount, type, description FROM transactions WHERE account_id = ?', [b.body.id]);
    expect(tx).toEqual([{ amount: -12.5, type: 'expense', description: 'Coffee' }]);

    const req2 = lastPost();
    const last = req2.data.messages[req2.data.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false });
    expect(req2.data.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    // Answering twice is refused.
    expect((await ctx.request.post(`/api/ai/my/actions/${act.id}`).set(auth(bob.token)).send({ approve: true })).status).toBe(409);
  });

  test('Gemini format: Decline keeps the data and the thought signature goes back', async () => {
    const tx = await ctx.request.post('/api/transactions').set(auth(ann.token)).send({ account_id: acc, accountId: acc, amount: 40, type: 'expense', date: '2026-11-01', description: 'Lunch', category: 'Food' });
    expect(tx.status).toBe(201);
    const g = await keyOf(ann, 'google', GEMINI_KEY);
    script = [{
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'delete_transaction', args: { transaction_id: tx.body.id } }, thoughtSignature: 'SIG-123' }] } }],
    }];
    const r = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'Delete the lunch', key_id: g.id, locale: 'uk' });
    expect(r.status).toBe(200);
    const req1 = lastPost();
    expect(req1.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    expect(req1.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(req1.data.systemInstruction.parts[0].text).toContain('Ukrainian');
    expect(req1.data.tools[0].functionDeclarations.length).toBeGreaterThan(5);
    const act = r.body.messages[1].actions[0];
    expect(act).toMatchObject({ tool: 'delete_transaction', status: 'pending' });

    script = [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Гаразд, не видаляю.' }] } }] }];
    const d = await ctx.request.post(`/api/ai/my/actions/${act.id}`).set(auth(ann.token)).send({ approve: false });
    expect(d.status).toBe(200);
    expect(d.body.messages[1].actions[0].status).toBe('declined');
    expect(d.body.messages[2].text).toBe('Гаразд, не видаляю.');
    expect(await dbAll(ctx.db, 'SELECT id FROM transactions WHERE id = ?', [tx.body.id])).toHaveLength(1);

    const req2 = lastPost();
    const roles = req2.data.contents.map((c) => c.role);
    expect(roles).toEqual(['user', 'model', 'user']);
    expect(req2.data.contents[1].parts[0]).toMatchObject({ functionCall: { name: 'delete_transaction' }, thoughtSignature: 'SIG-123' });
    expect(req2.data.contents[2].parts[0].functionResponse).toMatchObject({ name: 'delete_transaction', response: { error: expect.stringContaining('declined') } });
  });

  test('a new message while a card waits declines it; the transcript stays valid', async () => {
    const k = (await ctx.request.get('/api/ai/my/keys').set(auth(ann.token))).body.keys.find((x) => x.provider === 'openai');
    script = [{ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_transaction', arguments: JSON.stringify({ account_id: acc, amount: 5, type: 'expense' }) } }] } }] }];
    const r = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'add 5', key_id: k.id });
    expect(r.body.pending).toBe(1);
    script = [{ choices: [{ message: { content: 'OK, skipped.' } }] }];
    const r2 = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ thread_id: r.body.thread.id, message: 'never mind' });
    expect(r2.body.pending).toBe(0);
    expect(r2.body.messages[1].actions[0].status).toBe('declined');
    const msgs = lastPost().data.messages.map((m) => m.role);
    expect(msgs).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    // «Today» in the prompt is the person's local date (users.timezone).
    const tzToday = require('../lib/dates').todayISO('America/Toronto');
    expect(lastPost().data.messages[0].content).toContain(`Today is ${tzToday}.`);
  });

  test('isolation, no key, provider failures', async () => {
    const threads = (await ctx.request.get('/api/ai/my/threads').set(auth(ann.token))).body.threads;
    expect((await ctx.request.get(`/api/ai/my/threads/${threads[0].id}`).set(auth(bob.token))).status).toBe(404);
    expect((await ctx.request.post('/api/ai/my/chat').set(auth(bob.token)).send({ thread_id: threads[0].id, message: 'hi' })).status).toBe(404);

    const carl = await makeUser(ctx, 'carl');
    const n = await ctx.request.post('/api/ai/my/chat').set(auth(carl.token)).send({ message: 'hi' });
    expect(n.status).toBe(400);
    expect(n.body.code).toBe('AI_NO_KEY');

    script = [];
    const f = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'hello' });
    expect(f.status).toBe(502);
    expect(f.body.code).toBe('AI_PROVIDER_ERROR');
    expect(f.body.thread_id).toBeTruthy();
    expect(JSON.stringify(f.body)).not.toContain('sk-');
    const keys = (await ctx.request.get('/api/ai/my/keys').set(auth(ann.token))).body.keys;
    expect(keys.find((x) => x.is_default).last_error).toContain('500');

    const del = await ctx.request.delete(`/api/ai/my/threads/${threads[0].id}`).set(auth(ann.token));
    expect(del.body.deleted).toBe(true);
    expect((await ctx.request.get(`/api/ai/my/threads/${threads[0].id}`).set(auth(ann.token))).status).toBe(404);
  });

  test('a busy provider is retried, then reported as busy', async () => {
    const k = (await ctx.request.get('/api/ai/my/keys').set(auth(ann.token))).body.keys.find((x) => x.provider === 'openai');
    let n = 0;
    providers._setHttp((cfg) => {
      n += 1;
      if (n === 1) return Promise.resolve({ status: 503, data: { error: { message: 'overloaded' } } });
      return Promise.resolve({ status: 200, data: { choices: [{ message: { content: 'Back.' } }] } });
    }, 0);
    const ok = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'ping', key_id: k.id });
    expect(ok.status).toBe(200);
    expect(n).toBe(2);
    providers._setHttp(() => Promise.resolve({ status: 529, data: { error: { message: 'Overloaded' } } }), 0);
    const busy = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'ping', key_id: k.id });
    expect(busy.status).toBe(503);
    expect(busy.body.code).toBe('AI_BUSY');
    providers._setHttp(fakeHttp);
  });

  test('busy, silent or out-of-quota Gemini Flash hands the turn to Flash-Lite', async () => {
    const k = (await ctx.request.get('/api/ai/my/keys').set(auth(ann.token))).body.keys.find((x) => x.provider === 'google');
    expect(k.model).toBe('gemini-flash-latest');
    const seen = [];
    providers._setHttp((cfg) => {
      seen.push(cfg.url.match(/models\/([^:]+):/)[1]);
      if (/gemini-flash-latest/.test(cfg.url)) return Promise.resolve({ status: 503, data: { error: { message: 'high demand' } } });
      return Promise.resolve({ status: 200, data: { candidates: [{ content: { parts: [{ text: 'Lite here.' }] } }] } });
    }, 0);
    const ok = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'ping', key_id: k.id });
    expect(ok.status).toBe(200);
    expect(seen).toEqual(['gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest']);
    expect(ok.body.messages.filter((m) => m.role === 'assistant').pop().text).toBe('Lite here.');

    providers._setHttp((cfg) => {
      if (/gemini-flash-latest/.test(cfg.url)) { expect(cfg.timeout).toBe(40000); return Promise.reject(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })); }
      return Promise.resolve({ status: 503, data: { error: { message: 'busy too' } } });
    }, 0);
    const both = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'ping', key_id: k.id });
    const dayLimit = []; providers._setHttp((cfg) => {
      dayLimit.push(cfg.url);
      if (/gemini-flash-latest/.test(cfg.url)) return Promise.resolve({ status: 429, data: { error: { message: 'Quota exceeded, limit: 20' } } });
      return Promise.resolve({ status: 200, data: { candidates: [{ content: { parts: [{ text: 'Lite again.' }] } }] } });
    }, 0);
    const quota = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'ping', key_id: k.id });
    expect(quota.status).toBe(200);
    expect(dayLimit).toHaveLength(2);
    expect(both.status).toBe(504);
    expect(both.body.code).toBe('AI_TIMEOUT');
    providers._setHttp(fakeHttp);
  });

  test('a saved key that can no longer be decrypted asks to add it again', async () => {
    const k = (await ctx.request.get('/api/ai/my/keys').set(auth(ann.token))).body.keys.find((x) => x.provider === 'openai');
    const before = (await dbAll(ctx.db, 'SELECT key_enc FROM user_ai_keys WHERE id = ?', [k.id]))[0].key_enc;
    await dbRun(ctx.db, 'UPDATE user_ai_keys SET key_enc = ? WHERE id = ?', ['00:11:22', k.id]);
    const r = await ctx.request.post('/api/ai/my/chat').set(auth(ann.token)).send({ message: 'ping', key_id: k.id });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('AI_KEY_REJECTED');
    await dbRun(ctx.db, 'UPDATE user_ai_keys SET key_enc = ? WHERE id = ?', [before, k.id]);
  });

  test('deleting the account removes keys and conversations', async () => {
    const del = require('../services/accountDeletion');
    await del.deleteUserData(ann.id);
    for (const t of ['user_ai_keys', 'ai_agent_threads', 'ai_agent_messages', 'ai_agent_actions']) {
      expect([t, (await dbAll(ctx.db, `SELECT id FROM ${t} WHERE user_id = ?`, [ann.id])).length]).toEqual([t, 0]);
    }
  });
});
