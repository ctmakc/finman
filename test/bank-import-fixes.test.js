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
});
