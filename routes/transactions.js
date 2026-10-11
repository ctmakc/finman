const express = require('express');
const passport = require('passport');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Transaction = require('../models/transaction');
const Account = require('../models/account');
const csvImportService = require('../services/csvImportService');
const currencyService = require('../services/currencyService');
const dates = require('../lib/dates');
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
    console.error('Error fetching transactions:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to fetch transactions' 
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
        message: 'Account, date and amount are required'
      });
    }
    // Тип — только доход/расход: 'opening'/'transfer' пишут свои пути, а
    // произвольный тип двигал баланс и прятал строку из статистики.
    if (type !== undefined && type !== null && type !== '' && !['income', 'expense'].includes(type)) {
      return res.status(400).json({ error: true, message: 'Transaction type must be income or expense' });
    }
    if (amount === null || amount === '' || !Number.isFinite(Number(amount))) {
      return res.status(400).json({ error: true, message: 'Amount must be a number' });
    }
    if (!dates.isValidYMD(String(date).slice(0, 10))) {
      return res.status(400).json({ error: true, message: 'Date must be YYYY-MM-DD' });
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
    if (!account) {
      return res.status(404).json({
        error: true,
        message: 'Account not found'
      });
    }

    // Семантика расшаренных счетов: транзакция принадлежит ЛЕДЖЕРУ ВЛАДЕЛЬЦА
    // счёта (user_id = владелец), поэтому баланс и аналитика владельца сходятся,
    // а контрибьютор видит её через GET /api/accounts/:id/transactions.
    // Знак суммы нормализует модель (expense < 0, income > 0).
    // Идемпотентность: офлайн-очередь повторяет POST с тем же clientTxId /
    // Idempotency-Key — повтор после потерянного ответа отдаёт ту же строку.
    const rawKey = req.body.clientTxId || req.get('Idempotency-Key') || '';
    const clientTxId = String(rawKey).trim().slice(0, 100) || null;
    const findExisting = () => clientTxId
      ? get(`SELECT * FROM transactions WHERE user_id = ? AND client_tx_id = ?`, [account.user_id, clientTxId])
      : null;
    const existing = await findExisting();
    if (existing) {
      return res.status(200).json({ ...existing, accountId: existing.account_id, userId: existing.user_id });
    }

    let newTransaction;
    try {
      newTransaction = await Transaction.create({
        accountId,
        userId: account.user_id,
        date,
        description,
        category,
        amount,
        type: type || (amount >= 0 ? 'income' : 'expense'),
        clientTxId
      });
    } catch (err) {
      // Два одновременных повтора: второй упирается в уникальный индекс.
      const dup = /UNIQUE constraint failed: .*client_tx_id/.test((err && err.message) || '') && await findExisting();
      if (dup) return res.status(200).json({ ...dup, accountId: dup.account_id, userId: dup.user_id });
      throw err;
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

// Перевод между двумя счетами (двойная запись).
// Создаёт две строки type='transfer' с общим transfer_id и атомарно двигает
// оба баланса. Оба счёта должны принадлежать текущему пользователю.
router.post('/transfer', authenticate, async (req, res, next) => {
  try {
    const { fromAccountId, toAccountId, amount, date, description } = req.body;
    let { toAmount } = req.body;

    // Базовая валидация полей (детальная валидация суммы/одинакового счёта —
    // в модели, она бросает AppError(400)).
    if (!fromAccountId || !toAccountId || amount === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Source account, destination account and amount are required',
      });
    }

    // Оба счёта должны существовать и принадлежать пользователю.
    const fromAccount = await Account.findById(fromAccountId, req.user.id);
    const toAccount = await Account.findById(toAccountId, req.user.id);

    if (!fromAccount || !toAccount) {
      return res.status(404).json({
        error: true,
        message: 'One of the accounts was not found',
      });
    }

    // Перевод между валютами: без toAmount зачисление считаем по курсу
    // (раньше на UAH-счёт приходило 100 вместо ~3000).
    if ((toAmount === undefined || toAmount === null || toAmount === '') &&
        fromAccount.currency && toAccount.currency && fromAccount.currency !== toAccount.currency) {
      const fx = await currencyService.convert(amount, fromAccount.currency, toAccount.currency, date || null);
      toAmount = fx.result;
    }

    const result = await Transaction.createTransfer({
      userId: req.user.id,
      fromAccountId,
      toAccountId,
      amount,
      toAmount: toAmount === '' ? undefined : toAmount,
      date,
      description,
    });

    res.status(201).json(result);
  } catch (error) {
    // AppError (например, 400 за одинаковый счёт/неположительную сумму) —
    // отдаём через глобальный errorHandler как { success:false, error:{...} }.
    if (error && error.name === 'AppError') {
      return next(error);
    }
    console.error('Error creating transfer:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to create transfer',
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
      message: 'Failed to fetch transaction' 
    });
  }
});

// Обновление транзакции
router.put('/:id', authenticate, async (req, res, next) => {
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
    // AppError (400 за попытку сменить тип ноги перевода и т.п.) — через
    // глобальный errorHandler { success:false, error:{code,message} }.
    if (error && error.name === 'AppError') {
      return next(error);
    }
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
        message: 'Transaction deleted' 
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
        message: 'No file uploaded' 
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
      message: 'Failed to fetch statistics' 
    });
  }
});

module.exports = router;
