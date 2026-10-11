// test/bank-import-fixes.test.js — regressions from the bank import & sync review.
//
// Each describe block pins one finding so a revert shows up by name.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'bank-import');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const csv = require(path.join(PROJECT_ROOT, 'services', 'csvImportService.js'));

const ms = (fn) => {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

describe('ReDoS: number detection on hostile cells', () => {
  test('a 100k-char "1   …   !" cell is classified in under 50 ms', () => {
    const cell = '1' + ' '.repeat(100000) + '!';
    // detectHeader runs looksLikeNumber/looksLikeDate on every cell of the first two rows.
    expect(ms(() => csv.detectHeader([[cell, 'x'], ['2026-10-01', '1.00']]))).toBeLessThan(50);
    expect(ms(() => csv.detectHeader([['Date', 'Amount'], ['2026-10-01', cell]]))).toBeLessThan(50);
  });

  test('a whole preview with such a cell stays linear', () => {
    const cell = '1' + ' '.repeat(100000) + '!';
    const text = `Date,Description,Amount\n2026-10-01,"${cell}",-1.00\n`;
    expect(ms(() => csv.previewCsv(text))).toBeLessThan(1000);
  });

  test('ordinary amounts still count as numbers', () => {
    const p = csv.previewCsv('Date;Description;Amount\n2026-10-01;Coffee;1 234,56 UAH\n2026-10-02;Tea;-$45.00\n');
    expect(p.mapping.amount).toBe(2);
    expect(p.rows.map((r) => r.amount)).toEqual([1234.56, -45]);
  });
});

describe('"Re-read with this mapping" keeps the preset roles the wizard does not show', () => {
  // What the wizard sends: the visible roles only (plus nulls for "—").
  const visible = (m) => ({ date: m.date, description: m.description, amount: m.amount, debit: null, credit: null, category: null, currency: m.currency ?? null });

  test('Revolut: non-completed rows stay skipped and the fee is still subtracted', () => {
    const text = read('revolut.csv');
    const auto = csv.previewCsv(text);
    const again = csv.previewCsv(text, { presetId: 'revolut', mapping: visible(auto.mapping), dateOrder: 'YMD', hasHeader: true, delimiter: ',' });
    expect(again.mappingSource).toBe('manual');
    expect(again.rows.map((r) => [r.amount ?? null, r.skipped])).toEqual(auto.rows.map((r) => [r.amount ?? null, r.skipped]));
    expect(again.rows.filter((r) => r.skipped)).toHaveLength(2);
  });

  test('BMO: the DEBIT/CREDIT type column still fixes the sign of unsigned amounts', () => {
    const text = `First Bank Card,Transaction Type,Date Posted, Transaction Amount,Description\n'5191',DEBIT,20261001,84.17,LOBLAWS\n'5191',CREDIT,20261005,2450.00,PAYROLL\n`;
    const auto = csv.previewCsv(text);
    const again = csv.previewCsv(text, { presetId: 'bmo', mapping: visible(auto.mapping), hasHeader: true });
    expect(again.rows.map((r) => r.amount)).toEqual([-84.17, 2450]);
  });

  test('Monobank: currency from the amount header and MCC categories survive', () => {
    const text = read('monobank.csv');
    const auto = csv.previewCsv(text);
    const again = csv.previewCsv(text, { presetId: 'monobank', mapping: visible(auto.mapping), dateOrder: 'DMY', hasHeader: true });
    expect(again.rows.map((r) => [r.currency, r.category])).toEqual(auto.rows.map((r) => [r.currency, r.category]));
    expect(again.rows[0].currency).toBe('UAH');
  });

  test('an explicit null clears a preset role (user picked "—")', () => {
    const text = read('revolut.csv');
    const auto = csv.previewCsv(text);
    const again = csv.previewCsv(text, { presetId: 'revolut', mapping: { ...visible(auto.mapping), currency: null } });
    expect(again.rows.find((r) => !r.skipped).currency).toBeNull();
  });
});

describe('Monobank API: balance, dates, range, currency', () => {
  let svc;
  let calls;
  const ops = [
    // 00:30 Kyiv on 2026-10-10 (UTC+3) = 2026-10-09T21:30Z
    { id: 't1', time: Math.floor(Date.parse('2026-10-09T21:30:00Z') / 1000), description: 'Сільпо', mcc: 5411, amount: -12345, balance: 100 }
  ];
  beforeAll(() => {
    calls = [];
    jest.isolateModules(() => {
      jest.doMock('axios', () => ({
        get: async (url) => {
          calls.push(url);
          if (url.includes('client-info')) {
            return {
              data: {
                name: 'X',
                accounts: [
                  { id: 'acc1', currencyCode: 980, balance: 5100000, creditLimit: 5000000, type: 'black', maskedPan: ['5375****1234'] },
                  { id: 'acc2', currencyCode: 999, balance: 100, creditLimit: 0, type: 'black' }
                ]
              }
            };
          }
          return { data: ops };
        }
      }));
      svc = require(path.join(PROJECT_ROOT, 'services', 'bankApiService.js'));
    });
  });
  afterAll(() => jest.dontMock('axios'));

  test('balance is own money: balance - creditLimit; unknown currency code is skipped, not UAH', async () => {
    const accounts = await svc.getAccounts('monobank', { access_token: 'tok' });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: 'acc1', balance: 1000, creditLimit: 50000, currency: 'UAH' });
    expect(svc.currencyFromNumeric(999)).toBeNull();
    expect(svc.currencyFromNumeric(933)).toBe('BYN');
  });

  test('operation dates are Kyiv calendar dates', async () => {
    const tx = await svc.getTransactions('monobank', { access_token: 'tok' }, 'acc1', { startDate: '2026-10-01', endDate: '2026-10-10' });
    expect(tx[0].date).toBe('2026-10-10');
    expect(svc.kyivDate(Date.parse('2026-10-09T20:59:59Z') / 1000)).toBe('2026-10-09');
  });

  test('the end date includes its own (Kyiv) day; bad dates throw instead of sending NaN', async () => {
    calls.length = 0;
    await svc.getTransactions('monobank', { access_token: 'tok' }, 'acc1', { startDate: '2026-10-01', endDate: '2026-10-10' });
    const [from, to] = calls[0].split('/').slice(-2).map(Number);
    expect(new Date(from * 1000).toISOString()).toBe('2026-09-30T21:00:00.000Z'); // 00:00 Kyiv, Oct 1
    expect(new Date(to * 1000).toISOString()).toBe('2026-10-10T20:59:59.000Z'); // 23:59:59 Kyiv, Oct 10
    expect(calls[0]).not.toMatch(/NaN/);
    await expect(svc.getTransactions('monobank', { access_token: 'tok' }, 'acc1', { startDate: 'garbage' })).rejects.toThrow(/Invalid start date/);
    await expect(svc.getTransactions('monobank', { access_token: 'tok' }, 'acc1', { startDate: '2026-02-30' })).rejects.toThrow(/Invalid start date/);
    // across the DST switch (2026-03-29 03:00 Kyiv)
    expect(new Date(svc.rangeBound('2026-03-29', 'end') * 1000).toISOString()).toBe('2026-03-29T20:59:59.000Z');
  });
});

