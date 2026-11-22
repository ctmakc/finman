// test/statement-agent.test.js — Finman Statement Agent: PDF/photo statement -> AI reads rows ->
// Finman proves opening + rows = closing to the cent -> import only after the proof (and the
// person's tap / Confirm). The AI HTTP layer is faked (Gemini format on the person's own key):
// no request leaves the machine.
const { makeApp } = require('./helpers/app');
const PDFDocument = require('pdfkit');

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
const GEMINI_KEY = 'AIzaTest33333333333333333333Stmt';

// A small text-layer statement: opening 1,000.00, four rows, closing 2,309.50.
const ROWS = [
  ['2026-10-02', 'GROCERY MART #12', '-84.50', '915.50'],
  ['2026-10-05', 'RENT E-TRANSFER', '-1200.00', '-284.50'],
  ['2026-10-15', 'PAYROLL DEPOSIT', '2650.00', '2365.50'],
  ['2026-10-20', 'NETFLIX.COM', '-56.00', '2309.50'],
];
function makePdf({ rows = ROWS, opening = '1,000.00', closing = '2,309.50' } = {}) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(14).text('Test Bank - Chequing statement - SAMPLE DATA', 36, 40);
    doc.fontSize(9).text('Account 0000-111-2233   Period 2026-10-01 to 2026-10-31   CAD', 36, 62);
    let y = 90;
    if (opening) { doc.text('Opening balance', 36, y); doc.text(opening, 460, y); y += 16; }
    doc.text('Date', 36, y); doc.text('Description', 110, y); doc.text('Amount', 360, y); doc.text('Balance', 460, y); y += 14;
    for (const [d, desc, amt, bal] of rows) {
      const shown = (amt.startsWith('-') ? '-' : '') + Number(amt.replace('-', '')).toLocaleString('en-CA', { minimumFractionDigits: 2 });
      doc.text(d, 36, y); doc.text(desc, 110, y); doc.text(shown, 360, y);
      doc.text(Number(bal).toLocaleString('en-CA', { minimumFractionDigits: 2 }), 460, y);
      y += 14;
    }
    if (closing) { doc.text('Closing balance', 36, y + 6); doc.text(closing, 460, y + 6); }
    doc.end();
  });
}

const answer = (o) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 } });
const reading = (over = {}) => ({
  statement_type: 'bank', institution: 'Test Bank', account_ref: '0000-111-2233', currency: 'CAD',
  period_start: '2026-10-01', period_end: '2026-10-31', opening_balance: '1000.00', closing_balance: '2309.50',
  rows: ROWS.map(([date, description, amount, balance]) => ({ date, description, amount, balance, page: 1, unclear: false })),
  notes: null,
  ...over,
});

const calls = [];
let script = [];
function fakeHttp(cfg) {
  calls.push(cfg);
  if (cfg.method === 'GET' && /generativelanguage.*\/models/.test(cfg.url)) {
    return Promise.resolve({ status: 200, data: { models: [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }] } });
  }
  const next = script.shift();
  if (!next) return Promise.resolve({ status: 500, data: { error: { message: 'no scripted answer' } } });
  return Promise.resolve({ status: 200, data: next });
}
const genCalls = () => calls.filter((c) => /:generateContent$/.test(c.url));

