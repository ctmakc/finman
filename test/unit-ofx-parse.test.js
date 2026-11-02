// test/unit-ofx-parse.test.js — services/ofxImportService on small inline SGML
// statements: sign normalisation by TRNTYPE, TRNTYPE -> category, entity
// decoding, per-row errors, memo de-duplication, statement header fields.
'use strict';

const ofx = require('../services/ofxImportService');

function sgml(transactions, { curdef = 'cad' } = {}) {
  return `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>${curdef}
<BANKACCTFROM><BANKID>001<ACCTID>555<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101<DTEND>20260131
${transactions}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1,234.50<DTASOF>20260131120000.000[-5:EST]</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}
const trn = (type, date, amt, fitid, name, extra = '') =>
  `<STMTTRN><TRNTYPE>${type}${date ? `<DTPOSTED>${date}` : ''}<TRNAMT>${amt}<FITID>${fitid}<NAME>${name}${extra}</STMTTRN>`;

describe('OFX detection', () => {
  test('isOfx recognises SGML headers (with BOM), XML PI and rejects CSV', () => {
    expect(ofx.isOfx('﻿OFXHEADER:100\nDATA:OFXSGML')).toBe(true);
    expect(ofx.isOfx('<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX>')).toBe(true);
    expect(ofx.isOfx('Date,Description,Amount\n2026-01-01,x,1')).toBe(false);
    expect(ofx.isOfx(null)).toBe(false);
  });

  test('detectVersion: SGML -> 1, XML -> 2', () => {
    expect(ofx.detectVersion('OFXHEADER:100')).toBe('1');
    expect(ofx.detectVersion('<?xml version="1.0"?><?OFX OFXHEADER="200"?>')).toBe('2');
  });

  test('parseOfxDate takes the calendar date verbatim and rejects impossible dates', () => {
    expect(ofx.parseOfxDate('20260131235959.000[-5:EST]')).toBe('2026-01-31');
    expect(ofx.parseOfxDate('2026013')).toBeNull();
    expect(ofx.parseOfxDate('20250229')).toBeNull();
    expect(ofx.parseOfxDate('20261301')).toBeNull();
    expect(ofx.parseOfxDate(undefined)).toBeNull();
  });

  test('a document without <OFX> or without statements is rejected', () => {
    expect(() => ofx.parseOfx('OFXHEADER:100')).toThrow(/<OFX> element not found/);
    expect(() => ofx.parseOfx('OFXHEADER:100\n<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>')).toThrow(/No bank or credit-card statement/);
  });
});

describe('parseOfx statement', () => {
  const parsed = ofx.parseOfx(sgml([
    trn('DEBIT', '20260105', '25.00', 'a1', 'Tim Hortons &amp; Co', '<MEMO>Tim Hortons &amp; Co #12'),
    trn('CREDIT', '20260106', '-100', 'a2', 'REFUND &#x41;BC'),
    trn('FEE', '20260107', '-4.95', 'a3', 'Monthly'),
    trn('DEBIT', '20261340', '-1', 'a4', 'Bad date'),
    trn('DEBIT', '20260108', 'abc', 'a5', 'Bad amount'),
    trn('DEBIT', null, '-1', 'a6', 'No date'),
    trn('DEBIT', '20260109', '-3', 'a7', 'X &#x110000; y'),
    trn('CHECK', '20260110', '-50', 'a8', 'Cheque', '<CHECKNUM>101'),
  ].join('\n')));

  test('account header: ids, uppercased currency, balance with thousands separator, dates', () => {
    expect(parsed.version).toBe('1');
    expect(parsed.accounts).toEqual([{
      accountId: '555', bankId: '001', accountType: 'CHECKING', currency: 'CAD',
      balance: 1234.5, balanceDate: '2026-01-31', dateStart: '2026-01-01', dateEnd: '2026-01-31',
    }]);
  });

  test('DEBIT with positive amount becomes an expense, CREDIT with negative becomes income', () => {
    const [debit, credit] = parsed.rows;
    expect(debit).toMatchObject({ amount: -25, type: 'expense', externalId: 'a1', currency: 'CAD' });
    expect(credit).toMatchObject({ amount: 100, type: 'income' });
  });

  test('TRNTYPE category wins; otherwise the description categorizer is used', () => {
    expect(parsed.rows[2].category).toBe('Bank Fees');
    expect(parsed.rows[0].category).toBe('Food & Dining');
    expect(parsed.rows[1].category).toBe('Refund');
  });

  test('entities are decoded; out-of-range code points are left as text instead of throwing', () => {
    expect(parsed.rows[1].description).toBe('REFUND ABC');
    expect(parsed.rows[6].description).toBe('X &#x110000; y');
  });

  test('a memo that extends the name replaces it rather than being appended', () => {
    expect(parsed.rows[0].description).toBe('Tim Hortons & Co #12');
  });

  test('cheque number is appended to the description', () => {
    expect(parsed.rows[7].description).toBe('Cheque · cheque 101');
  });

  test('bad rows carry an error and keep their position; good rows get a fingerprint', () => {
    expect(parsed.rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parsed.rows[3].error).toBe('Unrecognised date "20261340"');
    expect(parsed.rows[4].error).toBe('Unrecognised amount "abc"');
    expect(parsed.rows[5].error).toBe('Missing DTPOSTED');
    expect(parsed.rows[3].date).toBeUndefined();
    expect(parsed.rows[0].fingerprint).toMatch(/^[0-9a-f]+$/);
  });
});

describe('previewOfx duplicate detection', () => {
  const text = sgml([
    trn('DEBIT', '20260105', '-5', 'f1', 'Coffee'),
    trn('DEBIT', '20260105', '-5', 'f2', 'Coffee'),
  ].join('\n'));

  test('two identical purchases with distinct FITIDs are both kept on first import', () => {
    const p = ofx.previewOfx(text);
    expect(p.kind).toBe('ofx');
    expect(p.preset.id).toBe('ofx1');
    expect(p.rows.filter((r) => r.duplicate)).toHaveLength(0);
  });

  test('a known FITID marks the row as an existing duplicate even when text matches nothing', () => {
    const p = ofx.previewOfx(text, { existingExternalIds: new Set(['f2']) });
    expect(p.rows.map((r) => r.duplicate || null)).toEqual([null, 'existing']);
  });
});