describe('count-based dedupe keeps legit identical transactions', () => {
  const ofx = require(path.join(PROJECT_ROOT, 'services', 'ofxImportService.js'));
  const sgml = (trns) => `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD\n<BANKACCTFROM><BANKID>001<ACCTID>111<ACCTTYPE>CHECKING</BANKACCTFROM>\n<BANKTRANLIST><DTSTART>20240101<DTEND>20240131\n${trns}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const tr = (id, dt, amt, name) => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${dt}<TRNAMT>${amt}<FITID>${id}<NAME>${name}</STMTTRN>`;
  const twoCoffees = sgml(tr('A1', '20240131120000.000[-5:EST]', '-4.85', 'TIM HORTONS') + tr('A2', '20240131', '-4.85', 'TIM HORTONS'));

  test('OFX: same day/amount/name with distinct FITIDs are two transactions', () => {
    const p = ofx.previewOfx(twoCoffees);
    expect(p.rows.map((r) => r.duplicate)).toEqual([null, null]);
    expect(p.stats.valid).toBe(2);
  });

  test('one stored copy matches one incoming row, not all of them', () => {
    const p = ofx.previewOfx(twoCoffees);
    const fp = p.rows[0].fingerprint;
    const one = ofx.previewOfx(twoCoffees, { existingFingerprints: csv.fingerprintCounts([fp]) });
    expect(one.rows.map((r) => r.duplicate)).toEqual(['existing', null]);
    const two = ofx.previewOfx(twoCoffees, { existingFingerprints: csv.fingerprintCounts([fp, fp]) });
    expect(two.rows.map((r) => r.duplicate)).toEqual(['existing', 'existing']);
  });

  test('CSV without ids still flags an identical in-file row', () => {
    const rows = [{ fingerprint: 'x' }, { fingerprint: 'x' }, { fingerprint: 'x', externalId: 'b' }];
    expect(csv.markDuplicates(rows, csv.fingerprintCounts(['x'])).map((r) => r.duplicate)).toEqual(['existing', 'file', null]);
  });
});