describe('Statement Agent: proof (integer cents)', () => {
  const proof = require('../services/statement/proof');
  test('amount formats become integer cents', () => {
    expect(proof.toCents('1,234.56')).toBe(123456);
    expect(proof.toCents('1.234,56')).toBe(123456);
    expect(proof.toCents('(12.30)')).toBe(-1230);
    expect(proof.toCents('12.30-')).toBe(-1230);
    expect(proof.toCents('45.00 DR')).toBe(-4500);
    expect(proof.toCents('12.30 CR')).toBe(1230);
    expect(proof.toCents('AED 2,450.00')).toBe(245000);
    expect(proof.toCents('1,234')).toBe(123400);
    expect(proof.toCents(0.1 + 0.2)).toBe(30);
    expect(proof.toCents('abc')).toBeNull();
  });
  test('proven, gap with the first breaking row, card sign, missing closing', () => {
    const ok = proof.prove({ opening_cents: 10000, closing_cents: 7000, rows: [{ cents: -2000, balance_cents: 8000, page: 1 }, { cents: -1000, balance_cents: 7000, page: 2 }] });
    expect(ok.status).toBe('proven');
    const bad = proof.prove({ opening_cents: 10000, closing_cents: 7000, rows: [{ cents: -2000, balance_cents: 8000, page: 1 }, { cents: -1500, balance_cents: 7000, page: 2 }] });
    expect(bad.status).toBe('gap');
    expect(bad.gap_cents).toBe(500);
    expect(bad.first_break).toMatchObject({ index: 1, page: 2, expected_balance_cents: 6500, printed_balance_cents: 7000 });
    const card = proof.prove({ kind: 'card', opening_cents: 50000, closing_cents: 80000, rows: [{ cents: -40000 }, { cents: 10000 }] });
    expect(card.status).toBe('proven');
    expect(proof.prove({ opening_cents: 100, closing_cents: null, rows: [{ cents: 5 }] }).status).toBe('needs_closing');
  });
  test('an unreadable amount is derived only from the printed balances around it', () => {
    const d = proof.deriveUnclear([{ cents: -100, balance_cents: 900 }, { cents: null, unclear: true, balance_cents: 650 }], 1000);
    expect(d.derived).toEqual([1]);
    expect(d.rows[1]).toMatchObject({ cents: -250, derived: true });
    const none = proof.deriveUnclear([{ cents: -100 }, { cents: null, unclear: true }], 1000);
    expect(none.derived).toEqual([]);
  });
});

