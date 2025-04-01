const express = require('express');
const passport = require('passport');
const BankConnection = require('../models/bankConnection');
const Account = require('../models/account');
const Transaction = require('../models/transaction');
const bankApiConfig = require('../config/bank-api-config');
const bankApiService = require('../services/bankApiService');

const router = express.Router();

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// Получение списка поддерживаемых банков
router.get('/supported-banks', authenticate, (req, res) => {
  try {
    const supportedBanks = Object.keys(bankApiConfig).map(bankId => ({
      id: bankId,
      name: bankApiConfig[bankId].name,
      icon: bankApiConfig[bankId].icon,
      authType: bankApiConfig[bankId].authType,
      requiresRedirect: bankApiConfig[bankId].requiresRedirect
    }));
    
    res.json(supportedBanks);
  } catch (error) {
    console.error('Ошибка при получении списка банков:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении списка банков' 
    });
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
    console.error('Ошибка при получении подключений к банкам:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении подключений к банкам' 
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
        message: 'Банк не поддерживается' 
      });
    }
    
    // Получение URL для авторизации
    const authUrlData = await bankApiService.getAuthorizationUrl(bankId, req.user.id);
    
    res.json(authUrlData);
  } catch (error) {
    console.error('Ошибка при инициализации подключения к банку:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при инициализации подключения к банку' 
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
        message: 'Банк не поддерживается' 
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
    console.error('Ошибка при завершении подключения к банку:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при завершении подключения к банку: ' + error.message 
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
        message: 'Банк не поддерживается' 
      });
    }
    
    // Проверка, что банк поддерживает прямую авторизацию
    if (bankApiConfig[bankId].requiresRedirect) {
      return res.status(400).json({ 
        error: true, 
        message: 'Этот банк не поддерживает прямую авторизацию' 
      });
    }
    
    // Проверка, что указан API-ключ
    if (!apiKey) {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать API-ключ' 
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
    console.error('Ошибка при прямом подключении к банку:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при прямом подключении к банку' 
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
        message: 'Подключение не найдено' 
      });
    }
    
    // Отключение от банка
    await bankApiService.revokeAccess(connection.bank_id, connection);
    
    // Деактивация подключения
    await BankConnection.deactivate(connectionId, req.user.id);
    
    res.json({
      success: true,
      message: 'Подключение успешно удалено'
    });
  } catch (error) {
    console.error('Ошибка при отключении от банка:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при отключении от банка' 
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
        message: 'Подключение не найдено' 
      });
    }
    
    // Получение счетов из банка
    const bankAccounts = await bankApiService.getAccounts(connection.bank_id, connection);
    
    // Создание счетов в системе
    const createdAccounts = [];
    
    for (const bankAccount of bankAccounts) {
      // Проверка, существует ли счет с таким номером
      const existingAccounts = await Account.findByUserId(req.user.id);
      const existingAccount = existingAccounts.find(acc => 
        acc.account_number === bankAccount.accountNumber
      );
      
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
    console.error('Ошибка при синхронизации счетов:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при синхронизации счетов: ' + error.message 
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
        message: 'Счет не найден' 
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
        message: 'Подключение к банку не найдено' 
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
    console.error('Ошибка при синхронизации транзакций:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при синхронизации транзакций: ' + error.message 
    });
  }
});

module.exports = router;
