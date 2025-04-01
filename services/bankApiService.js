const axios = require('axios');
const crypto = require('crypto');
const BankConnection = require('../models/bankConnection');
const bankApiConfig = require('../config/bank-api-config');

// Тестовые данные для разработки
const testData = {
  accounts: [
    {
      id: 'test-account-1',
      name: 'Тестовый счет 1',
      accountNumber: '40817810099910004312',
      type: 'checking',
      balance: 75000,
      currency: 'RUB'
    },
    {
      id: 'test-account-2',
      name: 'Тестовый счет 2',
      accountNumber: '40817810099910004313',
      type: 'savings',
      balance: 120000,
      currency: 'RUB'
    },
    {
      id: 'test-account-3',
      name: 'Тестовый счет 3 (Доллары)',
      accountNumber: '40817840099910004314',
      type: 'checking',
      balance: 1500,
      currency: 'USD'
    }
  ],
  transactions: [
    {
      id: 'tx-1',
      date: '2023-06-01',
      description: 'Зарплата',
      category: 'Зарплата',
      amount: 120000,
      type: 'income'
    },
    {
      id: 'tx-2',
      date: '2023-06-05',
      description: 'Супермаркет Перекресток',
      category: 'Продукты',
      amount: -5430.50,
      type: 'expense'
    },
    {
      id: 'tx-3',
      date: '2023-06-07',
      description: 'Кафе "Вкусно и точка"',
      category: 'Рестораны',
      amount: -1200,
      type: 'expense'
    },
    {
      id: 'tx-4',
      date: '2023-06-10',
      description: 'АЗС Газпром',
      category: 'Транспорт',
      amount: -2500,
      type: 'expense'
    },
    {
      id: 'tx-5',
      date: '2023-06-15',
      description: 'Снятие наличных',
      category: 'Переводы',
      amount: -15000,
      type: 'expense'
    },
    {
      id: 'tx-6',
      date: '2023-06-20',
      description: 'Возврат Ozon',
      category: 'Возврат средств',
      amount: 2350,
      type: 'income'
    },
    {
      id: 'tx-7',
      date: '2023-06-25',
      description: 'Аренда квартиры',
      category: 'Жилье',
      amount: -30000,
      type: 'expense'
    }
  ]
};

// Сервис для работы с API банков
class BankApiService {
  // Получение URL для авторизации
  async getAuthorizationUrl(bankId, userId) {
    // Проверить конфигурацию банка
    const bankConfig = bankApiConfig[bankId];
    if (!bankConfig) {
      throw new Error(`Банк ${bankId} не поддерживается`);
    }
    
    // Генерация state для безопасности
    const state = crypto.randomBytes(16).toString('hex');
    
    // Для тестового банка
    if (bankId === 'test') {
      return {
        url: null,
        state,
        directAuth: true
      };
    }
    
    // Для OAuth2-авторизации
    if (bankConfig.authType === 'oauth2') {
      // Построение URL для авторизации
      const authUrl = new URL(`${bankConfig.apiUrl}/oauth2/authorize`);
      authUrl.searchParams.append('client_id', bankConfig.clientId);
      authUrl.searchParams.append('response_type', 'code');
      authUrl.searchParams.append('redirect_uri', `${process.env.APP_URL || 'http://localhost:3000'}/auth/callback`);
      authUrl.searchParams.append('state', state);
      authUrl.searchParams.append('scope', bankConfig.scopes.join(' '));
      
      return {
        url: authUrl.toString(),
        state,
        directAuth: false
      };
    }
    
    // API-ключ авторизация
    if (bankConfig.authType === 'api_key') {
      return {
        url: null,
        state,
        directAuth: true
      };
    }
    
    throw new Error(`Тип авторизации ${bankConfig.authType} не поддерживается`);
  }
  
