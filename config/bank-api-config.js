// Конфигурация для поддерживаемых банковских API
// Пользователи могут добавлять свои API-ключи в настройках

module.exports = {
  // ==================== УКРАИНСКИЕ БАНКИ ====================

  // Monobank API (публичный API, не требует OAuth)
  monobank: {
    name: 'Monobank',
    country: 'UA',
    region: 'ukraine',
    icon: 'monobank-icon.png',
    apiUrl: 'https://api.monobank.ua',
    scopes: ['personal'],
    authType: 'api_key', // Токен из приложения Monobank
    requiresRedirect: false,
    tokenInstructions: 'Отримайте токен у додатку Monobank: Налаштування -> API для розробників',
    endpoints: {
      userInfo: '/personal/client-info',
      accounts: '/personal/client-info',
      transactions: '/personal/statement/{account}/{from}/{to}'
    }
  },

  // ПриватБанк API
  privatbank: {
    name: 'ПриватБанк',
    country: 'UA',
    region: 'ukraine',
    icon: 'privatbank-icon.png',
    apiUrl: 'https://api.privatbank.ua',
    scopes: ['accounts', 'statements'],
    authType: 'merchant', // Merchant ID + Password
    requiresRedirect: false,
    tokenInstructions: 'Отримайте Merchant ID та пароль у Приват24 для бізнесу',
    endpoints: {
      balance: '/p24api/balance',
      statements: '/p24api/rest_fiz'
    }
  },

  // ПУМБ API
  pumb: {
    name: 'ПУМБ',
    country: 'UA',
    region: 'ukraine',
    icon: 'pumb-icon.png',
    apiUrl: 'https://api.pumb.ua',
    scopes: ['accounts', 'transactions'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.PUMB_CLIENT_ID || '',
    clientSecret: process.env.PUMB_CLIENT_SECRET || ''
  },

  // Ощадбанк API
  oschadbank: {
    name: 'Ощадбанк',
    country: 'UA',
    region: 'ukraine',
    icon: 'oschadbank-icon.png',
    apiUrl: 'https://api.oschadbank.ua',
    scopes: ['accounts', 'transactions'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.OSCHADBANK_CLIENT_ID || '',
    clientSecret: process.env.OSCHADBANK_CLIENT_SECRET || ''
  },

  // ==================== КАНАДСКИЕ БАНКИ ====================

  // TD Bank (через Plaid или direct API)
  td_canada: {
    name: 'TD Canada Trust',
    country: 'CA',
    region: 'canada',
    icon: 'td-icon.png',
    apiUrl: 'https://api.td.com',
    scopes: ['accounts', 'transactions'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.TD_CLIENT_ID || '',
    clientSecret: process.env.TD_CLIENT_SECRET || '',
    tokenInstructions: 'Register at TD Developer Portal: developer.td.com'
  },

  // RBC Royal Bank
  rbc: {
    name: 'RBC Royal Bank',
    country: 'CA',
    region: 'canada',
    icon: 'rbc-icon.png',
    apiUrl: 'https://api.rbc.com',
    scopes: ['accounts', 'transactions'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.RBC_CLIENT_ID || '',
    clientSecret: process.env.RBC_CLIENT_SECRET || '',
    tokenInstructions: 'Register at RBC Developer Portal'
  },

  // Scotiabank
  scotiabank: {
    name: 'Scotiabank',
    country: 'CA',
    region: 'canada',
    icon: 'scotiabank-icon.png',
    apiUrl: 'https://api.scotiabank.com',
    scopes: ['accounts', 'transactions'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.SCOTIABANK_CLIENT_ID || '',
    clientSecret: process.env.SCOTIABANK_CLIENT_SECRET || ''
  },

  // BMO Bank of Montreal
  bmo: {
    name: 'BMO Bank of Montreal',
    country: 'CA',
    region: 'canada',
    icon: 'bmo-icon.png',
    apiUrl: 'https://api.bmo.com',
    scopes: ['accounts', 'transactions'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.BMO_CLIENT_ID || '',
    clientSecret: process.env.BMO_CLIENT_SECRET || ''
  },

  // CIBC
  cibc: {
    name: 'CIBC',
    country: 'CA',
    region: 'canada',
    icon: 'cibc-icon.png',
    apiUrl: 'https://api.cibc.com',
    scopes: ['accounts', 'transactions'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.CIBC_CLIENT_ID || '',
    clientSecret: process.env.CIBC_CLIENT_SECRET || ''
  },

  // ==================== МЕЖДУНАРОДНЫЕ СЕРВИСЫ ====================

  // Revolut Business API
  revolut: {
    name: 'Revolut',
    country: 'INTL',
    region: 'international',
    icon: 'revolut-icon.png',
    apiUrl: 'https://b2b.revolut.com/api/1.0',
    scopes: ['accounts', 'transactions'],
    authType: 'api_key',
    requiresRedirect: false,
    tokenInstructions: 'Get API key from Revolut Business: Settings -> API',
    endpoints: {
      accounts: '/accounts',
      transactions: '/transactions'
    }
  },

  // Wise (TransferWise) API
  wise: {
    name: 'Wise',
    country: 'INTL',
    region: 'international',
    icon: 'wise-icon.png',
    apiUrl: 'https://api.transferwise.com',
    scopes: ['accounts', 'transactions'],
    authType: 'api_key',
    requiresRedirect: false,
    tokenInstructions: 'Get API token from Wise: Settings -> API tokens',
    endpoints: {
      profiles: '/v1/profiles',
      accounts: '/v1/borderless-accounts',
      transactions: '/v3/profiles/{profileId}/borderless-accounts/{accountId}/statement.json'
    }
  },

  // PayPal API
  paypal: {
    name: 'PayPal',
    country: 'INTL',
    region: 'international',
    icon: 'paypal-icon.png',
    apiUrl: 'https://api.paypal.com',
    sandboxUrl: 'https://api.sandbox.paypal.com',
    scopes: ['openid', 'email', 'https://uri.paypal.com/services/reporting/search/read'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    tokenInstructions: 'Register at PayPal Developer Portal: developer.paypal.com'
  },

  // Plaid (агрегатор для множества банков)
  plaid: {
    name: 'Plaid (US/CA Banks)',
    country: 'INTL',
    region: 'international',
    icon: 'plaid-icon.png',
    apiUrl: 'https://production.plaid.com',
    sandboxUrl: 'https://sandbox.plaid.com',
    scopes: ['transactions', 'accounts', 'balance'],
    authType: 'link_token', // Специальный тип для Plaid Link
    requiresRedirect: true,
    clientId: process.env.PLAID_CLIENT_ID || '',
    secret: process.env.PLAID_SECRET || '',
    tokenInstructions: 'Register at Plaid Dashboard: dashboard.plaid.com'
  },

  // ==================== РОССИЙСКИЕ БАНКИ ====================

  // Тинькофф API
  tinkoff: {
    name: 'Тинькофф',
    country: 'RU',
    region: 'russia',
    icon: 'tinkoff-icon.png',
    apiUrl: 'https://api.tinkoff.ru',
    scopes: ['account_info', 'transactions', 'operations'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.TINKOFF_CLIENT_ID || '',
    clientSecret: process.env.TINKOFF_CLIENT_SECRET || ''
  },

  // Сбербанк API
  sberbank: {
    name: 'Сбербанк',
    country: 'RU',
    region: 'russia',
    icon: 'sberbank-icon.png',
    apiUrl: 'https://api.sberbank.ru',
    scopes: ['accounts', 'transactions'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.SBERBANK_CLIENT_ID || '',
    clientSecret: process.env.SBERBANK_CLIENT_SECRET || ''
  },

  // Альфа-Банк API
  alfabank: {
    name: 'Альфа-Банк',
    country: 'RU',
    region: 'russia',
    icon: 'alfabank-icon.png',
    apiUrl: 'https://api.alfabank.ru',
    scopes: ['accounts', 'operations'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.ALFABANK_CLIENT_ID || '',
    clientSecret: process.env.ALFABANK_CLIENT_SECRET || ''
  },

  // ВТБ API
  vtb: {
    name: 'ВТБ',
    country: 'RU',
    region: 'russia',
    icon: 'vtb-icon.png',
    apiUrl: 'https://api.vtb.ru',
    scopes: ['accounts', 'statement'],
    authType: 'oauth2',
    requiresRedirect: true,
    clientId: process.env.VTB_CLIENT_ID || '',
    clientSecret: process.env.VTB_CLIENT_SECRET || ''
  },

  // ==================== ТЕСТОВЫЙ БАНК ====================

  // Тестовый API (для разработки)
  test: {
    name: 'Тестовый банк',
    country: 'TEST',
    region: 'test',
    icon: 'test-bank-icon.png',
    apiUrl: 'http://localhost:3001',
    scopes: ['all'],
    authType: 'api_key',
    requiresRedirect: false,
    apiKey: 'test_api_key'
  }
};

// Группировка банков по регионам для UI
module.exports.regions = {
  ukraine: {
    name: 'Украина',
    flag: '🇺🇦',
    banks: ['monobank', 'privatbank', 'pumb', 'oschadbank']
  },
  canada: {
    name: 'Canada',
    flag: '🇨🇦',
    banks: ['td_canada', 'rbc', 'scotiabank', 'bmo', 'cibc']
  },
  international: {
    name: 'International',
    flag: '🌍',
    banks: ['revolut', 'wise', 'paypal', 'plaid']
  },
  russia: {
    name: 'Россия',
    flag: '🇷🇺',
    banks: ['tinkoff', 'sberbank', 'alfabank', 'vtb']
  },
  test: {
    name: 'Test',
    flag: '🧪',
    banks: ['test']
  }
};

// Типы авторизации
module.exports.authTypes = {
  oauth2: {
    name: 'OAuth 2.0',
    description: 'Стандартная OAuth2 авторизация через сайт банка',
    requiresClientCredentials: true
  },
  api_key: {
    name: 'API Key',
    description: 'Авторизация по API-ключу/токену',
    requiresClientCredentials: false
  },
  merchant: {
    name: 'Merchant',
    description: 'Авторизация по Merchant ID и паролю',
    requiresClientCredentials: false
  },
  link_token: {
    name: 'Link Token',
    description: 'Авторизация через Plaid Link',
    requiresClientCredentials: true
  }
};
