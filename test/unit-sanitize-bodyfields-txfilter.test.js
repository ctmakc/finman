// test/unit-sanitize-bodyfields-txfilter.test.js — pure helpers in lib/:
// sanitize (no tests before), bodyFields edge cases, txFilter SQL fragment,
// money edge cases. No DB, no app.
'use strict';

const { escapeHtml, stripUnsafe, sanitizeFilename, toStr } = require('../lib/sanitize');
const { snakeToCamel, normalizeBody, missingFields, missingFieldsMessage } = require('../lib/bodyFields');
const txFilter = require('../lib/txFilter');
const money = require('../lib/money');

describe('lib/sanitize', () => {
  test('toStr: null/undefined -> empty string, others -> String()', () => {
    expect(toStr(null)).toBe('');
    expect(toStr(undefined)).toBe('');
    expect(toStr(0)).toBe('0');
    expect(toStr(false)).toBe('false');
    expect(toStr('x')).toBe('x');
  });

  test('escapeHtml neutralises every HTML-significant character', () => {
    const out = escapeHtml(`<img src=x onerror="alert('1')">`);
    expect(out).not.toMatch(/[<>"'=]/);
    expect(out).toBe('&lt;img src&#x3D;x onerror&#x3D;&quot;alert(&#39;1&#39;)&quot;&gt;');
    expect(escapeHtml('a & b / `c`')).toBe('a &amp; b &#x2F; &#x60;c&#x60;');
  });

  test('escapeHtml is total on non-strings and does not drop falsy numbers', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(false)).toBe('false');
  });

  test('escapeHtml is not idempotent by design (double escaping is visible)', () => {
    expect(escapeHtml(escapeHtml('&'))).toBe('&amp;amp;');
  });

  test('stripUnsafe flattens newlines/tabs to spaces and removes C0/C1/DEL controls', () => {
    expect(stripUnsafe('  line1\r\nline2\tend  ')).toBe('line1 line2 end');
    expect(stripUnsafe('a\u0000b\u0007c\u007fd\u0085e\u009ff')).toBe('abcdef');
    // Unicode letters survive
    expect(stripUnsafe('Привіт, світ')).toBe('Привіт, світ');
  });

  test('stripUnsafe maxLength truncates after trimming; bad maxLength is ignored', () => {
    expect(stripUnsafe('   abcdef   ', { maxLength: 3 })).toBe('abc');
    expect(stripUnsafe('abc', { maxLength: 0 })).toBe('');
    expect(stripUnsafe('abcdef', { maxLength: 2.5 })).toBe('abcdef');
    expect(stripUnsafe('abcdef', { maxLength: -1 })).toBe('abcdef');
    expect(stripUnsafe('abcdef', { maxLength: '3' })).toBe('abcdef');
  });

  test('sanitizeFilename defeats path traversal and absolute paths', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('/var/log/syslog')).toBe('syslog');
    expect(sanitizeFilename('C:\\Users\\me\\..\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('..')).toBe('');
    expect(sanitizeFilename('dir/')).toBe('');
  });

  test('sanitizeFilename strips leading dots, collapses dot runs, replaces unsafe chars', () => {
    expect(sanitizeFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeFilename('...hidden')).toBe('hidden');
    expect(sanitizeFilename('a..b..pdf')).toBe('a.b.pdf');
    expect(sanitizeFilename('rep:ort?*.csv')).toBe('rep_ort_.csv');
    expect(sanitizeFilename('my file-1_v2.txt')).toBe('my file-1_v2.txt');
    expect(sanitizeFilename('bad\u0000name.txt')).toBe('badname.txt');
    expect(sanitizeFilename(null)).toBe('');
  });
});