describe('Statement Agent: read, prove, import', () => {
  let ctx; let ann; let bob; let providers; let accId; let usdId;
  beforeAll(async () => {
    ctx = await makeApp();
    providers = require('../services/userAi/providers');
    providers._setHttp(fakeHttp, 0);
    require('../services/statement/agent')._setRetryDelay(0);
    ann = await makeUser(ctx, 'ann_st');
    bob = await makeUser(ctx, 'bob_st');
    const k = await ctx.request.post('/api/ai/my/keys').set(auth(ann.token)).send({ provider: 'google', key: GEMINI_KEY });
    expect(k.status).toBe(201);
    accId = (await dbRun(ctx.db, "INSERT INTO accounts (user_id, name, account_type, balance, currency) VALUES (?, 'Chequing', 'checking', 1000, 'CAD')", [ann.id])).id;
    usdId = (await dbRun(ctx.db, "INSERT INTO accounts (user_id, name, account_type, balance, currency) VALUES (?, 'USD', 'checking', 0, 'USD')", [ann.id])).id;
  });
  afterAll(async () => { providers._setHttp(null); await ctx.close(); });
  beforeEach(() => { calls.length = 0; script = []; });

  const upload = async (buf, user = ann, name = 'statement.pdf') => ctx.request.post('/api/statements').set(auth(user.token)).field('accountId', String(accId)).attach('file', buf, name);

  test('a PDF that balances is proven, then imported once, with usage recorded', async () => {
    script = [answer(reading())];
    const r = await upload(await makePdf());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'proven', mode: 'text', currency: 'CAD', account_last4: '2233', can_import: true });
    expect(r.body.proof.line).toMatch(/matches the printed closing 2,309\.50 to the cent/);
    expect(r.body.rows).toHaveLength(4);
    expect(r.body.usage).toMatchObject({ ai: 'user', calls: 1, tokens_in: 1200, tokens_out: 300 });
    expect(r.body.plan).toMatchObject({ estimate: true, income_30d_cents: expect.any(Number) });
    // The text layer went to the model, not the file; the key only in a header.
    const g = genCalls()[0];
    expect(JSON.stringify(g.data)).toContain('GROCERY MART #12');
    expect(g.url).not.toContain(GEMINI_KEY);
    expect(g.headers['x-goog-api-key']).toBe(GEMINI_KEY);

    expect((await dbAll(ctx.db, 'SELECT id FROM transactions WHERE account_id = ?', [accId]))).toHaveLength(0);
    const c = await ctx.request.post(`/api/statements/${r.body.id}/commit`).set(auth(ann.token)).send({ accountId: accId });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ inserted: 4, skipped: 0, balance_delta: 1309.5, new_balance: 2309.5 });
    const again = await ctx.request.post(`/api/statements/${r.body.id}/commit`).set(auth(ann.token)).send({ accountId: accId });
    expect(again.status).toBe(409);

    // The same statement uploaded again: every row is marked as already in the account.
    script = [answer(reading())];
    const r2 = await upload(await makePdf());
    expect(r2.body.counts).toMatchObject({ rows: 4, duplicates: 4, new: 0 });
    const c2 = await ctx.request.post(`/api/statements/${r2.body.id}/commit`).set(auth(ann.token)).send({ accountId: accId });
    expect(c2.body).toMatchObject({ inserted: 0, skipped: 4 });
  });

  test('a misread digit is re-read on that page only, and then proven', async () => {
    const bad = reading();
    bad.rows[1] = { ...bad.rows[1], amount: '-1260.00' };
    script = [answer(bad), answer(reading({ opening_balance: '1000.00' }))];
    const r = await upload(await makePdf());
    expect(r.body.status).toBe('proven');
    expect(r.body.attempts.map((a) => a.status)).toEqual(['gap', 'proven']);
    expect(r.body.attempts[1].scope).toBe('page 1');
    expect(genCalls()).toHaveLength(2);
    // The re-read prompt never tells the model the expected number.
    expect(JSON.stringify(genCalls()[1].data)).not.toMatch(/2,?309\.50 is expected|expected balance/i);
  });

  test('a statement that does not balance is never imported, the gap and row are shown', async () => {
    // Printed table misses one row (the bank-side running balances are right): a real gap.
    const dropped = ROWS.filter((_, i) => i !== 1);
    const pdf = await makePdf({ rows: dropped });
    const rd = reading({ rows: dropped.map(([date, description, amount, balance]) => ({ date, description, amount, balance, page: 1 })) });
    script = [answer(rd), answer(rd), answer(rd)];
    const r = await upload(pdf);
    expect(r.body.status).toBe('gap');
    expect(r.body.can_import).toBe(false);
    expect(r.body.proof.gap_cents).toBe(-120000);
    expect(r.body.proof.first_break).toMatchObject({ index: 1, page: 1 });
    expect(r.body.proof.line).toMatch(/gap -1,200\.00; the balance chain first breaks at row 2 \(page 1\)/);
    expect(genCalls()).toHaveLength(3); // first read + 2 re-reads, then stop
    expect(r.body.plan).toBeNull();
    const before = (await dbAll(ctx.db, 'SELECT id FROM transactions WHERE account_id = ?', [accId])).length;
    const c = await ctx.request.post(`/api/statements/${r.body.id}/commit`).set(auth(ann.token)).send({ accountId: accId });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('STATEMENT_NOT_PROVEN');
    expect((await dbAll(ctx.db, 'SELECT id FROM transactions WHERE account_id = ?', [accId])).length).toBe(before);
  });

  test('an amount that is not printed on the page is caught (grounding)', async () => {
    const invented = reading({ closing_balance: '2309.50' });
    invented.rows.push({ date: '2026-10-21', description: 'COFFEE', amount: '-4.44', balance: null, page: 1 });
    invented.rows[3] = { ...invented.rows[3], amount: '-51.56' }; // keeps the totals equal
    script = [answer(invented), answer(invented), answer(invented)];
    const r = await upload(await makePdf());
    expect(r.body.status).not.toBe('proven');
    expect(r.body.proof.ungrounded_rows.length).toBeGreaterThan(0);
  });

  test('no closing balance: the person types it, Finman proves it, no AI call', async () => {
    script = [answer(reading({ closing_balance: null }))];
    const r = await upload(await makePdf({ closing: null }));
    expect(r.body.status).toBe('needs_closing');
    calls.length = 0;
    const wrong = await ctx.request.post(`/api/statements/${r.body.id}/balances`).set(auth(ann.token)).send({ closing_balance: '2300.00' });
    expect(wrong.body.status).toBe('gap');
    const ok = await ctx.request.post(`/api/statements/${r.body.id}/balances`).set(auth(ann.token)).send({ closing_balance: '2,309.50' });
    expect(ok.body).toMatchObject({ status: 'proven', balances_typed: true });
    expect(ok.body.proof.line).toMatch(/typed by you/);
    expect(genCalls()).toHaveLength(0);
  });

  test('a photo goes to the vision path; currency mismatch is refused', async () => {
    script = [answer(reading())];
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    const r = await upload(jpg, ann, 'page.jpg');
    expect(r.body).toMatchObject({ mode: 'photo', status: 'proven' });
    const part = genCalls()[0].data.contents[0].parts[0];
    expect(part.inline_data.mime_type).toBe('image/jpeg');
    const c = await ctx.request.post(`/api/statements/${r.body.id}/commit`).set(auth(ann.token)).send({ accountId: usdId });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('STATEMENT_CURRENCY');
  });

  test('other people cannot see a statement; files other than PDF/images are refused', async () => {
    script = [answer(reading())];
    const r = await upload(await makePdf());
    expect((await ctx.request.get(`/api/statements/${r.body.id}`).set(auth(bob.token))).status).toBe(404);
    expect((await ctx.request.post(`/api/statements/${r.body.id}/commit`).set(auth(bob.token)).send({ accountId: accId })).status).toBe(404);
    const txt = await ctx.request.post('/api/statements').set(auth(ann.token)).attach('file', Buffer.from('date,amount\n'), 'a.csv');
    expect(txt.status).toBe(400);
    expect(txt.body.code).toBe('STATEMENT_TYPE');
  });

  test('without any AI the person is told to connect one (CSV still works)', async () => {
    const r = await ctx.request.post('/api/statements').set(auth(bob.token)).attach('file', await makePdf(), 's.pdf');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('STATEMENT_NO_AI');
  });

  test('MCP / assistant: import_statement proves rows from an outside AI before writing', async () => {
    const tools = require('../services/mcp/tools');
    expect(tools.isReadOnly('import_statement')).toBe(false);
    expect(tools.isReadOnly('get_statement')).toBe(true);
    const acc2 = (await dbRun(ctx.db, "INSERT INTO accounts (user_id, name, account_type, balance, currency) VALUES (?, 'Card', 'checking', 0, 'CAD')", [ann.id])).id;
    const rows = [{ date: '2026-11-01', description: 'A', amount: -10.5 }, { date: '2026-11-02', description: 'B', amount: 100 }];
    const no = await tools.callTool(ann.id, 'import_statement', { account_id: acc2, opening_balance: 50, closing_balance: 140, rows });
    expect(no.isError).toBe(true);
    expect(no.content[0].text).toMatch(/Nothing imported/);
    expect((await dbAll(ctx.db, 'SELECT id FROM transactions WHERE account_id = ?', [acc2]))).toHaveLength(0);
    const yes = await tools.callTool(ann.id, 'import_statement', { account_id: acc2, opening_balance: 50, closing_balance: 139.5, rows, currency: 'CAD' });
    expect(yes.isError).toBe(false);
    expect(yes.structuredContent).toMatchObject({ imported: true, inserted: 2 });
    const list = await tools.callTool(ann.id, 'list_statements', {});
    expect(list.structuredContent.statements.length).toBeGreaterThan(3);
  });
});