  // Обработка callback и получение токенов
  async handleCallback(bankId, userId, callbackData) {
    const { code, state } = callbackData;
    
    // Проверить конфигурацию банка
    const bankConfig = bankApiConfig[bankId];
    if (!bankConfig) {
      throw new Error(`Банк ${bankId} не поддерживается`);
    }
    
    // Для тестового банка
    if (bankId === 'test') {
      // Просто создаем запись о подключении
      return await BankConnection.createOrUpdate({
        userId,
        bankId,
        accessToken: 'test_access_token',
        refreshToken: 'test_refresh_token',
        expiresAt: new Date(Date.now() + 3600 * 1000) // 1 час
      });
    }
    
    // Для OAuth2-авторизации
    if (bankConfig.authType === 'oauth2') {
      try {
        // Запрос на получение токенов
        const tokenResponse = await axios.post(`${bankConfig.apiUrl}/oauth2/token`, {
          grant_type: 'authorization_code',
          code,
          client_id: bankConfig.clientId,
          client_secret: bankConfig.clientSecret,
          redirect_uri: `${process.env.APP_URL || 'http://localhost:3000'}/auth/callback`
        });
        
        // Сохранение токенов
        const { access_token, refresh_token, expires_in } = tokenResponse.data;
        const expiresAt = new Date(Date.now() + expires_in * 1000);
        
        return await BankConnection.createOrUpdate({
          userId,
          bankId,
          accessToken: access_token,
          refreshToken: refresh_token,
          expiresAt
        });
      } catch (error) {
        console.error('Ошибка при получении токенов:', error.response?.data || error.message);
        throw new Error('Не удалось получить токены доступа');
      }
    }
    
    throw new Error(`Тип авторизации ${bankConfig.authType} не поддерживается`);
  }
  
  // Обновление токенов (при истечении срока)
  async refreshTokens(bankId, connection) {
    // Проверить конфигурацию банка
    const bankConfig = bankApiConfig[bankId];
    if (!bankConfig) {
      throw new Error(`Банк ${bankId} не поддерживается`);
    }
    
    // Для тестового банка
    if (bankId === 'test') {
      // Просто обновляем срок действия
      return {
        accessToken: connection.access_token,
        refreshToken: connection.refresh_token,
        expiresAt: new Date(Date.now() + 3600 * 1000) // 1 час
      };
    }
    
    // Для OAuth2-авторизации
    if (bankConfig.authType === 'oauth2') {
      try {
        // Проверка наличия refresh_token
        if (!connection.refresh_token) {
          throw new Error('Отсутствует refresh_token для обновления');
        }
        
        // Запрос на обновление токенов
        const tokenResponse = await axios.post(`${bankConfig.apiUrl}/oauth2/token`, {
          grant_type: 'refresh_token',
          refresh_token: connection.refresh_token,
          client_id: bankConfig.clientId,
          client_secret: bankConfig.clientSecret
        });
        
        // Сохранение новых токенов
        const { access_token, refresh_token, expires_in } = tokenResponse.data;
        const expiresAt = new Date(Date.now() + expires_in * 1000);
        
        return {
          accessToken: access_token,
          refreshToken: refresh_token || connection.refresh_token,
          expiresAt
        };
      } catch (error) {
        console.error('Ошибка при обновлении токенов:', error.response?.data || error.message);
        throw new Error('Не удалось обновить токены доступа');
      }
    }
    
    throw new Error(`Тип авторизации ${bankConfig.authType} не поддерживается`);
  }
  
  // Отзыв токенов (при отключении)
  async revokeAccess(bankId, connection) {
    // Проверить конфигурацию банка
    const bankConfig = bankApiConfig[bankId];
    if (!bankConfig) {
      throw new Error(`Банк ${bankId} не поддерживается`);
    }
    
    // Для тестового банка
    if (bankId === 'test') {
      // Ничего не делаем
      return true;
    }
    
    // Для OAuth2-авторизации
    if (bankConfig.authType === 'oauth2') {
      try {
        // Запрос на отзыв токена
        await axios.post(`${bankConfig.apiUrl}/oauth2/revoke`, {
          token: connection.access_token,
          client_id: bankConfig.clientId,
          client_secret: bankConfig.clientSecret
        });
        
        return true;
      } catch (error) {
        console.error('Ошибка при отзыве токена:', error.response?.data || error.message);
        // Не выбрасываем ошибку, чтобы деактивация прошла в любом случае
        return true;
      }
    }
    
    // API-ключ авторизация
    if (bankConfig.authType === 'api_key') {
      // Обычно API-ключи нельзя отозвать через API
      return true;
    }
    
    return true;
  }
  
  // Проверка и обновление токенов при необходимости
  async ensureValidTokens(bankId, connection) {
    // Проверить срок действия токена
    if (connection.expires_at && new Date(connection.expires_at) > new Date()) {
      return connection;
    }
    
    // Для тестового банка и API-ключей
    if (bankId === 'test' || bankApiConfig[bankId].authType === 'api_key') {
      return connection;
    }
    
    // Обновить токены
    const newTokens = await this.refreshTokens(bankId, connection);
    
    // Сохранить новые токены
    await BankConnection.updateTokens(connection.id, connection.user_id, newTokens);
    
    return {
      ...connection,
      access_token: newTokens.accessToken,
      refresh_token: newTokens.refreshToken,
      expires_at: newTokens.expiresAt
    };
  }
  
