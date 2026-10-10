// config/bank-api-config.js — honest bank connectivity catalogue.
//
// Two kinds of entries:
//   type: 'token'       — a real, documented personal API the app talks to
//                          directly with a user-supplied token. Today: Monobank.
//   type: 'file-import' — the bank has no free personal API (true for every
//                          Canadian bank in 2026 — Plaid/Flinks are paid B2B
//                          aggregators). The user downloads a CSV / OFX / QFX
//                          statement from online banking and imports it with the
//                          import wizard. `csvPreset` names the column layout in
//                          services/csvImportService.js; `verified` says whether
//                          that layout was confirmed against a real export.
//
// Nothing here is an OAuth stub: there is no bank in this file the app cannot
// actually read from. Keys `regions` and `authTypes` are metadata, not banks.

const META_KEYS = new Set(['regions', 'authTypes', 'META_KEYS', 'listBanks', 'isBank']);

const banks = {
  // ==================== TOKEN (real personal API) ====================
  monobank: {
    name: 'Monobank',
    country: 'UA',
    region: 'ukraine',
    type: 'token',
    icon: 'monobank-icon.png',
    apiUrl: 'https://api.monobank.ua',
    docsUrl: 'https://api.monobank.ua/docs/',
    authType: 'api_key',
    requiresRedirect: false,
    tokenInstructions:
      'Open the Monobank app → Settings → "API for developers" (or visit api.monobank.ua), ' +
      'sign in with your phone and copy the personal token. The token is read-only.',
    rateLimitNote: 'Monobank allows one statement request per account every 60 seconds and at most 31 days per request.',
    endpoints: {
      clientInfo: '/personal/client-info',
      statement: '/personal/statement/{account}/{from}/{to}'
    },
    formats: ['api', 'csv'],
    csvPreset: 'monobank'
  },

  // ==================== FILE IMPORT — Canada ====================
  rbc: {
    name: 'RBC Royal Bank',
    country: 'CA',
    region: 'canada',
    type: 'file-import',
    formats: ['csv', 'qfx'],
    csvPreset: 'rbc',
    verified: false,
    exportHint: 'RBC Online Banking → account → Download transactions → CSV or Quicken (QFX).'
  },
  td_canada: {
    name: 'TD Canada Trust',
    country: 'CA',
    region: 'canada',
    type: 'file-import',
    formats: ['csv', 'qfx'],
    csvPreset: 'td',
    verified: false,
    exportHint: 'EasyWeb → Accounts → Account Activity → Download → Spreadsheet (.CSV) or Quicken (.QFX).'
  },
  scotiabank: {
    name: 'Scotiabank',
    country: 'CA',
    region: 'canada',
    type: 'file-import',
    formats: ['csv', 'qfx'],
    csvPreset: 'scotiabank',
    verified: false,
    exportHint: 'Scotia OnLine → account → Download transactions → CSV or Quicken.'
  },
  bmo: {
    name: 'BMO Bank of Montreal',
    country: 'CA',
    region: 'canada',
    type: 'file-import',
    formats: ['csv', 'qfx'],
    csvPreset: 'bmo',
    verified: false,
    exportHint: 'BMO Online Banking → account → Download transactions → CSV or Quicken.'
  },
  cibc: {
    name: 'CIBC',
    country: 'CA',
    region: 'canada',
    type: 'file-import',
    formats: ['csv', 'qfx'],
    csvPreset: 'cibc',
    verified: false,
    exportHint: 'CIBC Online Banking → account → Download Transactions → CSV or Quicken (QFX).'
  },
  tangerine: {
    name: 'Tangerine',
    country: 'CA',
    region: 'canada',
    type: 'file-import',
    formats: ['csv', 'ofx'],
    csvPreset: 'tangerine',
    verified: false,
    exportHint: 'Tangerine → account → Download transactions → CSV or OFX.'
  },
  wealthsimple_cash: {
    name: 'Wealthsimple Cash',
    country: 'CA',
    region: 'canada',
    type: 'file-import',
    formats: ['csv'],
    csvPreset: 'wealthsimple',
    verified: false,
    exportHint: 'Wealthsimple → Activity → Export (CSV). The export covers every account; pick the Cash rows.'
  },
  eq_bank: {
    name: 'EQ Bank',
    country: 'CA',
    region: 'canada',
    type: 'file-import',
    formats: ['csv'],
    csvPreset: 'eqbank',
    verified: false,
    exportHint: 'EQ Bank → account → Transactions → Download CSV.'
  },

  // ==================== FILE IMPORT — international ====================
  revolut: {
    name: 'Revolut',
    country: 'INTL',
    region: 'international',
    type: 'file-import',
    formats: ['csv'],
    csvPreset: 'revolut',
    verified: true,
    exportHint: 'Revolut app → account → Statement → Excel (the file is CSV). One file per currency.'
  },
  wise: {
    name: 'Wise',
    country: 'INTL',
    region: 'international',
    type: 'file-import',
    formats: ['csv'],
    csvPreset: 'wise',
    verified: true,
    exportHint: 'Wise → balance → Statements → CSV. One file per currency balance.'
  }
};

module.exports = banks;

// Groups for the UI.
module.exports.regions = {
  ukraine: { name: 'Ukraine', flag: '🇺🇦', banks: ['monobank'] },
  canada: {
    name: 'Canada',
    flag: '🇨🇦',
    banks: ['rbc', 'td_canada', 'scotiabank', 'bmo', 'cibc', 'tangerine', 'wealthsimple_cash', 'eq_bank']
  },
  international: { name: 'International', flag: '🌍', banks: ['revolut', 'wise'] }
};

// Connection kinds the UI knows how to render.
module.exports.authTypes = {
  api_key: {
    name: 'Personal token',
    description: 'Read-only token issued by the bank to the account holder',
    requiresClientCredentials: false
  },
  file_import: {
    name: 'Statement file',
    description: 'CSV / OFX / QFX statement downloaded from online banking',
    requiresClientCredentials: false
  }
};

module.exports.META_KEYS = META_KEYS;

// True when `key` names a bank entry (not metadata / helpers).
module.exports.isBank = function isBank(key) {
  return Object.prototype.hasOwnProperty.call(banks, key) && !META_KEYS.has(key) && typeof banks[key] === 'object';
};

// Flat, UI-ready list of banks.
module.exports.listBanks = function listBanks(filter = {}) {
  return Object.keys(banks)
    .filter((key) => module.exports.isBank(key))
    .filter((key) => !filter.region || banks[key].region === filter.region)
    .filter((key) => !filter.type || banks[key].type === filter.type)
    .map((key) => {
      const b = banks[key];
      return {
        id: key,
        name: b.name,
        country: b.country,
        region: b.region,
        type: b.type,
        icon: b.icon || null,
        authType: b.type === 'token' ? b.authType : 'file_import',
        requiresRedirect: false,
        formats: b.formats || [],
        csvPreset: b.csvPreset || null,
        verified: b.type === 'token' ? true : b.verified === true,
        tokenInstructions: b.tokenInstructions || null,
        exportHint: b.exportHint || null,
        docsUrl: b.docsUrl || null,
        rateLimitNote: b.rateLimitNote || null
      };
    });
};