describe('CSV parsing: minus signs, stray quotes, indicator columns, dot thousands', () => {
  test('Unicode minus / en dash / em dash / full-width minus make the amount negative', () => {
    expect(csv.parseAmount('\u221245.00')).toBe(-45);
    expect(csv.parseAmount('\u201345.00')).toBe(-45);
    expect(csv.parseAmount('\u20141 234,56')).toBe(-1234.56);
    expect(csv.parseAmount('\uff0d12,50')).toBe(-12.5);
    expect(csv.parseAmount('45.00\u2212')).toBe(-45);
    expect(csv.parseAmount('\u2014')).toBeNull();
    const p = csv.previewCsv('Date,Description,Amount\n2026-10-01,Coffee,\u22124.50\n2026-10-02,Salary,2000.00\n');
    expect(p.rows.map((r) => [r.amount, r.type])).toEqual([[-4.5, 'expense'], [2000, 'income']]);
  });

  test('a stray quote inside an unquoted cell is literal and does not swallow the file', () => {
    const t = 'Date,Description,Amount\n2026-10-01,12" PIZZA,-10.00\n2026-10-02,Coffee,-3.00\n2026-10-03,Rent,-1000.00\n2026-10-04,Salary,2000.00\n';
    expect(csv.detectDelimiter(t)).toBe(',');
    const p = csv.previewCsv(t);
    expect(p.stats.valid).toBe(4);
    expect(p.rows[0]).toMatchObject({ description: '12" PIZZA', amount: -10 });
    // quoted cells (with leading blanks, doubled quotes, delimiters inside) still work
    expect(csv.parseCsv('a, "b,c" ,d\nx,"he said ""hi""",y\n', ',')).toEqual([
      ['a', 'b,c', 'd'],
      ['x', 'he said "hi"', 'y']
    ]);
  });

  test('a "Debit/Credit" word column is the sign indicator, not a debit amount', () => {
    const p = csv.previewCsv('Date,Description,Amount,Debit/Credit\n2026-10-01,Groceries,84.17,Debit\n2026-10-02,Salary,2000.00,Credit\n');
    expect(p.mapping.amount).toBe(2);
    expect(p.mapping.debit == null).toBe(true);
    expect(p.mapping.typeColumn).toBe(3);
    expect(p.rows.map((r) => r.amount)).toEqual([-84.17, 2000]);
    // a numeric Debit column is still a money-out column
    expect(csv.previewCsv(read('generic-debit-credit.csv')).mapping.debit).toBe(2);
  });

  test('"2.500" is thousands only when the column writes decimals with a comma', () => {
    expect(csv.parseAmount('2.500')).toBe(2.5);
    expect(csv.parseAmount('2.500', { decimalComma: true })).toBe(2500);
    expect(csv.inferDecimalComma(['-23,45', '1.234,56', '2.500'])).toBe(true);
    expect(csv.inferDecimalComma(['-23.45', '2.500'])).toBe(false);
    const de = csv.previewCsv('Datum;Text;Betrag\n09.10.2026;A;-23,45\n10.10.2026;B;2.500\n');
    expect(de.rows.map((r) => r.amount)).toEqual([-23.45, 2500]);
    const en = csv.previewCsv('Date,Text,Amount\n2026-10-09,A,-23.45\n2026-10-10,B,2.500\n');
    expect(en.rows.map((r) => r.amount)).toEqual([-23.45, 2.5]);
  });
});

// ---------------------------------------------------------------------------
// HTTP + scheduler
// ---------------------------------------------------------------------------
const { makeApp } = require('./helpers/app');

