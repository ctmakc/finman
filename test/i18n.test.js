// test/i18n.test.js — unit tests for the frontend i18n runtime + the pure
// helpers in lib/crud.js / lib/a11y.js. These modules are browser scripts
// that also `module.exports` when run under node (no DOM required here), so
// we can require() and exercise their settlement-free logic directly.

const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public', 'js');

// Locale dicts populate window.FINMAN_LOCALES; in node `window` is undefined,
// so they attach to globalThis. Require them first so i18n picks them up.
const enDict = require(path.join(PUBLIC, 'locales', 'en.js'));
const ukDict = require(path.join(PUBLIC, 'locales', 'uk.js'));
const ruDict = require(path.join(PUBLIC, 'locales', 'ru.js'));
const i18n = require(path.join(PUBLIC, 'i18n.js'));
const crud = require(path.join(PUBLIC, 'lib', 'crud.js'));

describe('locale dictionaries', () => {
  test('en/uk/ru all exist on globalThis.FINMAN_LOCALES', () => {
    expect(globalThis.FINMAN_LOCALES).toBeDefined();
    expect(globalThis.FINMAN_LOCALES.en).toBe(enDict);
    expect(globalThis.FINMAN_LOCALES.uk).toBe(ukDict);
    expect(globalThis.FINMAN_LOCALES.ru).toBe(ruDict);
  });

  test('each locale covers at least 40 shared keys', () => {
    expect(Object.keys(enDict).length).toBeGreaterThanOrEqual(40);
    expect(Object.keys(ukDict).length).toBeGreaterThanOrEqual(40);
    expect(Object.keys(ruDict).length).toBeGreaterThanOrEqual(40);
  });

  test('all three locales share the exact same key set (no gaps)', () => {
    const en = Object.keys(enDict).sort();
    const uk = Object.keys(ukDict).sort();
    const ru = Object.keys(ruDict).sort();
    expect(uk).toEqual(en);
    expect(ru).toEqual(en);
  });
});

describe('i18n.t()', () => {
  beforeEach(() => {
    // i18n auto-detected a language at require time; pin it for determinism.
    i18n.setLanguage('uk', { translate: false });
  });

  test('returns the translation for the active language', () => {
    i18n.setLanguage('en', { translate: false });
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
    i18n.setLanguage('uk', { translate: false });
    expect(i18n.t('nav.dashboard')).toBe('Огляд');
    i18n.setLanguage('ru', { translate: false });
    expect(i18n.t('nav.dashboard')).toBe('Обзор');
  });

  test('interpolates {var} placeholders', () => {
    i18n.setLanguage('en', { translate: false });
    expect(i18n.t('msg.greeting', { name: 'Max' })).toBe('Hello, Max!');
    expect(i18n.t('msg.itemsCount', { count: 7 })).toBe('7 items');
  });

  test('interpolates the same placeholder across languages', () => {
    i18n.setLanguage('ru', { translate: false });
    expect(i18n.t('msg.greeting', { name: 'Макс' })).toBe('Здравствуйте, Макс!');
  });

  test('leaves unknown placeholders untouched', () => {
    i18n.setLanguage('en', { translate: false });
    // `name` not supplied -> the {name} token stays literally.
    expect(i18n.t('msg.greeting', {})).toBe('Hello, {name}!');
  });

  test('falls back to the key itself when missing', () => {
    expect(i18n.t('totally.missing.key')).toBe('totally.missing.key');
  });

  test('missing key still interpolates vars into the key fallback', () => {
    expect(i18n.t('missing.{name}', { name: 'X' })).toBe('missing.X');
  });

  test('falls back to default language (uk) when active language lacks a key', () => {
    // Inject a key that only exists in the default (uk) dict.
    i18n.registerLocales({ uk: Object.assign({}, ukDict, { 'only.in.uk': 'лише-укр' }) });
    i18n.setLanguage('en', { translate: false });
    expect(i18n.t('only.in.uk')).toBe('лише-укр');
    // restore clean dict for any later tests
    i18n.registerLocales({ uk: ukDict });
  });

  test('handles null/empty keys gracefully', () => {
    expect(i18n.t(null)).toBe('');
    expect(i18n.t('')).toBe('');
  });
});

