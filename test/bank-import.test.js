// test/bank-import.test.js — honest bank connectivity + statement import.
//
// Covers: CSV primitives (delimiter, quotes, dates, amounts), every bank preset
// against a synthetic fixture, generic auto-mapping, OFX 1.x (SGML) and 2.x
// (XML), fingerprint dedupe, and the HTTP flow /banks -> /import/preview ->
// /import/commit (balance updated once, re-import skips duplicates, IDOR).

const fs = require('fs');
const path = require('path');
const { makeApp } = require('./helpers/app');

const PROJECT_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'bank-import');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const csv = require(path.join(PROJECT_ROOT, 'services', 'csvImportService.js'));
const ofx = require(path.join(PROJECT_ROOT, 'services', 'ofxImportService.js'));
const bankConfig = require(path.join(PROJECT_ROOT, 'config', 'bank-api-config.js'));

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
describe('csvImportService primitives', () => {
  test('parseDate handles ISO, slash (MDY/DMY), dot, compact and month-name forms', () => {
    expect(csv.parseDate('2026-10-09')).toBe('2026-10-09');
    expect(csv.parseDate('2026/10/09')).toBe('2026-10-09');
    expect(csv.parseDate('2026-10-09 14:22:01')).toBe('2026-10-09');
    expect(csv.parseDate('2026-10-09T14:22:01Z')).toBe('2026-10-09');
    expect(csv.parseDate('10/09/2026', 'MDY')).toBe('2026-10-09');
    expect(csv.parseDate('09/10/2026', 'DMY')).toBe('2026-10-09');
    expect(csv.parseDate('09.10.2026')).toBe('2026-10-09');
    expect(csv.parseDate('09.10.2026 18:40:01')).toBe('2026-10-09');
    expect(csv.parseDate('20261009')).toBe('2026-10-09');
    expect(csv.parseDate('09-10-2026', 'DMY')).toBe('2026-10-09');
    expect(csv.parseDate('Oct 9, 2026')).toBe('2026-10-09');
    expect(csv.parseDate('9 Oct 2026')).toBe('2026-10-09');
    expect(csv.parseDate('10/1/2026', 'MDY')).toBe('2026-10-01');
    // auto: a day > 12 disambiguates
    expect(csv.parseDate('25/10/2026')).toBe('2026-10-25');
    expect(csv.parseDate('10/25/2026')).toBe('2026-10-25');
    expect(csv.parseDate('not a date')).toBeNull();
    expect(csv.parseDate('2026-13-40')).toBeNull();
    expect(csv.parseDate('2026-02-31')).toBeNull();
    expect(csv.parseDate('31/02/2026')).toBeNull();
    expect(csv.parseDate('29/02/2028')).toBe('2028-02-29');
    expect(csv.parseDate('')).toBeNull();
  });

  test('inferDateOrder reads day-first vs month-first from a column', () => {
    expect(csv.inferDateOrder(['01/10/2026', '25/10/2026'])).toBe('DMY');
    expect(csv.inferDateOrder(['10/01/2026', '10/25/2026'])).toBe('MDY');
    expect(csv.inferDateOrder(['01/02/2026'])).toBeNull();
  });

  test('parseAmount handles thousands separators, comma decimals, parentheses, CR/DR, trailing minus', () => {
    expect(csv.parseAmount('1,234.56')).toBe(1234.56);
    expect(csv.parseAmount('1 234,56')).toBe(1234.56);
    expect(csv.parseAmount('1.234,56')).toBe(1234.56);
    expect(csv.parseAmount('-845,30')).toBe(-845.3);
    expect(csv.parseAmount('12,5')).toBe(12.5);
    expect(csv.parseAmount('(45.00)')).toBe(-45);
    expect(csv.parseAmount('-$45.00')).toBe(-45);
    expect(csv.parseAmount('$2,450.00')).toBe(2450);
    expect(csv.parseAmount('45.00 CR')).toBe(45);
    expect(csv.parseAmount('45.00 DR')).toBe(-45);
    expect(csv.parseAmount('45.00-')).toBe(-45);
    expect(csv.parseAmount('CAD 10.00')).toBe(10);
    expect(csv.parseAmount('')).toBeNull();
    expect(csv.parseAmount('—')).toBeNull();
    expect(csv.parseAmount('abc')).toBeNull();
  });

  test('detectDelimiter picks comma, semicolon, tab', () => {
    expect(csv.detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(csv.detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(csv.detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    // commas inside quotes do not fool the semicolon detection
    expect(csv.detectDelimiter('Datum;Text;Betrag\n09.10.2026;"REWE, Berlin";-23,45')).toBe(';');
  });

  test('parseCsv handles quotes, doubled quotes, embedded newlines, CRLF and BOM', () => {
    const rows = csv.parseCsv('﻿a,b\r\n"x ""y""","multi\nline"\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x "y"', 'multi\nline']
    ]);
  });

  test('detectHeader distinguishes a header row from data', () => {
    expect(csv.detectHeader([['Date', 'Description', 'Amount'], ['2026-10-01', 'Coffee', '-4.50']])).toBe(true);
    expect(csv.detectHeader([['10/01/2026', 'PAYROLL', '', '2450.00', '3120.55'], ['10/02/2026', 'X', '1', '', '2']])).toBe(false);
  });

  test('skipPreamble drops narrow leading rows (BMO "valid as of" line)', () => {
    const rows = csv.skipPreamble([['Following data is valid as of 20261009120000:'], ['A', 'B', 'C'], ['1', '2', '3']]);
    expect(rows[0]).toEqual(['A', 'B', 'C']);
  });

  test('fingerprintOf is stable across case and whitespace, sensitive to amount', () => {
    const a = csv.fingerprintOf('2026-10-02', -84.17, 'LOBLAWS #1234');
    expect(csv.fingerprintOf('2026-10-02', -84.17, '  loblaws   #1234 ')).toBe(a);
    expect(csv.fingerprintOf('2026-10-02', -84.18, 'LOBLAWS #1234')).not.toBe(a);
    expect(csv.fingerprintOf('2026-10-03', -84.17, 'LOBLAWS #1234')).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
describe('CSV presets detect their bank export and normalise rows', () => {
  const cases = [
    { file: 'rbc.csv', preset: 'rbc', valid: 5, hasHeader: true, first: { date: '2026-10-01', amount: 2450, description: 'PAYROLL DEPOSIT · ACME CORP' }, sum: 2224.03 },
    { file: 'td.csv', preset: 'td', valid: 5, hasHeader: false, first: { date: '2026-10-01', amount: 2450 }, second: { amount: -61.23 }, sum: 2246.97 },
    { file: 'cibc.csv', preset: 'cibc', valid: 4, hasHeader: false, first: { date: '2026-10-01', amount: 2450 }, second: { amount: -54.1 } },
    { file: 'cibc-card.csv', preset: 'cibc', valid: 2, hasHeader: false, first: { date: '2026-10-02', amount: -54.1 } },
    { file: 'scotiabank.csv', preset: 'scotiabank', valid: 4, hasHeader: false, first: { date: '2026-10-01', amount: 2450, description: 'PAYROLL DEPOSIT ACME' }, second: { amount: -45.67 } },
    { file: 'bmo.csv', preset: 'bmo', valid: 3, hasHeader: true, first: { date: '2026-10-01', amount: -84.17 }, sum: 2360.98 },
    { file: 'tangerine.csv', preset: 'tangerine', valid: 4, hasHeader: true, first: { date: '2026-10-01', amount: 2450 }, second: { amount: -231.4 } },
    { file: 'wealthsimple.csv', preset: 'wealthsimple', valid: 3, hasHeader: true, first: { date: '2026-10-01', amount: 2450, currency: 'CAD' } },
    { file: 'eqbank.csv', preset: 'eqbank', valid: 3, hasHeader: true, first: { date: '2026-10-01', amount: 12.34 }, sum: -737.66 },
    { file: 'monobank.csv', preset: 'monobank', valid: 4, hasHeader: true, first: { date: '2026-10-01', amount: -845.3, currency: 'UAH', category: 'Groceries' } },
    { file: 'revolut.csv', preset: 'revolut', valid: 3, hasHeader: true, first: { date: '2026-10-02', amount: -12.5, currency: 'EUR' }, skipped: 2 },
    { file: 'wise.csv', preset: 'wise', valid: 3, hasHeader: true, first: { date: '2026-10-01', amount: -250, currency: 'CAD', externalId: 'TRANSFER-123456' } }
  ];

  test.each(cases)('$file -> preset $preset', (c) => {
    const p = csv.previewCsv(read(c.file));
    expect(p.kind).toBe('csv');
    expect(p.preset).not.toBeNull();
    expect(p.preset.id).toBe(c.preset);
    expect(p.detected).toBe(true);
    expect(p.hasHeader).toBe(c.hasHeader);
    expect(p.stats.errors).toBe(0);
    expect(p.stats.valid).toBe(c.valid);
    if (c.skipped != null) expect(p.stats.skipped).toBe(c.skipped);
    if (c.sum != null) expect(p.stats.sum).toBe(c.sum);
    const valid = p.rows.filter((r) => !r.error && !r.skipped);
    expect(valid[0]).toMatchObject(c.first);
    if (c.second) expect(valid[1]).toMatchObject(c.second);
    for (const r of valid) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof r.amount).toBe('number');
      expect(r.type).toBe(r.amount >= 0 ? 'income' : 'expense');
      expect(r.fingerprint).toMatch(/^[0-9a-f]{20}$/);
      expect(r.description.length).toBeGreaterThan(0);
    }
  });

  test('every preset carries a verified flag and maps to a file-import bank', () => {
    const presets = csv.listPresets();
    expect(presets.length).toBeGreaterThanOrEqual(11);
    const bankIds = bankConfig.listBanks().map((b) => b.id);
    for (const p of presets) {
      expect(typeof p.verified).toBe('boolean');
      expect(bankIds).toContain(p.bankId);
    }
    expect(presets.find((p) => p.id === 'revolut').verified).toBe(true);
    expect(presets.find((p) => p.id === 'wise').verified).toBe(true);
    expect(presets.find((p) => p.id === 'rbc').verified).toBe(false);
  });

  test('Revolut: only COMPLETED rows import, fee is subtracted', () => {
    const p = csv.previewCsv(read('revolut.csv'));
    const exchange = p.rows.find((r) => r.description === 'Exchanged to USD');
    expect(exchange.amount).toBe(-201); // -200 amount, 1.00 fee
    expect(p.rows.filter((r) => r.skipped).map((r) => r.skipped)).toEqual(['state pending', 'state reverted']);
  });

  test('Monobank: MCC drives the category, currency comes from the amount header', () => {
    const p = csv.previewCsv(read('monobank.csv'));
    const bolt = p.rows.find((r) => r.description === 'Bolt');
    expect(bolt.category).toBe('Transport');
    expect(bolt.currency).toBe('UAH');
    expect(p.rows.find((r) => r.description === 'Netflix.com').category).toBe('Entertainment');
  });

  test('TD: debit and credit columns become one signed amount', () => {
    const p = csv.previewCsv(read('td.csv'));
    expect(p.mapping.debit).toBe(2);
    expect(p.mapping.credit).toBe(3);
    expect(p.rows.map((r) => r.amount)).toEqual([2450, -61.23, -120, -4.85, -16.95]);
    expect(p.rows[1].description).toBe('NO FRILLS #412'); // fixed-width padding trimmed
  });

  test('a forced preset wins over detection; unknown preset throws', () => {
    const p = csv.previewCsv(read('td.csv'), { presetId: 'td' });
    expect(p.preset.id).toBe('td');
    expect(p.detected).toBe(false);
    expect(() => csv.previewCsv(read('td.csv'), { presetId: 'nope' })).toThrow(/Unknown preset/);
  });
});

// ---------------------------------------------------------------------------
// Generic mapper
// ---------------------------------------------------------------------------
describe('generic CSV auto-mapping', () => {
  test('German semicolon export with comma decimals and dot thousands', () => {
    const p = csv.previewCsv(read('generic-semicolon.csv'));
    expect(p.preset).toBeNull();
    expect(p.delimiter).toBe(';');
    expect(p.hasHeader).toBe(true);
    expect(p.mapping.date).toBe(0);
    expect(p.mapping.amount).toBe(2);
    expect(p.rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-10-09', -23.45],
      ['2026-10-10', 2500]
    ]);
  });

  test('Withdrawals/Deposits columns + in-file duplicate flagged', () => {
    const p = csv.previewCsv(read('generic-debit-credit.csv'));
    expect(p.preset).toBeNull();
    expect(p.mapping.debit).toBe(2);
    expect(p.mapping.credit).toBe(3);
    expect(p.mapping.balance).toBe(4);
    expect(p.rows.map((r) => r.amount)).toEqual([-4.5, 2000, -4.5, -4.5]);
    expect(p.rows.map((r) => r.duplicate)).toEqual([null, null, null, 'file']);
    expect(p.stats.duplicates).toBe(1);
    expect(p.stats.valid).toBe(3);
  });

  test('manual mapping overrides detection and dateOrder can be forced', () => {
    const text = 'When,What,How much\n05/01/2026,Lunch,-12.00\n';
    const p = csv.previewCsv(text, { mapping: { date: 'When', description: 'What', amount: 'How much' }, dateOrder: 'DMY' });
    expect(p.mappingSource).toBe('manual');
    expect(p.rows[0].date).toBe('2026-01-05');
    const q = csv.previewCsv(text, { mapping: { date: 0, description: 1, amount: 2 }, dateOrder: 'MDY' });
    expect(q.rows[0].date).toBe('2026-05-01');
  });

  test('rows with unparseable dates are reported, not dropped silently', () => {
    const p = csv.previewCsv('Date,Description,Amount\nyesterday,Coffee,-4.50\n2026-10-01,Tea,-3.00\n');
    expect(p.rows[0].error).toMatch(/Unrecognised date/);
    expect(p.stats.errors).toBe(1);
    expect(p.stats.valid).toBe(1);
  });

  test('existing fingerprints mark rows as already imported', () => {
    const first = csv.previewCsv(read('rbc.csv'));
    const existing = new Set(first.rows.slice(0, 2).map((r) => r.fingerprint));
    const again = csv.previewCsv(read('rbc.csv'), { existingFingerprints: existing });
    expect(again.rows.map((r) => r.duplicate)).toEqual(['existing', 'existing', null, null, null]);
    expect(again.stats.duplicates).toBe(2);
  });

  test('processCSVFile keeps the legacy /api/transactions/import contract', async () => {
    const out = await csv.processCSVFile(path.join(FIXTURES, 'rbc.csv'), { accountId: 7, userId: 3 });
    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({ accountId: 7, userId: 3, date: '2026-10-01', amount: 2450, type: 'income' });
  });
});

// ---------------------------------------------------------------------------
// OFX
// ---------------------------------------------------------------------------
describe('ofxImportService', () => {
  test('detects OFX and its version', () => {
    expect(ofx.isOfx(read('sample-ofx1.qfx'))).toBe(true);
    expect(ofx.isOfx(read('sample-ofx2.ofx'))).toBe(true);
    expect(ofx.isOfx(read('rbc.csv'))).toBe(false);
    expect(ofx.detectVersion(read('sample-ofx1.qfx'))).toBe('1');
    expect(ofx.detectVersion(read('sample-ofx2.ofx'))).toBe('2');
  });

  test('OFX 1.x SGML (QFX): statement, account, balance, transactions, cheque number, empty MEMO', () => {
    const p = ofx.previewOfx(read('sample-ofx1.qfx'));
    expect(p.kind).toBe('ofx');
    expect(p.version).toBe('1');
    expect(p.accounts).toHaveLength(1);
    expect(p.accounts[0]).toMatchObject({ accountId: '5678901', bankId: '000300001', accountType: 'CHECKING', currency: 'CAD', balance: 2917.52, balanceDate: '2026-10-09', dateStart: '2026-10-01', dateEnd: '2026-10-09' });
    expect(p.stats.errors).toBe(0);
    expect(p.rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-10-01', 2450],
      ['2026-10-02', -84.17],
      ['2026-10-03', -120],
      ['2026-10-05', -16.95]
    ]);
    expect(p.rows[0]).toMatchObject({ description: 'PAYROLL DEPOSIT · ACME CORP', category: 'Salary', externalId: '2026100100001', currency: 'CAD' });
    expect(p.rows[2].description).toBe('Cheque · cheque 101');
    expect(p.rows[3].description).toBe('MONTHLY FEE'); // memo repeating name is not duplicated
    expect(p.rows[3].category).toBe('Bank Fees');
    expect(p.rows.every((r) => /^[0-9a-f]{20}$/.test(r.fingerprint))).toBe(true);
  });

  test('OFX 2.x XML: credit-card statement, entity decoding, DEBIT/CREDIT signs', () => {
    const p = ofx.previewOfx(read('sample-ofx2.ofx'));
    expect(p.version).toBe('2');
    expect(p.accounts[0]).toMatchObject({ accountId: '4500XXXXXXXX1234', accountType: 'CREDITCARD', currency: 'CAD', balance: -441.05 });
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toMatchObject({ date: '2026-10-02', amount: -54.1, description: 'METRO #123 OTTAWA · Groceries & more', externalId: 'CC-0001' });
    expect(p.rows[1]).toMatchObject({ date: '2026-10-04', amount: 500, type: 'income' });
    expect(p.rows[2].description).toBe('TIM HORTONS #0421');
    expect(p.stats.sum).toBe(441.05);
  });

  test('a DEBIT with a positive TRNAMT is normalised to negative; same FITID twice is a file duplicate', () => {
    const body = `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD\n<BANKACCTFROM><ACCTID>1\n<ACCTTYPE>SAVINGS\n</BANKACCTFROM>\n<BANKTRANLIST>\n<STMTTRN><TRNTYPE>DEBIT\n<DTPOSTED>20261001\n<TRNAMT>10.00\n<FITID>A1\n<NAME>Shop\n</STMTTRN>\n<STMTTRN><TRNTYPE>DEBIT\n<DTPOSTED>20261001\n<TRNAMT>10.00\n<FITID>A1\n<NAME>Shop\n</STMTTRN>\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const p = ofx.previewOfx(body);
    expect(p.rows[0].amount).toBe(-10);
    expect(p.rows[1].duplicate).toBe('file');
  });

  test('a file without a statement is rejected with a clear message', () => {
    expect(() => ofx.previewOfx('OFXHEADER:100\n<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>')).toThrow(/STMTRS/);
    expect(() => ofx.previewOfx('hello')).toThrow(/<OFX>/);
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function seedAccount(ctx, userId, overrides = {}) {
  const a = { name: 'Chequing', number: 'acc-1', bank: 'RBC Royal Bank', currency: 'CAD', balance: 1000, ...overrides };
  return new Promise((resolve, reject) => {
    ctx.db.run(
      `INSERT INTO accounts (user_id, name, account_number, bank_name, currency, balance, account_type)
       VALUES (?, ?, ?, ?, ?, ?, 'checking')`,
      [userId, a.name, a.number, a.bank, a.currency, a.balance],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}
function dbGet(ctx, sql, params) {
  return new Promise((resolve, reject) => ctx.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}
function dbAll(ctx, sql, params) {
  return new Promise((resolve, reject) => ctx.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

describe('HTTP /api/bank-api', () => {
  let ctx;
  let auth;
  let accountId;
  let otherToken;

  beforeAll(async () => {
    ctx = await makeApp();
    auth = { Authorization: `Bearer ${ctx.token}` };
    accountId = await seedAccount(ctx, ctx.userId);

    // Second user for IDOR checks.
    const config = require(path.join(PROJECT_ROOT, 'config', 'config.js'));
    const jwt = require('jsonwebtoken');
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('password123', 4);
    const other = await new Promise((resolve, reject) =>
      ctx.db.run(`INSERT INTO users (username, email, password, full_name) VALUES ('other', 'other@example.com', ?, 'Other')`, [hash], function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      })
    );
    otherToken = jwt.sign({ id: other }, config.jwtSecret, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /banks is the honest list: token | file-import, no invented OAuth banks', async () => {
    const res = await ctx.request.get('/api/bank-api/banks').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['monobank', 'rbc', 'td_canada', 'scotiabank', 'bmo', 'cibc', 'tangerine', 'wealthsimple_cash', 'eq_bank', 'revolut', 'wise']));
    for (const removed of ['privatbank', 'pumb', 'oschadbank', 'paypal', 'plaid', 'test', 'tinkoff', 'sberbank', 'vtb', 'alfabank']) {
      expect(ids).not.toContain(removed);
    }
    for (const b of res.body) {
      expect(['token', 'file-import']).toContain(b.type);
      expect(b.requiresRedirect).toBe(false);
      expect(typeof b.verified).toBe('boolean');
    }
    const mono = res.body.find((b) => b.id === 'monobank');
    expect(mono.type).toBe('token');
    expect(mono.tokenInstructions).toMatch(/Monobank/);
    const rbc = res.body.find((b) => b.id === 'rbc');
    expect(rbc).toMatchObject({ type: 'file-import', csvPreset: 'rbc', verified: false });
    expect(rbc.formats).toEqual(expect.arrayContaining(['csv', 'qfx']));
    // the old config never had an OAuth stub survive
    expect(res.body.some((b) => b.authType === 'oauth2')).toBe(false);
  });

  test('GET /banks?type=token filters; /supported-banks and /banks-by-region still answer', async () => {
    const tok = await ctx.request.get('/api/bank-api/banks?type=token').set(auth);
    expect(tok.body.map((b) => b.id)).toEqual(['monobank']);
    const legacy = await ctx.request.get('/api/bank-api/supported-banks?region=canada').set(auth);
    expect(legacy.status).toBe(200);
    expect(legacy.body.every((b) => b.region === 'canada')).toBe(true);
    const grouped = await ctx.request.get('/api/bank-api/banks-by-region').set(auth);
    expect(grouped.status).toBe(200);
    expect(Object.keys(grouped.body)).toEqual(expect.arrayContaining(['ukraine', 'canada', 'international']));
    expect(grouped.body.canada.banks.length).toBe(8);
  });

  test('GET /import/presets lists presets with verified flags', async () => {
    const res = await ctx.request.get('/api/bank-api/import/presets').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.presets.map((p) => p.id)).toEqual(expect.arrayContaining(['rbc', 'td', 'revolut', 'wise', 'monobank']));
    expect(res.body.formats).toEqual(expect.arrayContaining(['csv', 'ofx', 'qfx']));
  });

  test('POST /connect/:bankId refuses a file-import bank with FILE_IMPORT_ONLY and allows Monobank', async () => {
    const td = await ctx.request.post('/api/bank-api/connect/td_canada').set(auth);
    expect(td.status).toBe(400);
    expect(td.body.code).toBe('FILE_IMPORT_ONLY');
    expect(td.body.exportHint).toMatch(/EasyWeb/);
    const mono = await ctx.request.post('/api/bank-api/connect/monobank').set(auth);
    expect(mono.status).toBe(200);
    expect(mono.body.directAuth).toBe(true);
    expect(mono.body.url).toBeNull();
    const nope = await ctx.request.post('/api/bank-api/connect/tinkoff').set(auth);
    expect(nope.status).toBe(400);
  });

  test('POST /connect/monobank/direct verifies the token against the bank before storing', async () => {
    const bankApiService = require(path.join(PROJECT_ROOT, 'services', 'bankApiService.js'));
    const original = bankApiService.verifyToken;
    bankApiService.verifyToken = jest.fn(async (bankId, token) =>
      token === 'good' ? { ok: true, clientName: 'Max', accounts: 2 } : { ok: false, message: 'Monobank rejected the token (403).' }
    );
    try {
      const bad = await ctx.request.post('/api/bank-api/connect/monobank/direct').set(auth).send({ apiKey: 'bad' });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toMatch(/403/);
      const none = await ctx.request.post('/api/bank-api/connect/monobank/direct').set(auth).send({});
      expect(none.status).toBe(400);
      const good = await ctx.request.post('/api/bank-api/connect/monobank/direct').set(auth).send({ apiKey: 'good' });
      expect(good.status).toBe(200);
      expect(good.body).toMatchObject({ success: true, bankName: 'Monobank', verified: true, clientName: 'Max' });
      const fileBank = await ctx.request.post('/api/bank-api/connect/rbc/direct').set(auth).send({ apiKey: 'x' });
      expect(fileBank.status).toBe(400);
      const conns = await ctx.request.get('/api/bank-api/connections').set(auth);
      expect(conns.body).toHaveLength(1);
      expect(conns.body[0]).toMatchObject({ bankId: 'monobank', bankName: 'Monobank', type: 'token', isActive: true });
    } finally {
      bankApiService.verifyToken = original;
    }
  });

  test('POST /import/preview parses an RBC CSV, detects the preset and reports no duplicates on an empty account', async () => {
    const res = await ctx.request
      .post('/api/bank-api/import/preview')
      .set(auth)
      .field('accountId', String(accountId))
      .attach('file', path.join(FIXTURES, 'rbc.csv'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.kind).toBe('csv');
    expect(res.body.preset.id).toBe('rbc');
    expect(res.body.preset.verified).toBe(false);
    expect(res.body.accountId).toBe(accountId);
    expect(res.body.accountCurrency).toBe('CAD');
    expect(res.body.rows).toHaveLength(5);
    expect(res.body.stats).toMatchObject({ valid: 5, duplicates: 0, errors: 0 });
    expect(res.body.columnNames).toContain('Description 1');
  });

  test('POST /import/preview accepts an OFX 1.x QFX and an OFX 2.x file', async () => {
    const qfx = await ctx.request.post('/api/bank-api/import/preview').set(auth).attach('file', path.join(FIXTURES, 'sample-ofx1.qfx'));
    expect(qfx.status).toBe(200);
    expect(qfx.body.kind).toBe('ofx');
    expect(qfx.body.version).toBe('1');
    expect(qfx.body.rows).toHaveLength(4);
    const xml = await ctx.request.post('/api/bank-api/import/preview').set(auth).attach('file', path.join(FIXTURES, 'sample-ofx2.ofx'));
    expect(xml.status).toBe(200);
    expect(xml.body.version).toBe('2');
    expect(xml.body.accounts[0].accountType).toBe('CREDITCARD');
  });

  test('POST /import/preview honours presetId, hasHeader, delimiter and a manual mapping', async () => {
    const res = await ctx.request
      .post('/api/bank-api/import/preview')
      .set(auth)
      .field('presetId', 'generic')
      .field('hasHeader', 'true')
      .field('delimiter', ';')
      .field('dateOrder', 'DMY')
      .field('mapping', JSON.stringify({ date: 'Datum', description: 'Beschreibung', amount: 'Betrag' }))
      .attach('file', path.join(FIXTURES, 'generic-semicolon.csv'));
    expect(res.status).toBe(200);
    expect(res.body.mappingSource).toBe('manual');
    expect(res.body.rows[0]).toMatchObject({ date: '2026-10-09', amount: -23.45 });
  });

  test('POST /import/preview rejects missing files, wrong extensions, foreign accounts and garbage', async () => {
    const none = await ctx.request.post('/api/bank-api/import/preview').set(auth);
    expect(none.status).toBe(400);
    const pdf = await ctx.request.post('/api/bank-api/import/preview').set(auth).attach('file', Buffer.from('%PDF-1.4'), 'statement.pdf');
    expect(pdf.status).toBe(400);
    expect(pdf.body.message).toMatch(/Unsupported file type/);
    const foreign = await ctx.request
      .post('/api/bank-api/import/preview')
      .set({ Authorization: `Bearer ${otherToken}` })
      .field('accountId', String(accountId))
      .attach('file', path.join(FIXTURES, 'rbc.csv'));
    expect(foreign.status).toBe(404);
    const garbage = await ctx.request.post('/api/bank-api/import/preview').set(auth).attach('file', Buffer.from('OFXHEADER:100\n<OFX></OFX>'), 'x.qfx');
    expect(garbage.status).toBe(400);
    expect(garbage.body.message).toMatch(/STMTRS/);
  });

  test('POST /import/commit writes rows once, updates the balance once, and a re-import skips duplicates', async () => {
    const preview = await ctx.request
      .post('/api/bank-api/import/preview')
      .set(auth)
      .field('accountId', String(accountId))
      .attach('file', path.join(FIXTURES, 'rbc.csv'));
    const rows = preview.body.rows.filter((r) => !r.error && !r.skipped && !r.duplicate);
    expect(rows).toHaveLength(5);

    const before = await dbGet(ctx, `SELECT balance FROM accounts WHERE id = ?`, [accountId]);
    const commit = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId, rows });
    expect(commit.status).toBe(200);
    expect(commit.body).toMatchObject({ success: true, inserted: 5, skipped: 0, rejected: 0, balanceDelta: 2224.03 });
    expect(commit.body.newBalance).toBe(Math.round((before.balance + 2224.03) * 100) / 100);

    const stored = await dbAll(ctx, `SELECT date, description, amount, type, category FROM transactions WHERE account_id = ? ORDER BY id`, [accountId]);
    expect(stored).toHaveLength(5);
    expect(stored[0]).toMatchObject({ date: '2026-10-01', amount: 2450, type: 'income', category: 'Salary' });
    expect(stored[4]).toMatchObject({ date: '2026-10-05', amount: -16.95, type: 'expense', category: 'Bank Fees' });

    // Preview again: everything is now "existing".
    const again = await ctx.request
      .post('/api/bank-api/import/preview')
      .set(auth)
      .field('accountId', String(accountId))
      .attach('file', path.join(FIXTURES, 'rbc.csv'));
    expect(again.body.rows.every((r) => r.duplicate === 'existing')).toBe(true);
    expect(again.body.stats.duplicates).toBe(5);

    // Commit again with the same rows: nothing inserted, balance untouched.
    const recommit = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId, rows });
    expect(recommit.status).toBe(200);
    expect(recommit.body).toMatchObject({ inserted: 0, skipped: 5, balanceDelta: 0 });
    const after = await dbGet(ctx, `SELECT balance FROM accounts WHERE id = ?`, [accountId]);
    expect(after.balance).toBe(commit.body.newBalance);
    const count = await dbGet(ctx, `SELECT COUNT(*) AS c FROM transactions WHERE account_id = ?`, [accountId]);
    expect(count.c).toBe(5);
  });

  test('POST /import/commit: updateBalance=false leaves the balance alone; skipDuplicates=false forces a re-insert', async () => {
    const acc = await seedAccount(ctx, ctx.userId, { number: 'acc-2', balance: 500 });
    const rows = [{ date: '2026-10-07', description: 'Coffee', amount: -4.5, category: 'Food & Dining' }];
    const first = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId: acc, rows, updateBalance: false });
    expect(first.body).toMatchObject({ inserted: 1, balanceDelta: 0 });
    const bal = await dbGet(ctx, `SELECT balance FROM accounts WHERE id = ?`, [acc]);
    expect(bal.balance).toBe(500);
    const forced = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId: acc, rows, skipDuplicates: false });
    expect(forced.body).toMatchObject({ inserted: 1, skipped: 0, balanceDelta: -4.5 });
    const bal2 = await dbGet(ctx, `SELECT balance FROM accounts WHERE id = ?`, [acc]);
    expect(bal2.balance).toBe(495.5);
  });

  test('POST /import/commit validates input and respects ownership', async () => {
    const noAcc = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ rows: [{ date: '2026-10-01', amount: 1 }] });
    expect(noAcc.status).toBe(400);
    const noRows = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId, rows: [] });
    expect(noRows.status).toBe(400);
    const badRows = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId, rows: [{ date: 'yesterday', amount: 1 }, { date: '2026-10-01', amount: 'x' }] });
    expect(badRows.status).toBe(400);
    expect(badRows.body.errors).toHaveLength(2);
    const foreign = await ctx.request
      .post('/api/bank-api/import/commit')
      .set({ Authorization: `Bearer ${otherToken}` })
      .send({ accountId, rows: [{ date: '2026-10-01', description: 'x', amount: 1 }] });
    expect(foreign.status).toBe(404);
    const unauth = await ctx.request.post('/api/bank-api/import/commit').send({ accountId, rows: [{ date: '2026-10-01', amount: 1 }] });
    expect(unauth.status).toBe(401);
    // mixed valid/invalid: valid rows go in, invalid are reported
    const acc = await seedAccount(ctx, ctx.userId, { number: 'acc-3', balance: 0 });
    const mixed = await ctx.request
      .post('/api/bank-api/import/commit')
      .set(auth)
      .send({ accountId: acc, rows: [{ date: '2026-10-01', description: 'ok', amount: 10 }, { date: 'bad', amount: 1 }] });
    expect(mixed.status).toBe(200);
    expect(mixed.body).toMatchObject({ inserted: 1, rejected: 1 });
  });

  test('POST /sync-accounts creates the accounts and stores their ids on the connection', async () => {
    const bankApiService = require(path.join(PROJECT_ROOT, 'services', 'bankApiService.js'));
    const original = bankApiService.getAccounts;
    bankApiService.getAccounts = jest.fn(async () => [
      { id: 'mono-a', name: 'Monobank 1234', accountNumber: 'mono-a', type: 'checking', balance: 1500.25, currency: 'UAH' }
    ]);
    try {
      const conn = await ctx.request.post('/api/bank-api/connect/monobank/direct').set(auth).send({ apiKey: 'tok', skipVerify: true });
      const res = await ctx.request.post(`/api/bank-api/sync-accounts/${conn.body.connectionId}`).set(auth).send({});
      expect(res.status).toBe(200);
      expect(res.body.accounts).toHaveLength(1);
      expect(res.body.accounts[0]).toMatchObject({ name: 'Monobank 1234', balance: 1500.25, currency: 'UAH' });
      const stored = await dbGet(ctx, `SELECT bank_id, account_ids, access_token FROM bank_connections WHERE id = ?`, [conn.body.connectionId]);
      expect(stored.bank_id).toBe('monobank');
      expect(JSON.parse(stored.account_ids)).toEqual([res.body.accounts[0].id]);
      expect(stored.access_token).toBeTruthy();
      const count = await dbGet(ctx, `SELECT COUNT(*) AS c FROM bank_connections WHERE user_id = ?`, [ctx.userId]);
      expect(count.c).toBe(1);
      // the commit route rejects an impossible calendar date even though it looks ISO
      const bad = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId, rows: [{ date: '2026-02-31', amount: 1 }] });
      expect(bad.status).toBe(400);
    } finally {
      bankApiService.getAccounts = original;
    }
  });

  test('POST /sync-transactions dedupes bank rows against what is already stored', async () => {
    const bankApiService = require(path.join(PROJECT_ROOT, 'services', 'bankApiService.js'));
    const original = bankApiService.getTransactions;
    bankApiService.getTransactions = jest.fn(async () => [
      { id: 'm1', date: '2026-10-08', description: 'Сільпо', category: 'Groceries', amount: -845.3, type: 'expense' },
      { id: 'm2', date: '2026-10-08', description: 'Bolt', category: 'Transport', amount: -120, type: 'expense' }
    ]);
    try {
      await ctx.request.post('/api/bank-api/connect/monobank/direct').set(auth).send({ apiKey: 'tok', skipVerify: true });
      const monoAcc = await seedAccount(ctx, ctx.userId, { number: 'mono-1', bank: 'Monobank', currency: 'UAH', balance: 0 });
      const first = await ctx.request.post(`/api/bank-api/sync-transactions/${monoAcc}`).set(auth).send({});
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ inserted: 2, skipped: 0, fetched: 2 });
      const second = await ctx.request.post(`/api/bank-api/sync-transactions/${monoAcc}`).set(auth).send({});
      expect(second.body).toMatchObject({ inserted: 0, skipped: 2 });
      const count = await dbGet(ctx, `SELECT COUNT(*) AS c FROM transactions WHERE account_id = ?`, [monoAcc]);
      expect(count.c).toBe(2);
    } finally {
      bankApiService.getTransactions = original;
    }
  });
});