function dbRun(ctx, sql, params) {
  return new Promise((resolve, reject) =>
    ctx.db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this.lastID);
    })
  );
}
function dbGet(ctx, sql, params) {
  return new Promise((resolve, reject) => ctx.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}
function seedAccount(ctx, overrides = {}) {
  const a = { name: 'Card', number: `n-${Math.random().toString(36).slice(2)}`, bank: 'Monobank', currency: 'UAH', balance: 0, ...overrides };
  return dbRun(
    ctx,
    `INSERT INTO accounts (user_id, name, account_number, bank_name, currency, balance, account_type) VALUES (?, ?, ?, ?, ?, ?, 'checking')`,
    [ctx.userId, a.name, a.number, a.bank, a.currency, a.balance]
  );
}
const countTx = async (ctx, accountId) => (await dbGet(ctx, `SELECT COUNT(*) AS c FROM transactions WHERE account_id = ?`, [accountId])).c;

describe('HTTP: bank sync and commit with identical transactions', () => {
  let ctx;
  let auth;
  let bankApiService;
  let original;
  const twoCoffees = [
    { id: 'op1', date: '2026-10-08', description: 'Aroma Kava', category: 'Food & Dining', amount: -65, type: 'expense' },
    { id: 'op2', date: '2026-10-08', description: 'Aroma Kava', category: 'Food & Dining', amount: -65, type: 'expense' }
  ];

  beforeAll(async () => {
    ctx = await makeApp();
    auth = { Authorization: `Bearer ${ctx.token}` };
    bankApiService = require(path.join(PROJECT_ROOT, 'services', 'bankApiService.js'));
    original = bankApiService.getTransactions;
    bankApiService.getTransactions = jest.fn(async () => twoCoffees.slice());
    await ctx.request.post('/api/bank-api/connect/monobank/direct').set(auth).send({ apiKey: 'tok', skipVerify: true });
  });
  afterAll(async () => {
    if (bankApiService) bankApiService.getTransactions = original;
    if (ctx) await ctx.close();
  });

  test('/sync-transactions inserts both identical operations once, and a re-sync skips both', async () => {
    const acc = await seedAccount(ctx);
    const first = await ctx.request.post(`/api/bank-api/sync-transactions/${acc}`).set(auth).send({});
    expect(first.body).toMatchObject({ inserted: 2, skipped: 0 });
    const second = await ctx.request.post(`/api/bank-api/sync-transactions/${acc}`).set(auth).send({});
    expect(second.body).toMatchObject({ inserted: 0, skipped: 2 });
    expect(await countTx(ctx, acc)).toBe(2);
    // the same op id twice in one response is one row
    bankApiService.getTransactions.mockImplementationOnce(async () => [...twoCoffees, { ...twoCoffees[0] }, { ...twoCoffees[0], id: 'op3' }]);
    const third = await ctx.request.post(`/api/bank-api/sync-transactions/${acc}`).set(auth).send({});
    expect(third.body).toMatchObject({ inserted: 1, skipped: 3 });
  });

  test('/sync-transactions rejects an invalid date range with 400', async () => {
    const acc = await seedAccount(ctx);
    const bad = await ctx.request.post(`/api/bank-api/sync-transactions/${acc}`).set(auth).send({ startDate: 'garbage' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Invalid start date/);
    const bad2 = await ctx.request.post(`/api/bank-api/sync-transactions/${acc}`).set(auth).send({ endDate: '2026-02-30' });
    expect(bad2.status).toBe(400);
  });

  test('/import/commit inserts two identical rows; a re-commit skips both', async () => {
    const acc = await seedAccount(ctx, { bank: 'RBC Royal Bank', currency: 'CAD' });
    const rows = [
      { date: '2026-10-07', description: 'Coffee', amount: -4.5, category: 'Food & Dining' },
      { date: '2026-10-07', description: 'Coffee', amount: -4.5, category: 'Food & Dining' }
    ];
    const first = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId: acc, rows });
    expect(first.body).toMatchObject({ inserted: 2, skipped: 0, balanceDelta: -9 });
    const again = await ctx.request.post('/api/bank-api/import/commit').set(auth).send({ accountId: acc, rows });
    expect(again.body).toMatchObject({ inserted: 0, skipped: 2 });
    expect(await countTx(ctx, acc)).toBe(2);
  });

  test('/import/preview refuses a multi-statement OFX with 400 and the statement list', async () => {
    const t = (id, acct, cur) => `<STMTTRNRS><STMTRS><CURDEF>${cur}<BANKACCTFROM><ACCTID>${acct}</BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240110<TRNAMT>-1.00<FITID>${id}<NAME>A</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS>`;
    const body = `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1>${t('a', '111', 'CAD')}${t('b', '222', 'USD')}</BANKMSGSRSV1></OFX>`;
    const res = await ctx.request.post('/api/bank-api/import/preview').set(auth).attach('file', Buffer.from(body), 'two.ofx');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OFX_MULTIPLE_STATEMENTS');
    expect(res.body.statements).toHaveLength(2);
    const one = await ctx.request.post('/api/bank-api/import/preview').set(auth).field('ofxAccountId', '222').attach('file', Buffer.from(body), 'two.ofx');
    expect(one.status).toBe(200);
    expect(one.body.rows.map((r) => r.currency)).toEqual(['USD']);
  });

  test('/import/commit applies the type sign rule: expense < 0, income > 0', async () => {
    const acc = await seedAccount(ctx, { bank: 'RBC Royal Bank', currency: 'CAD', balance: 100 });
    const res = await ctx.request
      .post('/api/bank-api/import/commit')
      .set(auth)
      .send({
        accountId: acc,
        rows: [
          { date: '2026-10-01', description: 'Refund?', amount: -50, type: 'income' },
          { date: '2026-10-02', description: 'Shop', amount: 20, type: 'expense' },
          { date: '2026-10-03', description: 'No type', amount: -5 }
        ]
      });
    expect(res.body).toMatchObject({ inserted: 3, balanceDelta: 25 });
    const stored = await new Promise((resolve, reject) =>
      ctx.db.all(`SELECT amount, type FROM transactions WHERE account_id = ? ORDER BY date`, [acc], (e, r) => (e ? reject(e) : resolve(r)))
    );
    expect(stored).toEqual([
      { amount: 50, type: 'income' },
      { amount: -20, type: 'expense' },
      { amount: -5, type: 'expense' }
    ]);
    expect((await dbGet(ctx, `SELECT balance FROM accounts WHERE id = ?`, [acc])).balance).toBe(125);
  });

  test('legacy /api/transactions/import accepts a multipart CSV (what the Transactions page now sends)', async () => {
    const acc = await seedAccount(ctx, { bank: 'RBC Royal Bank', currency: 'CAD' });
    const res = await ctx.request
      .post('/api/transactions/import')
      .set(auth)
      .field('accountId', String(acc))
      .field('bankType', 'generic')
      .attach('file', Buffer.from('Date,Description,Amount\n2026-10-01,Coffee,\u22124.50\n2026-10-02,Salary,2000.00\n'), 'statement.csv');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(await countTx(ctx, acc)).toBe(2);
  });

  test('syncScheduler.runOnce inserts both identical operations and is idempotent', async () => {
    const scheduler = require(path.join(PROJECT_ROOT, 'services', 'syncScheduler.js'));
    const { userId } = ctx;
    // Earlier tests left other Monobank accounts; only the fresh one is new.
    const acc = await seedAccount(ctx);
    const first = await scheduler.runOnce(userId);
    expect(first.errors).toEqual([]);
    expect(await countTx(ctx, acc)).toBe(2);
    const second = await scheduler.runOnce(userId);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(second.fetched);
    expect(await countTx(ctx, acc)).toBe(2);
  });

  test('syncScheduler never sends accounts of another bank to the Monobank endpoint', async () => {
    const scheduler = require(path.join(PROJECT_ROOT, 'services', 'syncScheduler.js'));
    // A user with a Monobank connection and only an RBC account.
    const userId = await dbRun(ctx, `INSERT INTO users (username, email, password, full_name) VALUES ('rbc', 'rbc@example.com', 'x', 'R')`, []);
    await dbRun(ctx, `INSERT INTO bank_connections (user_id, bank_id, access_token, is_active) VALUES (?, 'monobank', 'tok', 1)`, [userId]);
    await dbRun(
      ctx,
      `INSERT INTO accounts (user_id, name, account_number, bank_name, currency, balance, account_type) VALUES (?, 'Chequing', '00123-4567', 'RBC Royal Bank', 'CAD', 0, 'checking')`,
      [userId]
    );
    bankApiService.getTransactions.mockClear();
    const summary = await scheduler.runOnce(userId);
    expect(bankApiService.getTransactions).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ accounts: 0, inserted: 0 });
  });
});

