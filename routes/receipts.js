const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');

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
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    res.json({
      ...receipt,
      items: JSON.parse(receipt.items || '[]')
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Загрузить чек (base64 изображение)
router.post('/upload', async (req, res) => {
  try {
    const { image_data, notes } = req.body;

    if (!image_data) {
      return res.status(400).json({ message: 'Image is required' });
    }

    const result = await run(
      `INSERT INTO receipts (user_id, image_data, ocr_status, notes) VALUES (?, ?, 'pending', ?)`,
      [req.user.id, image_data, notes]
    );

    // Имитация OCR обработки (в реальном приложении здесь был бы вызов OCR API)
    setTimeout(async () => {
      try {
        await processReceiptOCR(result.id);
      } catch (e) {
        console.error('OCR error:', e);
      }
    }, 1000);

    res.status(201).json({ id: result.id, message: 'Receipt uploaded, processing...' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Ручной ввод данных чека
router.post('/manual', async (req, res) => {
  try {
    const { merchant, total_amount, currency, receipt_date, category, items, notes } = req.body;

    const result = await run(
      `INSERT INTO receipts (user_id, merchant, total_amount, currency, receipt_date, category, items, ocr_status, is_processed, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?)`,
      [req.user.id, merchant, total_amount, currency || 'USD', receipt_date || new Date().toISOString().split('T')[0], category, JSON.stringify(items || []), notes]
    );

    res.status(201).json({ id: result.id, message: 'Receipt added' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Обновить данные чека
router.put('/:id', async (req, res) => {
  try {
    const receipt = await get('SELECT * FROM receipts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    const { merchant, total_amount, currency, receipt_date, category, items, notes, is_processed } = req.body;

    await run(
      `UPDATE receipts SET merchant = ?, total_amount = ?, currency = ?, receipt_date = ?, category = ?, items = ?, notes = ?, is_processed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [merchant || receipt.merchant, total_amount || receipt.total_amount, currency || receipt.currency, receipt_date || receipt.receipt_date, category || receipt.category, JSON.stringify(items || JSON.parse(receipt.items || '[]')), notes, is_processed !== undefined ? (is_processed ? 1 : 0) : receipt.is_processed, req.params.id]
    );

    res.json({ message: 'Receipt updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Создать транзакцию из чека
router.post('/:id/create-transaction', async (req, res) => {
  try {
    const receipt = await get('SELECT * FROM receipts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    const { account_id, category } = req.body;

    if (!account_id) {
      return res.status(400).json({ message: 'Account required' });
    }

    // Создаём транзакцию
    const txResult = await run(
      `INSERT INTO transactions (user_id, account_id, type, amount, description, category, date)
       VALUES (?, ?, 'expense', ?, ?, ?, ?)`,
      [req.user.id, account_id, -Math.abs(receipt.total_amount), receipt.merchant || 'Receipt', category || receipt.category || 'other', receipt.receipt_date || new Date().toISOString().split('T')[0]]
    );

    // Обновляем баланс счёта
    await run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [receipt.total_amount, account_id]);

    // Связываем чек с транзакцией
    await run('UPDATE receipts SET transaction_id = ?, is_processed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [txResult.id, req.params.id]);

    res.json({ transaction_id: txResult.id, message: 'Transaction created' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Удалить чек
router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM receipts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Receipt deleted' });
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

// Имитация OCR обработки
async function processReceiptOCR(receiptId) {
  // В реальном приложении здесь был бы вызов Google Vision API, Tesseract или другого OCR сервиса
  // Для демонстрации создаём случайные данные

  const merchants = ['Walmart', 'Target', 'Amazon', 'Costco', 'Whole Foods', 'Shell', 'BP'];
  const categories = ['food', 'shopping', 'transport', 'entertainment', 'other'];

  const merchant = merchants[Math.floor(Math.random() * merchants.length)];
  const amount = Math.floor(Math.random() * 200) + 10;
  const category = categories[Math.floor(Math.random() * categories.length)];

  const items = [
    { name: 'Item 1', price: Math.floor(amount * 0.4), quantity: 1 },
    { name: 'Item 2', price: Math.floor(amount * 0.35), quantity: 2 },
    { name: 'Item 3', price: Math.floor(amount * 0.25), quantity: 1 }
  ];

  await run(
    `UPDATE receipts SET merchant = ?, total_amount = ?, category = ?, receipt_date = ?, items = ?, ocr_status = 'completed', ocr_raw = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [merchant, amount, category, new Date().toISOString().split('T')[0], JSON.stringify(items), JSON.stringify({ simulated: true }), receiptId]
  );
}

module.exports = router;
