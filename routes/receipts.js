const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');
const ocrService = require('../services/ocrService');

// Foundation-инфраструктура (feature-detect: если чего-то нет — деградируем мягко).
let logger;
try {
  logger = require('../lib/logger');
} catch (_) {
  logger = { info() {}, warn() {}, error() {} };
}

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Получить все чеки
router.get('/', async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    let filter = '';
    if (status === 'pending') filter = 'AND is_processed = 0';
    if (status === 'processed') filter = 'AND is_processed = 1';

    const receipts = await query(
      `SELECT r.*, t.description as transaction_description
       FROM receipts r
       LEFT JOIN transactions t ON r.transaction_id = t.id
       WHERE r.user_id = ? ${filter}
       ORDER BY r.created_at DESC LIMIT ?`,
      [req.user.id, parseInt(limit)]
    );

    res.json(receipts.map(r => ({
      ...r,
      items: JSON.parse(r.items || '[]')
    })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Получить один чек
router.get('/:id', async (req, res) => {
  try {
    const receipt = await get('SELECT * FROM receipts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!receipt) return res.status(404).json({ message: 'Чек не найден' });

    res.json({
      ...receipt,
      items: JSON.parse(receipt.items || '[]')
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Загрузить чек (base64 изображение) + РЕАЛЬНЫЙ OCR (tesseract.js)
router.post('/upload', async (req, res) => {
  try {
    const { image_data, notes } = req.body;

    if (!image_data) {
      return res.status(400).json({ message: 'Изображение обязательно' });
    }

    // 1) Сразу сохраняем чек в статусе 'pending' — пользователь видит запись,
    //    даже если OCR займёт время или упадёт.
    const result = await run(
      `INSERT INTO receipts (user_id, image_data, ocr_status, notes) VALUES (?, ?, 'pending', ?)`,
      [req.user.id, image_data, notes]
    );
    const receiptId = result.id;

    // 2) Запускаем РЕАЛЬНЫЙ OCR. processImage никогда не бросает —
    //    на ошибке вернёт ocr_status:'failed'. Делаем await, чтобы ответ
    //    содержал актуальный статус (нет «вечного pending» как в фейке).
    //    Если хочется неблокирующе — см. ниже опцию async=1.
    const wantAsync = req.query.async === '1' || req.body.async === true;

    if (wantAsync) {
      // Неблокирующий режим: отвечаем сразу, OCR в фоне (async-safe).
      res.status(201).json({ id: receiptId, ocr_status: 'pending', message: 'Чек загружен, идёт распознавание...' });
      // Не ждём промис — но ошибки гасим, чтобы не уронить процесс.
      processAndStore(receiptId, image_data).catch((e) => {
        logger.error({ err: e && e.message, receiptId }, 'Async OCR failed');
      });
      return;
    }

    // Синхронный режим (по умолчанию): дожидаемся OCR и возвращаем результат.
    const ocr = await processAndStore(receiptId, image_data);
    return res.status(201).json({
      id: receiptId,
      ocr_status: ocr.ocr_status,
      merchant: ocr.merchant,
      total_amount: ocr.total_amount,
      currency: ocr.currency,
      receipt_date: ocr.receipt_date,
      category: ocr.category,
      items: ocr.items,
      message: ocr.ocr_status === 'completed' ? 'Чек распознан' : 'Не удалось распознать чек, заполните вручную'
    });
  } catch (error) {
    logger.error({ err: error && error.message }, 'Receipt upload failed');
    res.status(500).json({ message: error.message });
  }
});

/**
 * Прогнать изображение через OCR и записать РЕАЛЬНЫЕ результаты в чек.
 * Возвращает структуру OCR. Никогда не бросает из-за плохого изображения —
 * processImage сам ловит ошибки и ставит ocr_status:'failed'. Падение может
 * прийти только от БД (его обрабатывает вызывающий код / .catch фонового режима).
 */
async function processAndStore(receiptId, imageData) {
  const ocr = await ocrService.processImage(imageData);

  await run(
    `UPDATE receipts
       SET merchant = ?, total_amount = ?, currency = ?, receipt_date = ?,
           category = ?, items = ?, ocr_raw = ?, ocr_status = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      ocr.merchant,
      ocr.total_amount,
      ocr.currency || 'UAH',
      ocr.receipt_date,
      ocr.category,
      JSON.stringify(ocr.items || []),
      ocr.ocr_raw,
      ocr.ocr_status,
      receiptId
    ]
  );

  return ocr;
}

// Ручной ввод данных чека
router.post('/manual', async (req, res) => {
  try {
    const { merchant, total_amount, currency, receipt_date, category, items, notes } = req.body;

    const result = await run(
      `INSERT INTO receipts (user_id, merchant, total_amount, currency, receipt_date, category, items, ocr_status, is_processed, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?)`,
      [req.user.id, merchant, total_amount, currency || 'UAH', receipt_date || new Date().toISOString().split('T')[0], category, JSON.stringify(items || []), notes]
    );

    res.status(201).json({ id: result.id, message: 'Чек добавлен' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Обновить данные чека (пользователь корректирует распознанное перед сохранением)
router.put('/:id', async (req, res) => {
  try {
    const receipt = await get('SELECT * FROM receipts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!receipt) return res.status(404).json({ message: 'Чек не найден' });

    const { merchant, total_amount, currency, receipt_date, category, items, notes, is_processed } = req.body;

    await run(
      `UPDATE receipts SET merchant = ?, total_amount = ?, currency = ?, receipt_date = ?, category = ?, items = ?, notes = ?, is_processed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [merchant || receipt.merchant, total_amount || receipt.total_amount, currency || receipt.currency, receipt_date || receipt.receipt_date, category || receipt.category, JSON.stringify(items || JSON.parse(receipt.items || '[]')), notes, is_processed !== undefined ? (is_processed ? 1 : 0) : receipt.is_processed, req.params.id]
    );

    res.json({ message: 'Чек обновлён' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Создать транзакцию из чека
router.post('/:id/create-transaction', async (req, res) => {
  try {
    const receipt = await get('SELECT * FROM receipts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!receipt) return res.status(404).json({ message: 'Чек не найден' });

    const { account_id, category } = req.body;

    if (!account_id) {
      return res.status(400).json({ message: 'Укажите счёт' });
    }

    // Создаём транзакцию
    const txResult = await run(
      `INSERT INTO transactions (user_id, account_id, type, amount, description, category, date)
       VALUES (?, ?, 'expense', ?, ?, ?, ?)`,
      [req.user.id, account_id, receipt.total_amount, receipt.merchant || 'Чек', category || receipt.category || 'other', receipt.receipt_date || new Date().toISOString().split('T')[0]]
    );

    // Обновляем баланс счёта
    await run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [receipt.total_amount, account_id]);

    // Связываем чек с транзакцией
    await run('UPDATE receipts SET transaction_id = ?, is_processed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [txResult.id, req.params.id]);

    res.json({ transaction_id: txResult.id, message: 'Транзакция создана' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Удалить чек
router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM receipts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Чек удалён' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Статистика
router.get('/stats/summary', async (req, res) => {
  try {
    const total = await get('SELECT COUNT(*) as count FROM receipts WHERE user_id = ?', [req.user.id]);
    const pending = await get('SELECT COUNT(*) as count FROM receipts WHERE user_id = ? AND is_processed = 0', [req.user.id]);
    const thisMonth = await get(
      `SELECT COUNT(*) as count, SUM(total_amount) as total FROM receipts
       WHERE user_id = ? AND receipt_date >= date('now', 'start of month')`,
      [req.user.id]
    );

    res.json({
      totalReceipts: total.count,
      pendingReceipts: pending.count,
      thisMonthCount: thisMonth.count,
      thisMonthTotal: thisMonth.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
module.exports.processAndStore = processAndStore;
