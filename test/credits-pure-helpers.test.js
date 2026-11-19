// test/credits-pure-helpers.test.js — поведение чистых хелперов, которые раньше
// не имели прямых тестов: lib/sanitize, lib/money, lib/txFilter, lib/bodyFields,
// lib/respond. Без БД и сети.
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const sanitize = require(path.join(ROOT, 'lib', 'sanitize'));
const money = require(path.join(ROOT, 'lib', 'money'));
const txFilter = require(path.join(ROOT, 'lib', 'txFilter'));
const bodyFields = require(path.join(ROOT, 'lib', 'bodyFields'));
const respond = require(path.join(ROOT, 'lib', 'respond'));

describe('lib/sanitize.escapeHtml', () => {
  test('escapes every HTML-sensitive character', () => {
    expect(sanitize.escapeHtml(`<a href="x" onclick='y'>/\`=&</a>`)).toBe(
      '&lt;a href&#x3D;&quot;x&quot; onclick&#x3D;&#39;y&#39;&gt;&#x2F;&#x60;&#x3D;&amp;&lt;&#x2F;a&gt;'
    );
  });

  test('is total: null/undefined -> "", numbers are stringified', () => {
    expect(sanitize.escapeHtml(null)).toBe('');
    expect(sanitize.escapeHtml(undefined)).toBe('');
    expect(sanitize.escapeHtml(0)).toBe('0');
    expect(sanitize.escapeHtml(12.5)).toBe('12.5');
  });

  test('leaves plain and non-latin text untouched', () => {
    expect(sanitize.escapeHtml('Сільпо Київ 100 грн')).toBe('Сільпо Київ 100 грн');
  });

  test('escaping is not idempotent (documented: call once at the output boundary)', () => {
    expect(sanitize.escapeHtml(sanitize.escapeHtml('&'))).toBe('&amp;amp;');
  });
});

describe('lib/sanitize.stripUnsafe', () => {
  test('turns tabs/newlines into spaces, drops C0/DEL/C1 control chars, trims', () => {
    expect(sanitize.stripUnsafe('  a\tb\r\nc\u0000d\u007f\u0085e  ')).toBe('a b cde');
  });

  test('maxLength truncates; 0 gives empty; non-integer is ignored', () => {
    expect(sanitize.stripUnsafe('abcdef', { maxLength: 3 })).toBe('abc');
    expect(sanitize.stripUnsafe('abc', { maxLength: 0 })).toBe('');
    expect(sanitize.stripUnsafe('abcdef', { maxLength: 2.5 })).toBe('abcdef');
    expect(sanitize.stripUnsafe('abcdef', { maxLength: -1 })).toBe('abcdef');
  });

  test('keeps printable unicode (emoji, cyrillic)', () => {
    expect(sanitize.stripUnsafe('Кава ☕ 45')).toBe('Кава ☕ 45');
  });
});

describe('lib/sanitize.sanitizeFilename', () => {
  test('drops path traversal and directories (posix and windows)', () => {
    expect(sanitize.sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitize.sanitizeFilename('C:\\Users\\x\\..\\report.pdf')).toBe('report.pdf');
  });

  test('replaces unsafe characters, collapses dot runs, strips leading dots', () => {
    expect(sanitize.sanitizeFilename('rep ort<1>.pdf')).toBe('rep ort_1_.pdf');
    expect(sanitize.sanitizeFilename('...hidden..txt')).toBe('hidden.txt');
  });

  test('a name made only of dots becomes empty', () => {
    expect(sanitize.sanitizeFilename('..')).toBe('');
    expect(sanitize.sanitizeFilename('/')).toBe('');
    expect(sanitize.sanitizeFilename(null)).toBe('');
  });
});

describe('lib/money', () => {
  test('round fixes float drift and rounds half up for positives', () => {
    expect(money.round(0.1 + 0.2)).toBe(0.3);
    expect(money.round(1.005)).toBe(1.01);
    expect(money.round('2.345')).toBe(2.35);
  });

  test('round is total: non-finite and garbage -> 0', () => {
    expect(money.round('abc')).toBe(0);
    expect(money.round(Infinity)).toBe(0);
    expect(money.round(NaN)).toBe(0);
    expect(money.round(undefined)).toBe(0);
  });

  test('add/sub/mul/div/sum', () => {
    expect(money.add(0.1, 0.2, null, '0.05')).toBe(0.35);
    expect(money.add()).toBe(0);
    expect(money.sub(0.3, 0.1)).toBe(0.2);
    expect(money.sub(undefined, 5)).toBe(-5);
    expect(money.mul(19.99, 3)).toBe(59.97);
    expect(money.div(10, 3)).toBe(3.33);
    expect(money.div(1, 0)).toBe(0);
    expect(money.div(1, null)).toBe(0);
    expect(money.sum([0.1, 0.2, null, '1'])).toBe(1.3);
    expect(money.sum('not an array')).toBe(0);
  });

  // round(n) adds +EPSILON and uses Math.round, which rounds .5 toward +Infinity.
  // For negative amounts (every expense is stored negative) this rounds the half
  // cent the other way: round(1.005) = 1.01 but round(-1.005) = -1, so an expense
  // and its refund of the same raw value end up one cent apart.
  test.skip('bug: round is not symmetric for negative amounts (-1.005 -> -1, expected -1.01)', () => {
    expect(money.round(-1.005)).toBe(-1.01);
    expect(money.round(-0.125)).toBe(-money.round(0.125));
  });
});

