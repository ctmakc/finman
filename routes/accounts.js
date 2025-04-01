const express = require('express');
const passport = require('passport');
const Account = require('../models/account');
const Transaction = require('../models/transaction');

const router = express.Router();

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// Получение всех счетов пользователя
router.get('/', authenticate, async (req, res) => {
  try {
    const accounts = await Account.findByUserId(req.user.id);
    res.json(accounts);
  } catch (error) {
    console.error('Ошибка при получении счетов:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении счетов' 
    });
  }
});

// Создание нового счета
router.post('/', authenticate, async (req, res) => {
  try {
    const { 
      name, 
      accountNumber, 
      bankName, 
      currency, 
      balance,
      accountType
    } = req.body;
    
    // Проверка обязательных полей
    if (!name) {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать название счета' 
      });
    }
    
    // Создание счета
    const newAccount = await Account.create({
      userId: req.user.id,
      name,
      accountNumber,
      bankName,
      currency,
      balance: balance || 0,
      accountType
    });
    
    // Если указан начальный баланс, создать стартовую транзакцию
    if (balance && balance !== 0) {
      await Transaction.create({
        accountId: newAccount.id,
        userId: req.user.id,
        date: new Date().toISOString().split('T')[0],
        description: 'Начальный баланс',
        category: 'Начальный баланс',
        amount: balance,
        type: balance > 0 ? 'income' : 'expense'
      });
    }
    
    res.status(201).json(newAccount);
  } catch (error) {
    console.error('Ошибка при создании счета:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при создании счета' 
    });
  }
});

// Получение счета по ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const account = await Account.findById(req.params.id, req.user.id);
    
    if (!account) {
      return res.status(404).json({ 
        error: true, 
        message: 'Счет не найден' 
      });
    }
    
    res.json(account);
  } catch (error) {
    console.error('Ошибка при получении счета:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении счета' 
    });
  }
});

// Обновление счета
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { 
      name, 
      accountNumber, 
      bankName, 
      currency,
      accountType
    } = req.body;
    
    // Обновление счета
    const success = await Account.update(req.params.id, req.user.id, {
      name,
      accountNumber,
      bankName,
      currency,
      accountType
    });
    
    if (success) {
      const updatedAccount = await Account.findById(req.params.id, req.user.id);
      res.json(updatedAccount);
    } else {
      res.status(404).json({ 
        error: true, 
        message: 'Счет не найден или не обновлен' 
      });
    }
  } catch (error) {
    console.error('Ошибка при обновлении счета:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при обновлении счета' 
    });
  }
});

// Удаление счета
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const success = await Account.delete(req.params.id, req.user.id);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Счет успешно удален' 
      });
    } else {
      res.status(404).json({ 
        error: true, 
        message: 'Счет не найден или не удален' 
      });
    }
  } catch (error) {
    console.error('Ошибка при удалении счета:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при удалении счета' 
    });
  }
});

// Получение транзакций по счету
router.get('/:id/transactions', authenticate, async (req, res) => {
  try {
    // Проверка, существует ли счет
    const account = await Account.findById(req.params.id, req.user.id);
    
    if (!account) {
      return res.status(404).json({ 
        error: true, 
        message: 'Счет не найден' 
      });
    }
    
    // Получение параметров запроса
    const { 
      startDate, 
      endDate, 
      category, 
      type, 
      minAmount, 
      maxAmount,
      search,
      page,
      limit,
      sortBy,
      sortOrder
    } = req.query;
    
    // Получение транзакций
    const transactions = await Transaction.findByUserId(req.user.id, {
      accountId: req.params.id,
      startDate,
      endDate,
      category,
      type,
      minAmount,
      maxAmount,
      search,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 100,
      sortBy,
      sortOrder
    });
    
    res.json(transactions);
  } catch (error) {
    console.error('Ошибка при получении транзакций по счету:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении транзакций по счету' 
    });
  }
});

module.exports = router;