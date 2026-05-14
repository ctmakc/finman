const express = require('express');
const passport = require('passport');
const BankConnection = require('../models/bankConnection');
const Account = require('../models/account');
const Transaction = require('../models/transaction');
const CustomBank = require('../models/customBank');
const bankApiConfig = require('../config/bank-api-config');
const bankApiService = require('../services/bankApiService');

const router = express.Router();

// Хелпер для получения конфига банка (с учетом кастомных)
async function getBankConfig(bankId, userId) {
  // Сначала проверяем стандартные банки
  if (bankApiConfig[bankId] && bankId !== 'regions' && bankId !== 'authTypes') {
    return bankApiConfig[bankId];
  }
  // Затем проверяем кастомные банки пользователя
  if (userId && bankId.startsWith('custom_')) {
    const customBank = await CustomBank.findByKey(bankId, userId);
    if (customBank) {
      return CustomBank.toConfigFormat(customBank);
    }
  }
  return null;
}

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// Получение списка поддерживаемых банков (плоский список)
router.get('/supported-banks', authenticate, (req, res) => {
  try {
    const { region } = req.query;

    // Фильтрация по региону если указан
    const bankIds = Object.keys(bankApiConfig).filter(key =>
      key !== 'regions' && key !== 'authTypes' &&
      (!region || bankApiConfig[key]?.region === region)
    );

    const supportedBanks = bankIds.map(bankId => ({
      id: bankId,
      name: bankApiConfig[bankId].name,
      country: bankApiConfig[bankId].country,
      region: bankApiConfig[bankId].region,
      icon: bankApiConfig[bankId].icon,
      authType: bankApiConfig[bankId].authType,
      requiresRedirect: bankApiConfig[bankId].requiresRedirect,
      tokenInstructions: bankApiConfig[bankId].tokenInstructions || null
    }));

    res.json(supportedBanks);
  } catch (error) {
    console.error('Error при получении списка банков:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get bank list'
    });
  }
});

// Получение банков сгруппированных по регионам
router.get('/banks-by-region', authenticate, async (req, res) => {
  try {
    const regions = bankApiConfig.regions || {};
    const result = {};

    for (const [regionId, regionData] of Object.entries(regions)) {
      result[regionId] = {
        name: regionData.name,
        flag: regionData.flag,
        banks: regionData.banks.map(bankId => {
          const bank = bankApiConfig[bankId];
          if (!bank) return null;
          return {
            id: bankId,
            name: bank.name,
            country: bank.country,
            icon: bank.icon,
            authType: bank.authType,
            requiresRedirect: bank.requiresRedirect,
            tokenInstructions: bank.tokenInstructions || null
          };
        }).filter(Boolean)
      };
    }

    // Добавление кастомных банков пользователя
    const customBanks = await CustomBank.findByUserId(req.user.id);
    if (customBanks.length > 0) {
      result.custom = {
        name: 'My banks',
        flag: '⚙️',
        banks: customBanks.map(bank => ({
          id: bank.bankKey,
          name: bank.name,
          country: bank.country,
          icon: null,
          authType: bank.authType,
          requiresRedirect: bank.authType === 'oauth2',
          tokenInstructions: bank.tokenInstructions || null,
          isCustom: true
        }))
      };
    }

    res.json(result);
  } catch (error) {
    console.error('Error при получении банков по регионам:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get bank list'
    });
  }
});

// Получение типов авторизации
router.get('/auth-types', authenticate, (req, res) => {
  try {
    res.json(bankApiConfig.authTypes || {});
  } catch (error) {
    res.status(500).json({ error: true, message: 'Failed to get auth types' });
  }
});

// Получение всех подключений к банкам пользователя
router.get('/connections', authenticate, async (req, res) => {
  try {
    const connections = await BankConnection.findByUserId(req.user.id);
    
    // Добавить информацию о банке из конфигурации
    const connectionsWithBankInfo = connections.map(conn => {
      const bankInfo = bankApiConfig[conn.bank_id] || {};
      return {
        id: conn.id,
        bankId: conn.bank_id,
        bankName: bankInfo.name || conn.bank_id,
        bankIcon: bankInfo.icon,
        isActive: conn.is_active === 1,
        createdAt: conn.created_at,
        updatedAt: conn.updated_at,
        expiresAt: conn.expires_at,
        accountIds: conn.accountIds
      };
    });
    
    res.json(connectionsWithBankInfo);
  } catch (error) {
    console.error('Error при получении подключений к банкам:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to get bank connections' 
    });
  }
});

