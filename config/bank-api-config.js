// Конфигурация для поддерживаемых банковских API
module.exports = {
    // Тинькофф API
    tinkoff: {
      name: 'Тинькофф',
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
      icon: 'vtb-icon.png',
      apiUrl: 'https://api.vtb.ru',
      scopes: ['accounts', 'statement'],
      authType: 'oauth2',
      requiresRedirect: true,
      clientId: process.env.VTB_CLIENT_ID || '',
      clientSecret: process.env.VTB_CLIENT_SECRET || ''
    },
    
    // Тестовый API (для разработки)
    test: {
      name: 'Тестовый банк',
      icon: 'test-bank-icon.png',
      apiUrl: 'http://localhost:3001',
      scopes: ['all'],
      authType: 'api_key',
      requiresRedirect: false,
      apiKey: 'test_api_key'
    }
  };