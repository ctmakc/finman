const express = require('express');
const passport = require('passport');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Transaction = require('../models/transaction');
const Account = require('../models/account');
const csvImportService = require('../services/csvImportService');

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
    console.error('Ошибка при получении транзакций:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении транзакций' 
    });
  }
});

// Создание новой транзакции
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
    
    // Проверка, существует ли счет
    const account = await Account.findById(accountId, req.user.id);
    
    if (!account) {
      return res.status(404).json({ 
        error: true, 
        message: 'Счет не найден' 
      });
    }
    
    // Создание транзакции
    const newTransaction = await Transaction.create({
      accountId,
      userId: req.user.id,
      date,
      description,
      category,
      amount,
      type: type || (amount >= 0 ? 'income' : 'expense')
    });
    
    res.status(201).json(newTransaction);
  } catch (error) {
    console.error('Ошибка при создании транзакции:', error);
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
    console.error('Ошибка при получении транзакции:', error);
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
    console.error('Ошибка при обновлении транзакции:', error);
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
    console.error('Ошибка при удалении транзакции:', error);
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
    console.error('Ошибка при импорте транзакций:', error);
    
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
    console.error('Ошибка при получении статистики:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении статистики' 
    });
  }
});

module.exports = router;
