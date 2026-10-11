/**
 * @jest-environment jsdom
 */
// test/transactions-csv-import.test.js — the legacy Transactions-page CSV
// import (public/js/transactions.js) must send multipart without forcing a
// JSON Content-Type, and /api/transactions/import must accept that upload.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

function loadImporter() {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'transactions.js'), 'utf8');
  // The page script is a plain global script; evaluate it and hand back the function.
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\n;return importTransactionsFromCSV;`)();
}

describe('importTransactionsFromCSV (Transactions page)', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'tok-123');
    global.t = (k) => k;
    global.showNotification = jest.fn();
    // fetchWithAuth forces application/json; it must not be used for multipart.
    global.fetchWithAuth = jest.fn(async () => {
      throw new Error('fetchWithAuth must not be used for FormData');
    });
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, count: 2 }) }));
  });

  test('posts the FormData with only the Authorization header', async () => {
    const importTransactionsFromCSV = loadImporter();
    const form = new FormData();
    form.append('accountId', '1');
    const result = await importTransactionsFromCSV(form);
    expect(result).toEqual({ success: true, count: 2 });
    expect(global.fetchWithAuth).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/transactions/import');
    expect(opts.body).toBe(form);
    expect(opts.headers).toEqual({ Authorization: 'Bearer tok-123' });
    expect(Object.keys(opts.headers).map((h) => h.toLowerCase())).not.toContain('content-type');
  });
});