describe('OFX: multi-statement files, calendar dates, per-transaction currency, entities', () => {
  const ofx = require(path.join(PROJECT_ROOT, 'services', 'ofxImportService.js'));
  const tr = (id, dt, amt, name, more = '') => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${dt}<TRNAMT>${amt}<FITID>${id}<NAME>${name}${more}</STMTTRN>`;
  const stmt = (acct, cur, trns) => `<STMTTRNRS><STMTRS><CURDEF>${cur}<BANKACCTFROM><BANKID>001<ACCTID>${acct}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>${trns}</BANKTRANLIST></STMTRS></STMTTRNRS>`;
  const file = (body) => `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1>${body}</BANKMSGSRSV1></OFX>`;
  const two = file(stmt('111', 'CAD', tr('G1', '20240110', '-1.00', 'A')) + stmt('222', 'USD', tr('G2', '20240110', '-9.00', 'B')));

  test('a file with two statements is refused with the account list', () => {
    let err;
    try {
      ofx.previewOfx(two);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('OFX_MULTIPLE_STATEMENTS');
    expect(err.message).toMatch(/2 statements.*111.*222/);
    expect(err.statements.map((s) => s.accountId)).toEqual(['111', '222']);
  });

  test('naming the statement imports only its rows', () => {
    const p = ofx.previewOfx(two, { statementAccountId: '222' });
    expect(p.accounts).toHaveLength(1);
    expect(p.rows.map((r) => [r.externalId, r.amount, r.currency])).toEqual([['G2', -9, 'USD']]);
    expect(() => ofx.previewOfx(two, { statementAccountId: '999' })).toThrow(/not in this file/);
  });

  test('DTPOSTED 20240231 is an error row, not a preview date', () => {
    expect(ofx.parseOfxDate('20240231')).toBeNull();
    expect(ofx.parseOfxDate('20240229')).toBe('2024-02-29');
    const p = ofx.previewOfx(file(stmt('1', 'CAD', tr('B1', '20240231', '-1.00', 'X'))));
    expect(p.rows[0].error).toMatch(/Unrecognised date/);
    expect(p.stats.valid).toBe(0);
  });

  test('<CURRENCY><CURSYM> on a transaction sets its currency; ORIGCURRENCY does not', () => {
    const p = ofx.previewOfx(
      file(
        stmt(
          '1',
          'CAD',
          tr('C1', '20240110', '-10.00', 'AMAZON US', '<CURRENCY><CURRATE>1.35<CURSYM>USD</CURRENCY>') +
            tr('C2', '20240111', '-13.50', 'AMAZON US', '<ORIGCURRENCY><CURRATE>1.35<CURSYM>USD</ORIGCURRENCY>')
        )
      )
    );
    expect(p.rows.map((r) => r.currency)).toEqual(['USD', 'CAD']);
  });

  test('an out-of-range numeric entity is kept as text instead of throwing', () => {
    const p = ofx.previewOfx(file(stmt('1', 'CAD', tr('F1', '20240110', '-1.00', 'A &#x110000; B &#65;'))));
    expect(p.rows[0].description).toBe('A &#x110000; B A');
  });
});

describe('categorizer: whole-word keyword matching', () => {
  const { categorizeByDescription: cat } = require(path.join(PROJECT_ROOT, 'services', 'importCategorizer.js'));

  test('substrings inside other words no longer hit', () => {
    expect(cat('TAXI KYIV')).toBe('Transport'); // not "tax"
    expect(cat('Espresso House')).not.toBe('Fuel'); // not "esso"
    expect(cat('Магазин Ева')).not.toBe('Utilities'); // not "газ"
    expect(cat('Parent Teacher Assoc')).not.toBe('Housing'); // not "rent"
    expect(cat('reporter mag')).not.toBe('Travel'); // not "porter"
  });

  test('real merchants, plurals, possessives and Cyrillic stems still match', () => {
    expect(cat('ESSO 1234 OTTAWA')).toBe('Fuel');
    expect(cat("WENDY'S 123")).toBe('Food & Dining');
    expect(cat('Restaurants Inc')).toBe('Food & Dining');
    expect(cat('Canada Revenue Agency')).toBe('Taxes & Government');
    expect(cat('PROPERTY TAX')).toBe('Taxes & Government');
    expect(cat('Зарплата за вересень')).toBe('Salary');
    expect(cat('Газопостачання')).toBe('Utilities');
    expect(cat('A&W #55')).toBe('Food & Dining');
    expect(cat('APPLE.COM/BILL')).toBe('Subscriptions');
  });
});
