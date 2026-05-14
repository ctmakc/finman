const express = require('express');
const passport = require('passport');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Transaction = require('../models/transaction');
const Account = require('../models/account');
const csvImportService = require('../services/csvImportService');
const { AccountPermission } = require('../models/permission');

const router = express.Router();

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// Настройка загрузки файлов с валидацией
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)){
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Безопасное имя файла - только timestamp и расширение
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`);
  }
});

// Фильтр файлов - только CSV
const fileFilter = (req, file, cb) => {
  const allowedMimes = ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'];
  const allowedExts = ['.csv', '.txt'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV files are allowed'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // Максимум 5MB
    files: 1 // Только 1 файл за раз
  }
});

// Get distinct categories used in the user's transactions
router.get('/categories', authenticate, async (req, res) => {
  try {
    const { query: dbQuery } = require('../db/database');
    const rows = await dbQuery(
      `SELECT DISTINCT category FROM transactions WHERE user_id = ? AND category IS NOT NULL AND category != '' ORDER BY category`,
      [req.user.id]
    );
    res.json(rows.map(r => r.category));
  } catch (error) {
    console.error('Error fetching transaction categories:', error);
    res.status(500).json({ error: true, message: 'Failed to get categories' });
  }
});

// Get all transactions for user (with filtering and pagination)
router.get('/', authenticate, async (req, res) => {
  try {
    // Получение параметров запроса
    const { 
      accountId,
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
    
    // Ограничение лимита пагинации
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
    const parsedPage = Math.max(parseInt(page) || 1, 1);

    // Получение транзакций
    const transactions = await Transaction.findByUserId(req.user.id, {
      accountId,
      startDate,
      endDate,
      category,
      type,
      minAmount,
      maxAmount,
      search,
      page: parsedPage,
      limit: parsedLimit,
      sortBy,
      sortOrder
    });
    
    res.json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to get transactions' 
    });
  }
});

// Создание новой транзакции (с проверкой прав для расшаренных счетов)
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      accountId,
      date,
      description,
      category,
      amount,
      type
    } = req.body;

    // Проверка requiredх полей
    if (!accountId || !date || amount === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Account, date and amount are required'
      });
    }

    // Проверяем права на добавление транзакций
    const permissions = await AccountPermission.getPermissions(
      parseInt(accountId),
      req.user.id
    );

    if (!permissions) {
      return res.status(404).json({
        error: true,
        message: 'Account not found'
      });
    }

    if (!permissions.isOwner && !permissions.canAddTransactions) {
      return res.status(403).json({
        error: true,
        message: 'Insufficient permissions to add transactions'
      });
    }

    // Получаем владельца счета
    const { get } = require('../db/database');
    const account = await get(`SELECT user_id FROM accounts WHERE id = ?`, [accountId]);

    const txType = type || (amount >= 0 ? 'income' : 'expense');

    // Создание транзакции (от имени владельца счета)
    const newTransaction = await Transaction.create({
      accountId, userId: account.user_id, date, description, category,
      amount, type: txType,
    });

    // Budget threshold notifications (fire-and-forget, non-blocking)
    if (txType === 'expense') {
      const { query: dbQuery, run: dbRun } = require('../db/database');
      setImmediate(async () => {
        try {
          const now = new Date();
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
          const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
          const budgets = await dbQuery(
            `SELECT b.id, b.name, b.amount as budget_amount,
                    COALESCE(SUM(ABS(t.amount)), 0) as spent
             FROM budgets b
             LEFT JOIN transactions t ON t.user_id = b.user_id
               AND t.type = 'expense' AND t.date BETWEEN ? AND ?
               AND (b.category IS NULL OR t.category = b.category)
             WHERE b.user_id = ? AND b.is_active = 1
             GROUP BY b.id`,
            [monthStart, monthEnd, account.user_id]
          );
          for (const bud of budgets) {
            const pct = bud.budget_amount > 0 ? (bud.spent / bud.budget_amount) * 100 : 0;
            if (pct >= 80) {
              const severity = pct >= 100 ? 'over' : 'warn';
              const msg = pct >= 100
                ? `Budget "${bud.name}" exceeded (${Math.round(pct)}%)`
                : `Budget "${bud.name}" at ${Math.round(pct)}% of limit`;
              const existing = await dbQuery(
                `SELECT id FROM notifications WHERE user_id=? AND type='budget_alert'
                 AND message LIKE ? AND created_at > datetime('now','-1 day')`,
                [account.user_id, `%${bud.name}%`]
              );
              if (!existing.length) {
                await dbRun(
                  `INSERT INTO notifications (user_id, type, title, message, is_read, created_at)
                   VALUES (?, 'budget_alert', ?, ?, 0, datetime('now'))`,
                  [account.user_id, severity === 'over' ? 'Budget exceeded' : 'Budget warning', msg]
                );
              }
            }
          }
        } catch (_) {}
      });
    }

    res.status(201).json(newTransaction);
  } catch (error) {
    console.error('Error creating transaction:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to create transaction'
    });
  }
});

// Получение транзакции по ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id, req.user.id);
    
    if (!transaction) {
      return res.status(404).json({ 
        error: true, 
        message: 'Transaction not found' 
      });
    }
    
    res.json(transaction);
  } catch (error) {
    console.error('Error fetching transaction:', error);
    res.status(500).json({ 
      error: true, 
      message: 'An error occurred fetching transaction' 
    });
  }
});

// Обновление транзакции
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { 
      date, 
      description, 
      category, 
      amount, 
      type 
    } = req.body;
    
    // Обновление транзакции
    const success = await Transaction.update(req.params.id, req.user.id, {
      date,
      description,
      category,
      amount,
      type
    });
    
    if (success) {
      const updatedTransaction = await Transaction.findById(req.params.id, req.user.id);
      res.json(updatedTransaction);
    } else {
      res.status(404).json({ 
        error: true, 
        message: 'Transaction not found or not updated' 
      });
    }
  } catch (error) {
    console.error('Error updating transaction:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to update transaction' 
    });
  }
});

// Удаление транзакции
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const success = await Transaction.delete(req.params.id, req.user.id);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Transaction deleted successfully' 
      });
    } else {
      res.status(404).json({ 
        error: true, 
        message: 'Transaction not found or not deleted' 
      });
    }
  } catch (error) {
    console.error('Error deleting transaction:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to delete transaction' 
    });
  }
});

// Импорт транзакций из CSV
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: true, 
        message: 'File not uploaded' 
      });
    }
    
    const accountId = req.body.accountId;
    const bankType = req.body.bankType || 'generic';
    
    // Проверка, существует ли счет
    const account = await Account.findById(accountId, req.user.id);
    
    if (!account) {
      return res.status(404).json({ 
        error: true, 
        message: 'Account not found' 
      });
    }
    
    // Обработка CSV-файла
    const transactions = await csvImportService.processCSVFile(
      req.file.path,
      {
        accountId,
        userId: req.user.id,
        bankType
      }
    );
    
    // Сохранение транзакций
    const savedTransactions = await Transaction.bulkCreate(transactions);
    
    // Удаление временного файла
    fs.unlink(req.file.path, () => {});
    
    res.json({ 
      success: true, 
      count: savedTransactions.length,
      transactions: savedTransactions
    });
  } catch (error) {
    console.error('Error importing transactions:', error);
    
    // Удаление временного файла в случае ошибки
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    
    res.status(500).json({
      error: true,
      message: 'Failed to import transactions'
    });
  }
});

// Получение статистики по транзакциям
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    // Получение параметров запроса
    const { 
      accountId,
      startDate, 
      endDate, 
      groupBy
    } = req.query;
    
    // Получение статистики
    const stats = await Transaction.getStats(req.user.id, {
      accountId,
      startDate,
      endDate,
      groupBy
    });
    
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to get stats' 
    });
  }
});

// Transfer between accounts
router.post('/transfer', authenticate, async (req, res) => {
  const { query: dbQuery, get: dbGet, run: dbRun } = require('../db/database');
  try {
    const { fromAccountId, toAccountId, amount, date, description } = req.body;

    if (!fromAccountId || !toAccountId || !amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: true, message: 'fromAccountId, toAccountId, and positive amount are required' });
    }
    if (fromAccountId == toAccountId) {
      return res.status(400).json({ error: true, message: 'Source and destination accounts must differ' });
    }

    const [from, to] = await Promise.all([
      dbGet('SELECT id, user_id, balance FROM accounts WHERE id = ? AND user_id = ?', [fromAccountId, req.user.id]),
      dbGet('SELECT id, user_id, balance FROM accounts WHERE id = ? AND user_id = ?', [toAccountId, req.user.id]),
    ]);

    if (!from) return res.status(404).json({ error: true, message: 'Source account not found' });
    if (!to) return res.status(404).json({ error: true, message: 'Destination account not found' });

    const amt = parseFloat(amount);
    const txDate = date || new Date().toISOString().split('T')[0];
    const note = description || 'Transfer';

    await dbRun('BEGIN TRANSACTION');
    try {
      const [r1, r2] = await Promise.all([
        dbRun(
          `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type) VALUES (?, ?, ?, ?, 'Transfer', ?, 'transfer')`,
          [fromAccountId, req.user.id, txDate, note + ' (out)', -amt]
        ),
        dbRun(
          `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type) VALUES (?, ?, ?, ?, 'Transfer', ?, 'transfer')`,
          [toAccountId, req.user.id, txDate, note + ' (in)', amt]
        ),
      ]);
      await Promise.all([
        dbRun('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?', [amt, fromAccountId, req.user.id]),
        dbRun('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?', [amt, toAccountId, req.user.id]),
      ]);
      await dbRun('COMMIT');
      res.status(201).json({ message: 'Transfer completed', fromTxId: r1.id, toTxId: r2.id });
    } catch (e) {
      await dbRun('ROLLBACK');
      throw e;
    }
  } catch (error) {
    console.error('Transfer error:', error);
    res.status(500).json({ error: true, message: 'Transfer failed' });
  }
});

module.exports = router;
