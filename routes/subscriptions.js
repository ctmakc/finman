const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Получить все подписки
router.get('/', async (req, res) => {
  try {
    const subscriptions = await query(
      `SELECT s.*, a.name as account_name
       FROM subscriptions s
       LEFT JOIN accounts a ON s.account_id = a.id
       WHERE s.user_id = ? ORDER BY s.next_billing_date`,
      [req.user.id]
    );

    const enriched = subscriptions.map(s => ({
      ...s,
      monthlyAmount: calculateMonthlyAmount(s.amount, s.billing_cycle),
      yearlyAmount: calculateYearlyAmount(s.amount, s.billing_cycle),
      daysUntilBilling: s.next_billing_date ? Math.ceil((new Date(s.next_billing_date) - new Date()) / (1000 * 60 * 60 * 24)) : null
    }));

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Статистика подписок
router.get('/stats', async (req, res) => {
  try {
    const active = await query(
      'SELECT * FROM subscriptions WHERE user_id = ? AND is_active = 1',
      [req.user.id]
    );

    let monthlyTotal = 0;
    let yearlyTotal = 0;

    active.forEach(s => {
      monthlyTotal += calculateMonthlyAmount(s.amount, s.billing_cycle);
      yearlyTotal += calculateYearlyAmount(s.amount, s.billing_cycle);
    });

    const upcoming = active.filter(s => {
      if (!s.next_billing_date) return false;
      const days = Math.ceil((new Date(s.next_billing_date) - new Date()) / (1000 * 60 * 60 * 24));
      return days >= 0 && days <= 7;
    });

    res.json({
      activeCount: active.length,
      monthlyTotal,
      yearlyTotal,
      upcomingCount: upcoming.length,
      upcoming
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Создать подписку
router.post('/', async (req, res) => {
  try {
    const { name, description, amount, currency, billing_cycle, category, icon, color, start_date, reminder_days, auto_renew, account_id, url, notes } = req.body;

    const nextBilling = calculateNextBillingDate(start_date, billing_cycle);

    const result = await run(
      `INSERT INTO subscriptions (user_id, name, description, amount, currency, billing_cycle, category, icon, color, start_date, next_billing_date, reminder_days, auto_renew, account_id, url, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, name, description, amount, currency || 'UAH', billing_cycle || 'monthly', category, icon, color, start_date, nextBilling, reminder_days || 3, auto_renew !== false ? 1 : 0, account_id, url, notes]
    );

    res.status(201).json({ id: result.id, message: 'Подписка создана' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Обновить подписку
router.put('/:id', async (req, res) => {
  try {
    const sub = await get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!sub) return res.status(404).json({ message: 'Подписка не найдена' });

    const { name, description, amount, currency, billing_cycle, category, icon, color, reminder_days, auto_renew, account_id, url, notes, is_active } = req.body;

    await run(
      `UPDATE subscriptions SET name = ?, description = ?, amount = ?, currency = ?, billing_cycle = ?, category = ?, icon = ?, color = ?, reminder_days = ?, auto_renew = ?, account_id = ?, url = ?, notes = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name || sub.name, description, amount || sub.amount, currency || sub.currency, billing_cycle || sub.billing_cycle, category, icon, color, reminder_days, auto_renew !== undefined ? (auto_renew ? 1 : 0) : sub.auto_renew, account_id, url, notes, is_active !== undefined ? (is_active ? 1 : 0) : sub.is_active, req.params.id]
    );

    res.json({ message: 'Подписка обновлена' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Отменить/возобновить подписку
router.post('/:id/toggle', async (req, res) => {
  try {
    const sub = await get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!sub) return res.status(404).json({ message: 'Subscription not found' });

    await run('UPDATE subscriptions SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sub.is_active ? 0 : 1, req.params.id]);

    res.json({ message: sub.is_active ? 'Subscription paused' : 'Subscription resumed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Записать платёж
router.post('/:id/payment', async (req, res) => {
  try {
    const sub = await get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!sub) return res.status(404).json({ message: 'Подписка не найдена' });

    const { amount, payment_date, transaction_id } = req.body;

    await run(
      'INSERT INTO subscription_payments (subscription_id, amount, payment_date, transaction_id) VALUES (?, ?, ?, ?)',
      [req.params.id, amount || sub.amount, payment_date || new Date().toISOString().split('T')[0], transaction_id]
    );

    // Обновить следующую дату оплаты
    const nextBilling = calculateNextBillingDate(payment_date || new Date().toISOString().split('T')[0], sub.billing_cycle);
    await run('UPDATE subscriptions SET next_billing_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextBilling, req.params.id]);

    res.json({ message: 'Платёж записан' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// История платежей
router.get('/:id/payments', async (req, res) => {
  try {
    const payments = await query(
      'SELECT * FROM subscription_payments WHERE subscription_id = ? ORDER BY payment_date DESC',
      [req.params.id]
    );
    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Удалить подписку
router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Подписка удалена' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Вспомогательные функции
function calculateMonthlyAmount(amount, cycle) {
  switch (cycle) {
    case 'weekly': return amount * 4.33;
    case 'monthly': return amount;
    case 'quarterly': return amount / 3;
    case 'yearly': return amount / 12;
    default: return amount;
  }
}

function calculateYearlyAmount(amount, cycle) {
  switch (cycle) {
    case 'weekly': return amount * 52;
    case 'monthly': return amount * 12;
    case 'quarterly': return amount * 4;
    case 'yearly': return amount;
    default: return amount * 12;
  }
}

function calculateNextBillingDate(fromDate, cycle) {
  const date = new Date(fromDate);
  switch (cycle) {
    case 'weekly': date.setDate(date.getDate() + 7); break;
    case 'monthly': date.setMonth(date.getMonth() + 1); break;
    case 'quarterly': date.setMonth(date.getMonth() + 3); break;
    case 'yearly': date.setFullYear(date.getFullYear() + 1); break;
    default: date.setMonth(date.getMonth() + 1);
  }
  return date.toISOString().split('T')[0];
}

module.exports = router;