describe('i18n language management', () => {
  test('setLanguage rejects unsupported codes and keeps current', () => {
    i18n.setLanguage('en', { translate: false });
    const result = i18n.setLanguage('zz', { translate: false });
    expect(result).toBe('en');
    expect(i18n.getLanguage()).toBe('en');
  });

  test('available() lists uk/en/ru', () => {
    const langs = i18n.available();
    expect(langs).toEqual(expect.arrayContaining(['uk', 'en', 'ru']));
  });

  test('default language is uk', () => {
    expect(i18n.DEFAULT_LANG).toBe('uk');
  });

  test('onChange subscribers fire on language switch and can unsubscribe', () => {
    const seen = [];
    const unsub = i18n.onChange((lang) => seen.push(lang));
    i18n.setLanguage('ru', { translate: false });
    i18n.setLanguage('en', { translate: false });
    expect(seen).toEqual(['ru', 'en']);
    unsub();
    i18n.setLanguage('uk', { translate: false });
    expect(seen).toEqual(['ru', 'en']); // no new entries after unsubscribe
  });
});

describe('i18n internals', () => {
  test('_interpolate supports both {x} and {{x}} forms', () => {
    expect(i18n._interpolate('a {x} b', { x: 1 })).toBe('a 1 b');
    expect(i18n._interpolate('a {{x}} b', { x: 2 })).toBe('a 2 b');
  });

  test('_lookup resolves nested dictionaries too', () => {
    const nested = { nav: { dashboard: 'D' } };
    expect(i18n._lookup(nested, 'nav.dashboard')).toBe('D');
    expect(i18n._lookup({ 'a.b': 'flat' }, 'a.b')).toBe('flat');
    expect(i18n._lookup(nested, 'nope')).toBeUndefined();
  });
});

describe('lib/crud pure helpers', () => {
  test('createCrudModule throws without an endpoint', () => {
    expect(() => crud.createCrudModule({ resource: 'x' })).toThrow(/endpoint/);
  });

  test('exposes data + ui methods', () => {
    const mod = crud.createCrudModule({
      resource: 'goal',
      endpoint: '/api/goals',
      fields: [{ name: 'name', type: 'text', required: true }]
    });
    ['list', 'get', 'create', 'update', 'remove', 'deleteWithConfirm',
      'openCreate', 'openEdit', 'closeModal', 'buildFormHTML', 'renderItem']
      .forEach((m) => expect(typeof mod[m]).toBe('function'));
    expect(mod.endpoint).toBe('/api/goals');
    expect(mod.resource).toBe('goal');
  });

  test('buildFormHTML renders fields, required markers, and select options', () => {
    const mod = crud.createCrudModule({
      resource: 'debt',
      endpoint: '/api/debts',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'currency', label: 'Currency', type: 'select',
          options: [{ value: 'UAH', label: 'UAH' }, { value: 'USD', label: 'USD' }] }
      ]
    });
    const html = mod.buildFormHTML(null);
    expect(html).toContain('<form');
    expect(html).toContain('name="name"');
    expect(html).toContain('required');
    expect(html).toContain('<select');
    expect(html).toContain('value="USD"');
    // label is associated with its control via for/id
    expect(html).toMatch(/for="crud-field-name"/);
    expect(html).toMatch(/id="crud-field-name"/);
  });

  test('buildFormHTML prefills values when editing an item', () => {
    const mod = crud.createCrudModule({
      resource: 'acc',
      endpoint: '/api/accounts',
      fields: [{ name: 'name', type: 'text' }]
    });
    const html = mod.buildFormHTML({ id: 5, name: 'Cash' });
    expect(html).toContain('value="Cash"');
  });

  test('selected option reflects the edited item value', () => {
    const mod = crud.createCrudModule({
      resource: 'acc',
      endpoint: '/api/accounts',
      fields: [{ name: 'currency', type: 'select',
        options: [{ value: 'UAH', label: 'UAH' }, { value: 'USD', label: 'USD' }] }]
    });
    const html = mod.buildFormHTML({ id: 1, currency: 'USD' });
    expect(html).toMatch(/value="USD" selected/);
    expect(html).not.toMatch(/value="UAH" selected/);
  });

  test('_esc escapes HTML-significant characters', () => {
    expect(crud._esc('<b>"x"&\'</b>'))
      .toBe('&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;');
    expect(crud._esc(null)).toBe('');
  });

  test('renderItem uses custom render when provided', () => {
    const mod = crud.createCrudModule({
      resource: 'goal',
      endpoint: '/api/goals',
      fields: [],
      render: (item) => `<li>${item.name}</li>`
    });
    expect(mod.renderItem({ id: 1, name: 'Car' })).toBe('<li>Car</li>');
  });

  test('renderItem default markup includes title and data id, escaped', () => {
    const mod = crud.createCrudModule({
      resource: 'goal',
      endpoint: '/api/goals',
      fields: []
    });
    const html = mod.renderItem({ id: 2, name: 'A & B' });
    expect(html).toContain('data-crud-id="2"');
    expect(html).toContain('A &amp; B');
  });
});
