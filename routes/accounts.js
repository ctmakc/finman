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
        message: 'Счет не найден'
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
        message: 'Счет не найден'
      });
    }

    res.json({ ...account, permissions });
  } catch (error) {
    console.error('Ошибка при получении счета:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при получении счета'
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
        message: 'Недостаточно прав для редактирования счета'
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
        message: 'Счет не найден'
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
        message: 'Недостаточно прав для удаления счета'
      });
    }

    // Получаем владельца счета для удаления
    const { get } = require('../db/database');
    const account = await get(`SELECT user_id FROM accounts WHERE id = ?`, [req.params.id]);

    if (!account) {
      return res.status(404).json({
        error: true,
        message: 'Счет не найден'
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
    console.error('Ошибка при получении транзакций по счету:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при получении транзакций по счету'
    });
  }
});

module.exports = router;