describe('lib/txFilter', () => {
  test('cashflowOnly builds an AND fragment with one placeholder per legacy opening category', () => {
    const plain = txFilter.cashflowOnly();
    expect(plain.sql).toContain("AND type IN ('income', 'expense')");
    expect(plain.sql).toContain("COALESCE(category, '') NOT IN (?, ?, ?, ?)");
    expect(plain.params).toEqual(txFilter.OPENING_CATEGORIES);
    expect(plain.params).not.toBe(txFilter.OPENING_CATEGORIES); // a copy, safe to mutate

    const aliased = txFilter.cashflowOnly('t');
    expect(aliased.sql).toContain('t.type IN');
    expect(aliased.sql).toContain('COALESCE(t.category');
  });

  test('isOpening: explicit type or any legacy category spelling', () => {
    expect(txFilter.isOpening({ type: 'opening' })).toBe(true);
    expect(txFilter.isOpening({ type: 'income', category: 'Начальный баланс' })).toBe(true);
    expect(txFilter.isOpening({ type: 'income', category: '  Opening Balance  ' })).toBe(true);
    expect(txFilter.isOpening({ type: 'income', category: 'Salary' })).toBe(false);
    expect(txFilter.isOpening({ type: 'income', category: '' })).toBe(false);
    expect(txFilter.isOpening(null)).toBe(false);
  });

  test('isCashflow: only income/expense that are not openings', () => {
    expect(txFilter.isCashflow({ type: 'expense', category: 'Groceries' })).toBe(true);
    expect(txFilter.isCashflow({ type: 'income', category: 'Salary' })).toBe(true);
    expect(txFilter.isCashflow({ type: 'transfer' })).toBe(false);
    expect(txFilter.isCashflow({ type: 'opening' })).toBe(false);
    expect(txFilter.isCashflow({ type: 'income', category: 'Початковий баланс' })).toBe(false);
    expect(txFilter.isCashflow(undefined)).toBe(false);
  });
});

describe('lib/bodyFields', () => {
  const MAP = { target_amount: ['goalAmount'], due_date: [], name: null };

  test('snakeToCamel', () => {
    expect(bodyFields.snakeToCamel('target_amount')).toBe('targetAmount');
    expect(bodyFields.snakeToCamel('a_b_c')).toBe('aBC');
    expect(bodyFields.snakeToCamel('step_2')).toBe('step2');
    expect(bodyFields.snakeToCamel('plain')).toBe('plain');
  });

  test('normalizeBody accepts snake, camel and aliases; snake wins', () => {
    expect(bodyFields.normalizeBody({ targetAmount: 5, due_date: '2026-01-01', name: 'x' }, MAP)).toEqual({
      target_amount: 5,
      due_date: '2026-01-01',
      name: 'x',
    });
    expect(bodyFields.normalizeBody({ target_amount: 1, targetAmount: 2, goalAmount: 3 }, MAP)).toEqual({ target_amount: 1 });
    expect(bodyFields.normalizeBody({ goalAmount: 3 }, MAP)).toEqual({ target_amount: 3 });
  });

  test('empty string / null fall through to the next candidate; 0 and false are kept', () => {
    expect(bodyFields.normalizeBody({ target_amount: '', targetAmount: 7 }, MAP)).toEqual({ target_amount: 7 });
    expect(bodyFields.normalizeBody({ target_amount: null }, MAP)).toEqual({});
    expect(bodyFields.normalizeBody({ target_amount: 0, name: false }, MAP)).toEqual({ target_amount: 0, name: false });
  });

  test('non-object bodies give an empty result', () => {
    expect(bodyFields.normalizeBody(null, MAP)).toEqual({});
    expect(bodyFields.normalizeBody('x', MAP)).toEqual({});
  });

  test('missingFields + message', () => {
    const missing = bodyFields.missingFields({ a: 0, b: '', c: null }, ['a', 'b', 'c', 'd']);
    expect(missing).toEqual(['b', 'c', 'd']);
    expect(bodyFields.missingFieldsMessage(missing)).toBe('Missing required fields: b, c, d');
  });
});

describe('lib/respond', () => {
  function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  }

  test('ok wraps data with default 200 and custom status', () => {
    const r1 = fakeRes();
    respond.ok(r1, { id: 1 });
    expect(r1.statusCode).toBe(200);
    expect(r1.body).toEqual({ success: true, data: { id: 1 } });
    const r2 = fakeRes();
    respond.ok(r2, null, 201);
    expect(r2.statusCode).toBe(201);
    expect(r2.body).toEqual({ success: true, data: null });
  });

  test('fail produces the error envelope', () => {
    const r = fakeRes();
    respond.fail(r, 404, 'NOT_FOUND', 'nope');
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'nope' } });
  });
});
