/**
 * @jest-environment jsdom
 */
// test/ui-lib.test.js — public/js/lib/ui.js: modal open/close convention,
// delegated data-action handlers, per-currency money helpers.

const path = require('path');

function loadUI() {
  jest.resetModules();
  delete window.UI;
  return require(path.join('..', 'public', 'js', 'lib', 'ui.js'));
}

describe('UI modals (hidden / is-open convention)', () => {
  let UI;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="opener">open</button>
      <div class="modal-backdrop" id="m1" hidden>
        <div class="modal">
          <div class="modal-header"><h2>Title</h2><button class="modal-close" data-action="ui:close">x</button></div>
          <div class="modal-body"><input id="first"><button id="second">ok</button></div>
        </div>
      </div>`;
    UI = loadUI();
  });

  test('inline modal starts hidden and opens via openModal', () => {
    const el = document.getElementById('m1');
    expect(el.hasAttribute('hidden')).toBe(true);
    expect(el.classList.contains('is-open')).toBe(false);

    UI.openModal('m1');
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(el.classList.contains('is-open')).toBe(true);
    expect(el.querySelector('.modal').getAttribute('role')).toBe('dialog');
    expect(el.querySelector('.modal').getAttribute('aria-modal')).toBe('true');
    expect(document.body.classList.contains('fm-modal-open')).toBe(true);
    // focus moved into the dialog (first non-close focusable)
    expect(document.activeElement.id).toBe('first');
  });

  test('closeModal hides again and restores focus', () => {
    document.getElementById('opener').focus();
    UI.openModal('m1');
    UI.closeModal('m1');
    const el = document.getElementById('m1');
    expect(el.hasAttribute('hidden')).toBe(true);
    expect(el.classList.contains('is-open')).toBe(false);
    expect(document.body.classList.contains('fm-modal-open')).toBe(false);
    expect(document.activeElement.id).toBe('opener');
  });

  test('Esc closes the top modal; data-action="ui:close" closes too', () => {
    UI.openModal('m1');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('m1').hasAttribute('hidden')).toBe(true);

    UI.openModal('m1');
    document.querySelector('#m1 .modal-close').click();
    expect(document.getElementById('m1').hasAttribute('hidden')).toBe(true);
  });

  test('backdrop click closes, click inside the dialog does not', () => {
    const el = UI.openModal('m1');
    el.querySelector('.modal-body').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.hasAttribute('hidden')).toBe(false);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.hasAttribute('hidden')).toBe(true);
  });

  test('Tab wraps focus inside the dialog', () => {
    UI.openModal('m1');
    document.getElementById('second').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    // last -> first (close button is the first focusable)
    expect(document.activeElement.classList.contains('modal-close')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement.id).toBe('second');
  });

  test('UI.modal() builds an ephemeral dialog that is removed on close', () => {
    const host = UI.modal({ id: 'dyn', title: 'Dyn <b>', body: '<input id="dyn-in">', footer: '<button data-action="ui:close">Cancel</button>' });
    expect(document.getElementById('dyn')).toBe(host);
    expect(host.classList.contains('is-open')).toBe(true);
    expect(host.querySelector('.modal-title').textContent).toBe('Dyn <b>'); // escaped
    expect(document.activeElement.id).toBe('dyn-in');
    host.querySelector('.modal-footer button').click();
    expect(document.getElementById('dyn')).toBeNull();
    expect(UI._openCount()).toBe(0);
  });
});

describe('UI delegated actions', () => {
  let UI;
  beforeEach(() => {
    document.body.innerHTML = `
      <button data-action="t:click" data-id="7">go</button>
      <a href="#x" data-action="t:link">link</a>
      <form data-submit="t:submit"><input name="a" value="1"><button type="submit">s</button></form>
      <select data-change="t:change"><option value="x">x</option><option value="y">y</option></select>`;
    UI = loadUI();
  });

  test('click / submit / change dispatch to registered handlers with the element', () => {
    const seen = [];
    UI.actions({
      't:click': (el) => seen.push(['click', el.dataset.id]),
      't:link': (el) => seen.push(['link', el.tagName]),
      't:submit': (form) => seen.push(['submit', new FormData(form).get('a')]),
      't:change': (el) => seen.push(['change', el.value]),
    });
    document.querySelector('[data-action="t:click"]').click();
    document.querySelector('a[data-action]').click();
    document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const sel = document.querySelector('select');
    sel.value = 'y';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(seen).toEqual([['click', '7'], ['link', 'A'], ['submit', '1'], ['change', 'y']]);
    expect(window.location.hash).toBe(''); // anchor default prevented
  });

  test('unknown actions are ignored without throwing', () => {
    document.body.innerHTML = '<button data-action="nope">x</button>';
    expect(() => document.querySelector('button').click()).not.toThrow();
  });
});

describe('UI money helpers', () => {
  let UI;
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.formatCurrency;
    delete window.appState;
    UI = loadUI();
  });

  test('money() uses the entity currency and falls back when the code is invalid', () => {
    expect(UI.money(1234.5, 'CAD')).toMatch(/1\s?234,50/);
    expect(UI.money(1234.5, 'CAD')).toMatch(/CA\$|CAD/);
    expect(UI.money(5, '₴')).toContain('₴'); // invalid ISO code -> number + code
  });

  test('money() delegates to window.formatCurrency when the app defines it', () => {
    window.formatCurrency = jest.fn((a, c) => `${c}:${a}`);
    UI = loadUI();
    expect(UI.money(10, 'usd')).toBe('USD:10');
    expect(window.formatCurrency).toHaveBeenCalledWith(10, 'USD');
  });

  test('sumByCurrency never adds across currencies', () => {
    const totals = UI.sumByCurrency([
      { amount: 10, currency: 'CAD' },
      { amount: 5.5, currency: 'CAD' },
      { amount: 100, currency: 'UAH' },
      { amount: 1 }, // no currency -> base currency (CAD without appState)
    ]);
    expect(totals).toEqual({ CAD: 16.5, UAH: 100 });
  });

  test('moneyList renders one entry per currency', () => {
    document.body.innerHTML = UI.moneyList({ CAD: 15.5, UAH: 101 });
    const items = document.querySelectorAll('.fm-money');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toMatch(/15,50/);
    expect(items[1].textContent).toMatch(/101,00/);
  });

  test('aggregateMoney shows the currency only when all entities share it', () => {
    expect(UI.aggregateMoney(10, ['CAD', 'cad'])).toMatch(/CA\$|CAD/);
    expect(UI.aggregateMoney(10, ['CAD', 'UAH'])).not.toMatch(/CA\$|CAD|₴|UAH/);
    expect(UI.mixedCurrencyNote(['CAD'])).toBe('');
    expect(UI.mixedCurrencyNote(['CAD', 'UAH'])).toContain('CAD, UAH');
  });

  test('accountCurrencies reads both appState.accounts shapes', () => {
    window.appState = { accounts: [{ currency: 'CAD' }, { currency: 'uah' }, { currency: 'CAD' }] };
    expect(UI.accountCurrencies()).toEqual(['CAD', 'UAH']);
    window.appState = { accounts: { own: [{ currency: 'EUR' }], shared: [{ currency: 'USD' }], all: [{ currency: 'EUR' }, { currency: 'USD' }] } };
    expect(UI.accountCurrencies()).toEqual(['EUR', 'USD']);
  });

  test('currencyOptions marks the selected code and includes account currencies', () => {
    window.appState = { accounts: [{ currency: 'CAD' }] };
    document.body.innerHTML = `<select>${UI.currencyOptions('EUR')}</select>`;
    const sel = document.querySelector('select');
    expect(sel.value).toBe('EUR');
    expect([...sel.options].map((o) => o.value)).toEqual(expect.arrayContaining(['CAD', 'EUR', 'USD', 'UAH']));
  });

  test('monthlyFactor converts billing cycles', () => {
    expect(UI.monthlyFactor('monthly')).toBe(1);
    expect(UI.monthlyFactor('yearly')).toBeCloseTo(1 / 12);
    expect(UI.monthlyFactor('weekly')).toBeCloseTo(52 / 12);
  });

  test('emptyState emits the accounts-page markup', () => {
    document.body.innerHTML = UI.emptyState({ icon: 'fa-users', title: 'Нет групп', text: 'Создайте', action: { label: 'Новая', action: 'split:add', icon: 'fa-plus' } });
    const root = document.querySelector('.empty-state.fm-empty');
    expect(root).not.toBeNull();
    expect(root.querySelector('.empty-state-icon i').className).toBe('fas fa-users');
    expect(root.querySelector('h2').textContent).toBe('Нет групп');
    expect(root.querySelector('button').dataset.action).toBe('split:add');
  });
});