  // Получение счетов из банка
  async getAccounts(bankId, connection) {
    // Проверить конфигурацию банка
    const bankConfig = bankApiConfig[bankId];
    if (!bankConfig) {
      throw new Error(`Банк ${bankId} не поддерживается`);
    }
    
    // Обновить токены при необходимости
    const updatedConnection = await this.ensureValidTokens(bankId, connection);
    
    // Для тестового банка
    if (bankId === 'test') {
      return testData.accounts;
    }
    
    // Для реальных банков
    try {
      // Формирование заголовков авторизации
      const headers = {
        Authorization: `Bearer ${updatedConnection.access_token}`
      };
      
      // Запрос на получение списка счетов
      const response = await axios.get(`${bankConfig.apiUrl}/accounts`, { headers });
      
      // Обработка ответа в зависимости от банка
      let accounts = [];
      
      if (bankId === 'tinkoff') {
        accounts = response.data.accounts.map(acc => ({
          id: acc.id,
          name: acc.name,
          accountNumber: acc.accountNumber,
          type: mapAccountType(acc.type),
          balance: acc.balance.amount,
          currency: acc.balance.currency
        }));
      } else if (bankId === 'sberbank') {
        accounts = response.data.map(acc => ({
          id: acc.id,
          name: acc.name,
          accountNumber: acc.account,
          type: mapAccountType(acc.type),
          balance: acc.balance,
          currency: acc.currency
        }));
      } else if (bankId === 'alfabank') {
        accounts = response.data.accounts.map(acc => ({
          id: acc.id,
          name: acc.name || `Счет ${acc.number}`,
          accountNumber: acc.number,
          type: mapAccountType(acc.type),
          balance: acc.amount.value,
          currency: acc.amount.currency
        }));
      } else if (bankId === 'vtb') {
        accounts = response.data.map(acc => ({
          id: acc.id,
          name: acc.name,
          accountNumber: acc.number,
          type: mapAccountType(acc.type),
          balance: acc.balance,
          currency: acc.currency
        }));
      } else {
        // Общий случай
        accounts = response.data.map(acc => ({
          id: acc.id || acc.accountId,
          name: acc.name || `Счет ${acc.number || acc.accountNumber}`,
          accountNumber: acc.number || acc.accountNumber,
          type: mapAccountType(acc.type),
          balance: parseFloat(acc.balance || acc.amount),
          currency: acc.currency
        }));
      }
      
      return accounts;
    } catch (error) {
      console.error('Ошибка при получении счетов:', error.response?.data || error.message);
      throw new Error(`Не удалось получить список счетов: ${error.message}`);
    }
  }
  
  // Получение транзакций по счету
  async getTransactions(bankId, connection, accountNumber, options = {}) {
    const { startDate, endDate } = options;
    
    // Проверить конфигурацию банка
    const bankConfig = bankApiConfig[bankId];
    if (!bankConfig) {
      throw new Error(`Банк ${bankId} не поддерживается`);
    }
    
    // Обновить токены при необходимости
    const updatedConnection = await this.ensureValidTokens(bankId, connection);
    
    // Для тестового банка
    if (bankId === 'test') {
      return testData.transactions;
    }
    
    // Для реальных банков
    try {
      // Формирование заголовков авторизации
      const headers = {
        Authorization: `Bearer ${updatedConnection.access_token}`
      };
      
      // Формирование параметров запроса
      const params = {};
      
      if (startDate) {
        params.from = startDate;
      }
      
      if (endDate) {
        params.to = endDate;
      }
      
      // Запрос на получение транзакций
      let apiUrl = '';
      if (bankId === 'tinkoff') {
        apiUrl = `${bankConfig.apiUrl}/operations?accountNumber=${accountNumber}`;
      } else if (bankId === 'sberbank') {
        const accounts = await this.getAccounts(bankId, connection);
        const account = accounts.find(acc => acc.accountNumber === accountNumber);
        apiUrl = `${bankConfig.apiUrl}/operations?account=${account.id}`;
      } else if (bankId === 'alfabank') {
        apiUrl = `${bankConfig.apiUrl}/accounts/${accountNumber}/statement`;
      } else if (bankId === 'vtb') {
        apiUrl = `${bankConfig.apiUrl}/accounts/${accountNumber}/transactions`;
      } else {
        apiUrl = `${bankConfig.apiUrl}/accounts/${accountNumber}/transactions`;
      }
      
      const response = await axios.get(apiUrl, { headers, params });
      
      // Обработка ответа в зависимости от банка
      let transactions = [];
      
      if (bankId === 'tinkoff') {
        transactions = response.data.operations.map(op => ({
          id: op.id,
          date: formatDate(op.date),
          description: op.description,
          category: op.category.name,
          amount: op.amount.value,
          type: op.operationType === 'Credit' ? 'income' : 'expense'
        }));
      } else if (bankId === 'sberbank') {
        transactions = response.data.map(op => ({
          id: op.id,
          date: formatDate(op.date),
          description: op.description,
          category: op.category || categorizeTransaction(op.description),
          amount: op.amount,
          type: op.amount >= 0 ? 'income' : 'expense'
        }));
      } else if (bankId === 'alfabank') {
        transactions = response.data.operations.map(op => ({
          id: op.id,
          date: formatDate(op.date),
          description: op.description,
          category: op.category || categorizeTransaction(op.description),
          amount: op.amount.value,
          type: op.type === 'debit' ? 'expense' : 'income'
        }));
      } else if (bankId === 'vtb') {
        transactions = response.data.map(op => ({
          id: op.id,
          date: formatDate(op.date),
          description: op.description,
          category: op.category || categorizeTransaction(op.description),
          amount: op.amount,
          type: op.amount >= 0 ? 'income' : 'expense'
        }));
      } else {
        // Общий случай
        transactions = response.data.map(op => ({
          id: op.id || op.transactionId,
          date: formatDate(op.date || op.transactionDate),
          description: op.description || op.narrative || op.merchant?.name || 'Транзакция',
          category: op.category || categorizeTransaction(op.description || ''),
          amount: parseFloat(op.amount || op.transactionAmount?.amount),
          type: (op.type === 'credit' || op.amount > 0) ? 'income' : 'expense'
        }));
      }
      
      return transactions;
    } catch (error) {
      console.error('Ошибка при получении транзакций:', error.response?.data || error.message);
      throw new Error(`Не удалось получить список транзакций: ${error.message}`);
    }
  }
}

