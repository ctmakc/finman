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
    cb(new Error('Только CSV файлы разрешены'), false);
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

// Получение всех транзакций пользователя (с фильтрацией и пагинацией)
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
    console.error('Error при получении транзакций:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении транзакций' 
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

    // Проверка обязательных полей
    if (!accountId || !date || amount === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Необходимо указать счет, дату и сумму'
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
        message: 'Счет не найден'
      });
    }

    if (!permissions.isOwner && !permissions.canAddTransactions) {
      return res.status(403).json({
        error: true,
        message: 'Недостаточно прав для добавления транзакций'
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
               AND (b.category_id IS NULL OR t.category_id = b.category_id)
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
    console.error('Error при создании транзакции:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при создании транзакции'
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
        message: 'Транзакция не найдена' 
      });
    }
    
    res.json(transaction);
  } catch (error) {
    console.error('Error при получении транзакции:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении транзакции' 
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
        message: 'Транзакция не найдена или не обновлена' 
      });
    }
  } catch (error) {
    console.error('Error при обновлении транзакции:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при обновлении транзакции' 
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
        message: 'Транзакция успешно удалена' 
      });
    } else {
      res.status(404).json({ 
        error: true, 
        message: 'Транзакция не найдена или не удалена' 
      });
    }
  } catch (error) {
    console.error('Error при удалении транзакции:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при удалении транзакции' 
    });
  }
});

// Импорт транзакций из CSV
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: true, 
        message: 'Файл не загружен' 
      });
    }
    
    const accountId = req.body.accountId;
    const bankType = req.body.bankType || 'generic';
    
    // Проверка, существует ли счет
    const account = await Account.findById(accountId, req.user.id);
    
    if (!account) {
      return res.status(404).json({ 
        error: true, 
        message: 'Счет не найден' 
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
    console.error('Error при импорте транзакций:', error);
    
    // Удаление временного файла в случае ошибки
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при импорте транзакций'
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
    console.error('Error при получении статистики:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении статистики' 
    });
  }
});

module.exports = router;
