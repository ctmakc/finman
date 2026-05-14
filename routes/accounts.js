const express = require('express');
const passport = require('passport');
const Account = require('../models/account');
const Transaction = require('../models/transaction');
const { AccountPermission } = require('../models/permission');

const router = express.Router();

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// Получение всех счетов пользователя (свои + расшаренные)
router.get('/', authenticate, async (req, res) => {
  try {
    const includeShared = req.query.includeShared !== 'false';

    if (includeShared) {
      const accounts = await AccountPermission.getAccessibleAccounts(req.user.id);
      res.json(accounts);
    } else {
      const accounts = await Account.findByUserId(req.user.id);
      res.json({ own: accounts, shared: [], all: accounts });
    }
  } catch (error) {
    console.error('Failed to get accounts:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get accounts'
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
        message: 'Account name is required' 
      });
    }
    
    // Create account with zero balance; initial transaction will set it
    const newAccount = await Account.create({
      userId: req.user.id,
      name,
      accountNumber,
      bankName,
      currency,
      balance: 0,
      accountType
    });
    
    // If an opening balance was specified, create the initial transaction
    if (balance && balance !== 0) {
      await Transaction.create({
        accountId: newAccount.id,
        userId: req.user.id,
        date: new Date().toISOString().split('T')[0],
        description: 'Opening balance',
        category: 'Opening balance',
        amount: Math.abs(balance),
        type: balance > 0 ? 'income' : 'expense'
      });
    }
    
    res.status(201).json(newAccount);
  } catch (error) {
    console.error('Error при создании счета:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to create account' 
    });
  }
});

// Получение счета по ID (с проверкой прав доступа)
router.get('/:id', authenticate, async (req, res) => {
  try {
    // Сначала проверяем права
    const permissions = await AccountPermission.getPermissions(
      parseInt(req.params.id),
      req.user.id
    );

    if (!permissions || !permissions.canView) {
      return res.status(404).json({
        error: true,
        message: 'Account not found'
      });
    }

    // Если есть права, получаем счет без проверки владельца
    const { get } = require('../db/database');
    const account = await get(
      `SELECT * FROM accounts WHERE id = ? AND is_active = 1`,
      [req.params.id]
    );

    if (!account) {
      return res.status(404).json({
        error: true,
        message: 'Account not found'
      });
    }

    res.json({ ...account, permissions });
  } catch (error) {
    console.error('Error при получении счета:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get account'
    });
  }
});

// Обновление счета (с проверкой прав)
router.put('/:id', authenticate, async (req, res) => {
  try {
    // Проверяем права на редактирование
    const permissions = await AccountPermission.getPermissions(
      parseInt(req.params.id),
      req.user.id
    );

    if (!permissions || !permissions.canEdit) {
      return res.status(403).json({
        error: true,
        message: 'Insufficient permissions to edit account'
      });
    }

    const {
      name,
      accountNumber,
      bankName,
      currency,
      accountType
    } = req.body;

    // Получаем владельца счета для обновления
    const { get } = require('../db/database');
    const account = await get(`SELECT user_id FROM accounts WHERE id = ?`, [req.params.id]);

    if (!account) {
      return res.status(404).json({
        error: true,
        message: 'Account not found'
      });
    }

    // Обновление счета от имени владельца
    const success = await Account.update(req.params.id, account.user_id, {
      name,
      accountNumber,
      bankName,
      currency,
      accountType
    });

    if (success) {
      const updatedAccount = await Account.findById(req.params.id, account.user_id);
      res.json(updatedAccount);
    } else {
      res.status(404).json({
        error: true,
        message: 'Account not found or not updated'
      });
    }
  } catch (error) {
    console.error('Error при обновлении счета:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to update account'
    });
  }
});

// Удаление счета (с проверкой прав)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    // Проверяем права на удаление
    const permissions = await AccountPermission.getPermissions(
      parseInt(req.params.id),
      req.user.id
    );

    if (!permissions || !permissions.canDelete) {
      return res.status(403).json({
        error: true,
        message: 'Insufficient permissions to delete account'
      });
    }

    // Получаем владельца счета для удаления
    const { get } = require('../db/database');
    const account = await get(`SELECT user_id FROM accounts WHERE id = ?`, [req.params.id]);

    if (!account) {
      return res.status(404).json({
        error: true,
        message: 'Account not found'
      });
    }

    const success = await Account.delete(req.params.id, account.user_id);

    if (success) {
      res.json({
        success: true,
        message: 'Счет успешно удален'
      });
    } else {
      res.status(404).json({
        error: true,
        message: 'Account not found or not deleted'
      });
    }
  } catch (error) {
    console.error('Error при удалении счета:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to delete account'
    });
  }
});

// Получение транзакций по счету (с проверкой прав)
router.get('/:id/transactions', authenticate, async (req, res) => {
  try {
    // Проверяем права на просмотр
    const permissions = await AccountPermission.getPermissions(
      parseInt(req.params.id),
      req.user.id
    );

    if (!permissions || !permissions.canView) {
      return res.status(404).json({
        error: true,
        message: 'Account not found'
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

    // Получаем владельца счета
    const { get } = require('../db/database');
    const account = await get(`SELECT user_id FROM accounts WHERE id = ?`, [req.params.id]);

    // Получение транзакций
    const transactions = await Transaction.findByUserId(account.user_id, {
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
    console.error('Error при получении транзакций по счету:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get transactions по счету'
    });
  }
});

module.exports = router;