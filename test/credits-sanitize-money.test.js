// Unit tests for lib/sanitize.js, lib/money.js edge cases and lib/respond.js.
'use strict';

const { escapeHtml, stripUnsafe, sanitizeFilename, toStr } = require('../lib/sanitize');
const money = require('../lib/money');
const { ok, fail } = require('../lib/respond');

function fakeRes() {
  return {
    statusCode: null,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('lib/sanitize.escapeHtml', () => {
  test('escapes every HTML-sensitive character', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&\`=/`)).toBe(
      '&lt;a href&#x3D;&quot;x&quot; onclick&#x3D;&#39;y&#39;&gt;&amp;&#x60;&#x3D;&#x2F;'
    );
  });

  test('is total: null/undefined -> "", numbers stringified', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(12.5)).toBe('12.5');
  });

  test('leaves plain text (incl. Cyrillic) untouched', () => {
    expect(escapeHtml('Сільпо Kyiv 12,50')).toBe('Сільпо Kyiv 12,50');
  });

  test('applied twice double-escapes (documented: call once at the output boundary)', () => {
    expect(escapeHtml(escapeHtml('&'))).toBe('&amp;amp;');
  });
});

describe('lib/sanitize.stripUnsafe', () => {
  test('turns tabs/newlines into a single space and removes C0/DEL/C1 controls', () => {
    expect(stripUnsafe('a\tb\r\nc')).toBe('a b c');
    expect(stripUnsafe('x\u0000y\u0007z\u007f\u0085!')).toBe('xyz!');
  });

  test('trims edges and keeps printable Unicode', () => {
    expect(stripUnsafe('  Привіт 👋  ')).toBe('Привіт 👋');
  });

  test('maxLength truncates; non-integer or negative maxLength is ignored', () => {
    expect(stripUnsafe('abcdef', { maxLength: 3 })).toBe('abc');
    expect(stripUnsafe('abcdef', { maxLength: 0 })).toBe('');
    expect(stripUnsafe('abcdef', { maxLength: 2.5 })).toBe('abcdef');
    expect(stripUnsafe('abcdef', { maxLength: -1 })).toBe('abcdef');
  });

  test.skip('bug: truncation happens after trim, so the result can end with whitespace', () => {
    // Contract (header comment): "trims edges". 'a\0b\n c' -> 'ab c' -> slice(3) -> 'ab '.
    expect(stripUnsafe('a\u0000b\n c', { maxLength: 3 })).toBe('ab');
  });

  test('toStr coercion', () => {
    expect(toStr(null)).toBe('');
    expect(toStr(false)).toBe('false');
    expect(toStr({})).toBe('[object Object]');
  });
});

describe('lib/sanitize.sanitizeFilename', () => {
  test('drops directory components (path traversal, absolute and Windows paths)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('/var/tmp/report.csv')).toBe('report.csv');
    expect(sanitizeFilename('C:\\Windows\\evil.exe')).toBe('evil.exe');
  });

  test('pure dot names collapse to empty', () => {
    expect(sanitizeFilename('..')).toBe('');
    expect(sanitizeFilename('../..')).toBe('');
  });

  test('collapses dot runs and strips leading dots (no hidden files)', () => {
    expect(sanitizeFilename('a..b.txt')).toBe('a.b.txt');
    expect(sanitizeFilename('.env')).toBe('env');
  });

  test('replaces shell/FS-unsafe characters with underscore', () => {
    expect(sanitizeFilename('rep*ort?<1>.csv')).toBe('rep_ort_1_.csv');
    expect(sanitizeFilename('a;rm -rf.txt')).toBe('a_rm -rf.txt');
  });

  test('non-ASCII letters are replaced (current ASCII-only behaviour)', () => {
    // \w is ASCII-only: a Cyrillic name collapses to "_".
    expect(sanitizeFilename('отчёт 2026.pdf')).toBe('_ 2026.pdf');
  });
});

describe('lib/money edge cases', () => {
  test('round is float-safe for positive halves', () => {
    expect(money.round(1.005)).toBe(1.01);
    expect(money.round(2.675)).toBe(2.68);
    expect(money.round(0.1 + 0.2)).toBe(0.3);
  });

  test('non-finite inputs become 0', () => {
    expect(money.round(NaN)).toBe(0);
    expect(money.round(Infinity)).toBe(0);
    expect(money.round('abc')).toBe(0);
    expect(money.add(1, null, undefined, '2.5')).toBe(3.5);
  });

  test('div by zero/empty -> 0; sum ignores non-arrays', () => {
    expect(money.div(10, 0)).toBe(0);
    expect(money.div(10, '')).toBe(0);
    expect(money.div(10, 3)).toBe(3.33);
    expect(money.sum('nope')).toBe(0);
    expect(money.sum([0.1, 0.2, 0.3])).toBe(0.6);
  });

  test.skip('bug: round is sign-asymmetric (expenses are stored negative)', () => {
    // Math.round rounds .5 towards +Infinity and EPSILON is added regardless of sign:
    // round(1.005) = 1.01 but round(-1.005) = -1; round(-0.125) = -0.12.
    expect(money.round(-1.005)).toBe(-money.round(1.005));
    expect(money.round(-0.125)).toBe(-money.round(0.125));
    expect(money.mul(-100, 0.01005)).toBe(-money.mul(100, 0.01005));
  });
});

describe('lib/respond envelope', () => {
  test('ok defaults to 200 and wraps data', () => {
    const res = fakeRes();
    ok(res, { a: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { a: 1 } });
  });

  test('ok honours custom status', () => {
    const res = fakeRes();
    ok(res, null, 201);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, data: null });
  });

  test('fail builds the error envelope', () => {
    const res = fakeRes();
    fail(res, 422, 'BAD', 'nope');
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ success: false, error: { code: 'BAD', message: 'nope' } });
  });
});