describe('lib/bodyFields', () => {
  test('snakeToCamel converts letters and digits after underscores', () => {
    expect(snakeToCamel('target_amount')).toBe('targetAmount');
    expect(snakeToCamel('due_date')).toBe('dueDate');
    expect(snakeToCamel('line_2')).toBe('line2');
    expect(snakeToCamel('plain')).toBe('plain');
  });

  test('normalizeBody: snake wins over camel, camel wins over aliases', () => {
    const map = { target_amount: ['goal'] };
    expect(normalizeBody({ target_amount: 1, targetAmount: 2, goal: 3 }, map)).toEqual({ target_amount: 1 });
    expect(normalizeBody({ targetAmount: 2, goal: 3 }, map)).toEqual({ target_amount: 2 });
    expect(normalizeBody({ goal: 3 }, map)).toEqual({ target_amount: 3 });
  });

  test('normalizeBody: empty/null snake value falls through to the next candidate, 0 and false are kept', () => {
    const map = { amount: [], is_active: [] };
    expect(normalizeBody({ amount: '', isActive: false }, map)).toEqual({ is_active: false });
    expect(normalizeBody({ amount: null }, { amount: ['sum'] })).toEqual({});
    expect(normalizeBody({ amount: '', sum: 5 }, { amount: ['sum'] })).toEqual({ amount: 5 });
    expect(normalizeBody({ amount: 0 }, map)).toEqual({ amount: 0 });
  });

  test('normalizeBody ignores unknown keys and tolerates non-object bodies', () => {
    expect(normalizeBody({ evil: 1, name: 'x' }, { name: [] })).toEqual({ name: 'x' });
    expect(normalizeBody(null, { name: [] })).toEqual({});
    expect(normalizeBody('str', { name: [] })).toEqual({});
  });

  test('missingFields keeps order and treats 0/false as present', () => {
    expect(missingFields({ a: 0, b: false, c: '', d: null }, ['a', 'b', 'c', 'd', 'e'])).toEqual(['c', 'd', 'e']);
    expect(missingFieldsMessage(['name', 'amount'])).toBe('Missing required fields: name, amount');
  });
});

describe('lib/txFilter', () => {
  test('cashflowOnly builds an aliased WHERE fragment with one placeholder per legacy category', () => {
    const { sql, params } = txFilter.cashflowOnly('t');
    expect(sql.startsWith(' AND ')).toBe(true);
    expect(sql).toContain("t.type IN ('income', 'expense')");
    expect(sql).toContain("COALESCE(t.category, '')");
    expect((sql.match(/\?/g) || []).length).toBe(params.length);
    expect(params).toEqual(txFilter.OPENING_CATEGORIES);
    // returned params are a copy: mutating them must not touch the constant
    params.push('x');
    expect(txFilter.OPENING_CATEGORIES).not.toContain('x');
  });

  test('cashflowOnly without alias uses bare column names', () => {
    const { sql } = txFilter.cashflowOnly();
    expect(sql).toContain("AND type IN ('income', 'expense')");
    expect(sql).not.toMatch(/\.\s*type/);
  });

  test('isCashflow excludes transfers, openings and legacy opening categories (incl. padded)', () => {
    expect(txFilter.isCashflow({ type: 'expense', category: 'Food' })).toBe(true);
    expect(txFilter.isCashflow({ type: 'income', category: null })).toBe(true);
    expect(txFilter.isCashflow({ type: 'transfer', category: 'Food' })).toBe(false);
    expect(txFilter.isCashflow({ type: 'opening' })).toBe(false);
    expect(txFilter.isCashflow({ type: 'income', category: '  Початковий баланс ' })).toBe(false);
    expect(txFilter.isCashflow(null)).toBe(false);
    expect(txFilter.isOpening(undefined)).toBe(false);
  });
});

describe('lib/money edge cases', () => {
  test('round is float-safe and coerces garbage to 0', () => {
    expect(money.round(1.005)).toBe(1.01);
    expect(money.round('2.675')).toBe(2.68);
    expect(money.round(NaN)).toBe(0);
    expect(money.round(Infinity)).toBe(0);
    expect(money.round('abc')).toBe(0);
    expect(money.round(null)).toBe(0);
  });

  test('add/sub/mul/div/sum treat missing operands as 0', () => {
    expect(money.add(0.1, 0.2)).toBe(0.3);
    expect(money.add()).toBe(0);
    expect(money.add('1.10', null, undefined, '2.20')).toBe(3.3);
    expect(money.sub(undefined, 5)).toBe(-5);
    expect(money.mul(19.99, 3)).toBe(59.97);
    expect(money.div(10, 0)).toBe(0);
    expect(money.div(10, '')).toBe(0);
    expect(money.div(10, 3)).toBe(3.33);
    expect(money.sum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(money.sum('not an array')).toBe(0);
  });
});