// Инициализация подключения к банку (шаг 1 - получение URL для авторизации)
router.post('/connect/:bankId', authenticate, async (req, res) => {
  try {
    const { bankId } = req.params;
    
    // Проверка, поддерживается ли банк
    if (!bankApiConfig[bankId]) {
      return res.status(400).json({ 
        error: true, 
        message: 'Bank not supported' 
      });
    }
    
    // Получение URL для авторизации
    const authUrlData = await bankApiService.getAuthorizationUrl(bankId, req.user.id);
    
    res.json(authUrlData);
  } catch (error) {
    console.error('Error при инициализации подключения к банку:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to initialize bank connection' 
    });
  }
});

// Завершение подключения к банку (шаг 2 - обработка callback)
router.post('/connect/:bankId/callback', authenticate, async (req, res) => {
  try {
    const { bankId } = req.params;
    const { code, state } = req.body;
    
    // Проверка, поддерживается ли банк
    if (!bankApiConfig[bankId]) {
      return res.status(400).json({ 
        error: true, 
        message: 'Bank not supported' 
      });
    }
    
    // Обработка callback и получение токенов
    const connectionData = await bankApiService.handleCallback(bankId, req.user.id, { code, state });
    
    res.json({
      success: true,
      connectionId: connectionData.id,
      bankName: bankApiConfig[bankId].name
    });
  } catch (error) {
    console.error('Error при завершении подключения к банку:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to complete bank connection'
    });
  }
});

// Прямая авторизация для банков, не требующих redirect (API-ключ)
router.post('/connect/:bankId/direct', authenticate, async (req, res) => {
  try {
    const { bankId } = req.params;
    const { apiKey } = req.body;
    
    // Проверка, поддерживается ли банк
    if (!bankApiConfig[bankId]) {
      return res.status(400).json({ 
        error: true, 
        message: 'Bank not supported' 
      });
    }
    
    // Проверка, что банк поддерживает прямую авторизацию
    if (bankApiConfig[bankId].requiresRedirect) {
      return res.status(400).json({ 
        error: true, 
        message: 'This bank does not support direct authorization'
      });
    }
    
    // Проверка, что указан API-ключ
    if (!apiKey) {
      return res.status(400).json({ 
        error: true, 
        message: 'API key required' 
      });
    }
    
    // Сохранение подключения
    const connectionData = await BankConnection.createOrUpdate({
      userId: req.user.id,
      bankId,
      accessToken: apiKey
    });
    
    res.json({
      success: true,
      connectionId: connectionData.id,
      bankName: bankApiConfig[bankId].name
    });
  } catch (error) {
    console.error('Error при прямом подключении к банку:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to connect to bank directly' 
    });
  }
});

// Отключение от банка
router.post('/disconnect/:connectionId', authenticate, async (req, res) => {
  try {
    const { connectionId } = req.params;
    
    // Получение подключения
    const connection = await BankConnection.findById(connectionId, req.user.id);
    
    if (!connection) {
      return res.status(404).json({ 
        error: true, 
        message: 'Connection not found' 
      });
    }
    
    // Отключение от банка
    await bankApiService.revokeAccess(connection.bank_id, connection);
    
    // Деактивация подключения
    await BankConnection.deactivate(connectionId, req.user.id);
    
    res.json({
      success: true,
      message: 'Connection deleted'
    });
  } catch (error) {
    console.error('Error при отключении от банка:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to disconnect from bank' 
    });
  }
});

