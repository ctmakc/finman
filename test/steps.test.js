// test/steps.test.js — First steps rail on Home (public/js/steps.js, STATEMENT DESK 24.11).
//   - the example ticks step 1, own data ticks step 2;
//   - «Protect your data» shows only with own data and while FMVault.protectionPending() says so;
//   - «Make it yours» asks to hide the example while it is still on screen;
//   - Money map / budgets visits tick their steps.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(extra = {}) {
  const store = new Map();
  const window = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    ...extra,
  };
  window.window = window;
  const ctx = vm.createContext({ window, localStorage: window.localStorage, sessionStorage: window.sessionStorage, appState: { user: { id: 9 } }, console, Date, Promise });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'steps.js'), 'utf8'), ctx);
  return window;
}

test('new account with the example: 1 of 4, the one-step entry is current', async () => {
  const w = load();
  const r = await w.FMSteps._build({ demo: true, ownTransactions: 0 });
  expect(r.list.map((s) => s.key)).toEqual(['example', 'own', 'map', 'yours']);
  expect(r.list.filter((s) => s.done).map((s) => s.key)).toEqual(['example']);
});

test('protect step appears after own data while the vault asks for it', async () => {
  const w = load({ FMVault: { protectionPending: async () => ({ kind: 'google' }), protect: async () => true } });
  let r = await w.FMSteps._build({ demo: true, ownTransactions: 0 });
  expect(r.list.some((s) => s.key === 'protect')).toBe(false); // nothing to protect yet
  r = await w.FMSteps._build({ demo: true, ownTransactions: 1 });
  expect(r.list.map((s) => s.key)).toEqual(['example', 'own', 'protect', 'map', 'yours']);
  const w2 = load({ FMVault: { protectionPending: async () => null } });
  r = await w2.FMSteps._build({ demo: false, ownTransactions: 3 });
  expect(r.list.some((s) => s.key === 'protect')).toBe(false);
});

test('visits tick Money map and budget; example still on screen keeps «Make it yours» open', async () => {
  const w = load();
  w.FMSteps.visited('money-map');
  let r = await w.FMSteps._build({ demo: true, ownTransactions: 2 });
  expect(r.list.find((s) => s.key === 'map').done).toBe(true);
  expect(r.list.find((s) => s.key === 'yours').done).toBe(false);
  expect(r.list.find((s) => s.key === 'yours').body).toMatch(/Hide the example/);
  w.FMSteps.visited('budgets');
  r = await w.FMSteps._build({ demo: false, ownTransactions: 2 });
  expect(r.list.every((s) => s.done)).toBe(true);
});