// Вспомогательные функции

// Форматирование даты
function formatDate(dateStr) {
  try {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  } catch (e) {
    return dateStr;
  }
}

// Маппинг типов счетов
function mapAccountType(type) {
  const typeMap = {
    'current': 'checking',
    'card': 'checking',
    'credit': 'credit',
    'deposit': 'savings',
    'saving': 'savings',
    'loan': 'loan',
    // Другие маппинги...
  };
  
  return typeMap[type.toLowerCase()] || 'checking';
}

// Категоризация транзакций
function categorizeTransaction(description) {
  if (!description) return 'Другое';
  
  description = description.toLowerCase();
  
  // Расходы
  if (description.includes('кафе') || description.includes('ресторан') || 
      description.includes('кофе') || description.includes('пицца') ||
      description.includes('бургер') || description.includes('еда')) {
    return 'Рестораны';
  }
  
  if (description.includes('супермаркет') || description.includes('продукты') || 
      description.includes('магазин') || description.includes('market') || 
      description.includes('пятерочка') || description.includes('перекресток') || 
      description.includes('магнит') || description.includes('ашан') || 
      description.includes('лента')) {
    return 'Продукты';
  }
  
  if (description.includes('такси') || description.includes('uber') || 
      description.includes('метро') || description.includes('автобус') || 
      description.includes('транспорт')) {
    return 'Транспорт';
  }
  
  if (description.includes('аптека') || description.includes('clinic') || 
      description.includes('больниц') || description.includes('врач') || 
      description.includes('доктор')) {
    return 'Здоровье';
  }
  
  if (description.includes('одежда') || description.includes('обувь') || 
      description.includes('zara') || description.includes('h&m')) {
    return 'Одежда';
  }
  
  if (description.includes('кино') || description.includes('театр') || 
      description.includes('концерт') || description.includes('развлечения')) {
    return 'Развлечения';
  }
  
  if (description.includes('комиссия') || description.includes('плата за обслуживание')) {
    return 'Банковские услуги';
  }
  
  if (description.includes('подписка') || description.includes('subscription')) {
    return 'Подписки';
  }
  
  // Доходы
  if (description.includes('зарплата') || description.includes('аванс') || 
      description.includes('salary')) {
    return 'Зарплата';
  }
  
  if (description.includes('дивиденд') || description.includes('процент') || 
      description.includes('вклад')) {
    return 'Инвестиции';
  }
  
  if (description.includes('возврат') || description.includes('refund')) {
    return 'Возврат средств';
  }
  
  if (description.includes('перевод') || description.includes('transfer')) {
    return 'Переводы';
  }
  
  // По умолчанию
  return description.includes('перевод') ? 'Переводы' : 
         (description.includes('зачисление') ? 'Прочие доходы' : 'Прочие расходы');
}

module.exports = new BankApiService();