// Синхронизация счетов с банком
router.post('/sync-accounts/:connectionId', authenticate, async (req, res) => {
  try {
    const { connectionId } = req.params;
    
    // Получение подключения
    const connection = await BankConnection.findById(connectionId, req.user.id);
    
    if (!connection) {
      return res.status(404).json({ 
        error: true, 
        message: 'Connection not found' 
      });
    }
    
    // Получение счетов из банка
    const bankAccounts = await bankApiService.getAccounts(connection.bank_id, connection);

    // Получение существующих счетов ОДИН раз перед циклом (исправление N+1)
    const existingAccounts = await Account.findByUserId(req.user.id);
    const existingAccountsMap = new Map(
      existingAccounts.map(acc => [acc.account_number, acc])
    );

    // Создание счетов в системе
    const createdAccounts = [];

    for (const bankAccount of bankAccounts) {
      // Проверка, существует ли счет с таким номером
      const existingAccount = existingAccountsMap.get(bankAccount.accountNumber);
      
      if (existingAccount) {
        // Обновить существующий счет
        await Account.update(existingAccount.id, req.user.id, {
          name: bankAccount.name,
          bankName: bankApiConfig[connection.bank_id].name,
          currency: bankAccount.currency,
          balance: bankAccount.balance,
          accountType: bankAccount.type
        });
        
        createdAccounts.push({
          ...existingAccount,
          name: bankAccount.name,
          balance: bankAccount.balance,
          updated: true
        });
      } else {
        // Создать новый счет
        const newAccount = await Account.create({
          userId: req.user.id,
          name: bankAccount.name,
          accountNumber: bankAccount.accountNumber,
          bankName: bankApiConfig[connection.bank_id].name,
          currency: bankAccount.currency,
          balance: bankAccount.balance,
          accountType: bankAccount.type
        });
        
        createdAccounts.push({...newAccount, updated: false});
      }
    }
    
    // Обновить список счетов в подключении
    const accountIds = createdAccounts.map(acc => acc.id);
    
    await BankConnection.createOrUpdate({
      ...connection,
      userId: req.user.id,
      accountIds
    });
    
    res.json({
      success: true,
      accounts: createdAccounts
    });
  } catch (error) {
    console.error('Error при синхронизации счетов:', error);
    res.status(500).json({
      error: true,
      message: 'An error occurred при синхронизации счетов'
    });
  }
});

// Синхронизация транзакций с банком
router.post('/sync-transactions/:accountId', authenticate, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { startDate, endDate } = req.body;
    
    // Получение счета
    const account = await Account.findById(accountId, req.user.id);
    
    if (!account) {
      return res.status(404).json({ 
        error: true, 
        message: 'Account not found' 
      });
    }
    
    // Найти соответствующее подключение к банку
    const connections = await BankConnection.findByUserId(req.user.id);
    const bankConnection = connections.find(conn => 
      bankApiConfig[conn.bank_id] && 
      bankApiConfig[conn.bank_id].name === account.bank_name
    );
    
    if (!bankConnection) {
      return res.status(404).json({ 
        error: true, 
        message: 'Bank connection not found' 
      });
    }
    
    // Получение транзакций из банка
    const bankTransactions = await bankApiService.getTransactions(
      bankConnection.bank_id, 
      bankConnection, 
      account.account_number,
      { startDate, endDate }
    );
    
    // Преобразование транзакций для сохранения
    const transactionsToSave = bankTransactions.map(tr => ({
      accountId,
      userId: req.user.id,
      date: tr.date,
      description: tr.description,
      category: tr.category,
      amount: tr.amount,
      type: tr.type || (tr.amount >= 0 ? 'income' : 'expense'),
      skipBalanceUpdate: true // Не обновлять баланс, т.к. он уже учтен в балансе счета
    }));
    
    // Сохранение транзакций
    const savedTransactions = await Transaction.bulkCreate(transactionsToSave);
    
    res.json({
      success: true,
      count: savedTransactions.length,
      transactions: savedTransactions
    });
  } catch (error) {
    console.error('Error при синхронизации транзакций:', error);
    res.status(500).json({
      error: true,
      message: 'An error occurred при синхронизации транзакций'
    });
  }
});

// ==================== КАСТОМНЫЕ БАНКИ ====================

// Получение всех кастомных банков пользователя
router.get('/custom-banks', authenticate, async (req, res) => {
  try {
    const customBanks = await CustomBank.findByUserId(req.user.id);
    res.json(customBanks);
  } catch (error) {
    console.error('Error при получении кастомных банков:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get custom banks'
    });
  }
});