describe('Statement Agent: date check', () => {
  const { dateIssues } = require('../services/statement/agent');
  test('dates outside the period or out of order are flagged; the amounts proof alone is not enough', () => {
    const m = { period_start: '2026-10-01', period_end: '2026-10-31' };
    const rows = [{ date: '2026-10-02' }, { date: '2026-10-05' }, { date: '2026-01-07' }, { date: '2026-10-09' }, { date: '2026-12-25' }];
    expect(dateIssues(m, rows)).toEqual([2, 4]);
    expect(dateIssues({}, [{ date: '2026-10-02' }, { date: '2026-10-20' }, { date: '2026-10-05' }, { date: '2026-10-06' }])).toEqual([1]);
    expect(dateIssues(m, [{ date: '2026-10-02' }, { date: '2026-10-02' }, { date: '2026-10-03' }])).toEqual([]);
  });
});

describe('Statement Agent: phantom lines', () => {
  const agent = require('../services/statement/agent');
  test('a line without an amount and with an unchanged balance is left out, not imported as 0.00', () => {
    const m = { statement_type: 'bank', opening_cents: 10000, closing_cents: 12500, period_start: '2026-10-01', period_end: '2026-10-31' };
    const rows = [
      { date: '2026-10-02', description: 'PAYROLL', cents: 2500, balance_cents: 12500, page: 1 },
      { date: '2026-10-02', description: 'PAYROLL', cents: null, unclear: true, balance_cents: 12500, page: 1 },
    ];
    const c = agent.check(m, rows, null);
    expect(c.rows).toHaveLength(1);
    expect(c.proof.status).toBe('proven');
    expect(c.proof.phantom_rows).toBe(1);
    expect(c.proof.line).toMatch(/left out/);
  });
});