// Создание кастомного банка
router.post('/custom-banks', authenticate, async (req, res) => {
  try {
    const { name, country, apiUrl, authType, scopes, endpoints, tokenInstructions } = req.body;

    // Валидация requiredх полей
    if (!name || !name.trim()) {
      return res.status(400).json({ error: true, message: 'Bank name required' });
    }
    if (!country || !country.trim()) {
      return res.status(400).json({ error: true, message: 'Страна обязательна' });
    }
    if (!apiUrl || !apiUrl.trim()) {
      return res.status(400).json({ error: true, message: 'URL API обязателен' });
    }

    // Валидация URL
    try {
      new URL(apiUrl);
    } catch {
      return res.status(400).json({ error: true, message: 'Invalid API URL' });
    }

    // Валидация типа авторизации
    const validAuthTypes = ['api_key', 'oauth2', 'merchant', 'bearer'];
    if (authType && !validAuthTypes.includes(authType)) {
      return res.status(400).json({ error: true, message: 'Invalid authorization type' });
    }

    const customBank = await CustomBank.create({
      userId: req.user.id,
      name: name.trim(),
      country: country.trim().toUpperCase(),
      apiUrl: apiUrl.trim(),
      authType: authType || 'api_key',
      scopes: scopes || ['accounts', 'transactions'],
      endpoints: endpoints || {},
      tokenInstructions: tokenInstructions || ''
    });

    res.status(201).json({
      success: true,
      bank: customBank
    });
  } catch (error) {
    console.error('Error при создании кастомного банка:', error);
    if (error.message.includes('уже существует')) {
      return res.status(400).json({ error: true, message: error.message });
    }
    res.status(500).json({
      error: true,
      message: 'An error occurred при создании кастомного банка'
    });
  }
});

// Обновление кастомного банка
router.put('/custom-banks/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, country, apiUrl, authType, scopes, endpoints, tokenInstructions } = req.body;

    // Проверка существования
    const existingBank = await CustomBank.findById(id, req.user.id);
    if (!existingBank) {
      return res.status(404).json({ error: true, message: 'Custom bank not found' });
    }

    // Валидация URL если передан
    if (apiUrl) {
      try {
        new URL(apiUrl);
      } catch {
        return res.status(400).json({ error: true, message: 'Invalid API URL' });
      }
    }

    const updated = await CustomBank.update(id, req.user.id, {
      name: name?.trim(),
      country: country?.trim().toUpperCase(),
      apiUrl: apiUrl?.trim(),
      authType,
      scopes,
      endpoints,
      tokenInstructions
    });

    if (updated) {
      const bank = await CustomBank.findById(id, req.user.id);
      res.json({ success: true, bank });
    } else {
      res.status(400).json({ error: true, message: 'Failed to update bank' });
    }
  } catch (error) {
    console.error('Error при обновлении кастомного банка:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to update custom bank'
    });
  }
});

// Удаление кастомного банка
router.delete('/custom-banks/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Проверка существования
    const existingBank = await CustomBank.findById(id, req.user.id);
    if (!existingBank) {
      return res.status(404).json({ error: true, message: 'Custom bank not found' });
    }

    const deleted = await CustomBank.delete(id, req.user.id);

    if (deleted) {
      res.json({ success: true, message: 'Custom bank deleted' });
    } else {
      res.status(400).json({ error: true, message: 'Failed to delete bank' });
    }
  } catch (error) {
    console.error('Error при удалении кастомного банка:', error);
    res.status(500).json({
      error: true,
      message: 'An error occurred при удалении кастомного банка'
    });
  }
});

// Прямое подключение к кастомному банку
router.post('/connect-custom/:bankKey/direct', authenticate, async (req, res) => {
  try {
    const { bankKey } = req.params;
    const { apiKey } = req.body;

    // Получение кастомного банка
    const customBank = await CustomBank.findByKey(bankKey, req.user.id);
    if (!customBank) {
      return res.status(404).json({ error: true, message: 'Custom bank not found' });
    }

    // Проверка API-ключа
    if (!apiKey) {
      return res.status(400).json({ error: true, message: 'API key required' });
    }

    // Сохранение подключения
    const connectionData = await BankConnection.createOrUpdate({
      userId: req.user.id,
      bankId: bankKey,
      accessToken: apiKey
    });

    res.json({
      success: true,
      connectionId: connectionData.id,
      bankName: customBank.name
    });
  } catch (error) {
    console.error('Error при подключении к кастомному банку:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to connect to custom bank'
    });
  }
});

module.exports = router;
