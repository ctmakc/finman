const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');
const { defaultCurrency: DEFAULT_CURRENCY } = require('../config/config');
const subscriptionDetector = require('../services/subscriptionDetector');
const Subscription = require('../models/subscription');
const dates = require('../lib/dates');
const money = require('../lib/money');
const { converterForUser } = require('../lib/fx');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// 500 without the raw SQLite message (it names tables and constraints).
function serverError(res, error) {
  console.error('subscriptions:', error);
  return res.status(500).json({ message: 'Internal server error' });
}

// account_id / transaction_id from the body must belong to the caller.
async function ownsAccount(accountId, userId) {
  if (accountId === undefined || accountId === null || accountId === '') return true;
  return Boolean(await get('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]));
}

// Получить все подписки
router.get('/', async (req, res) => {
  try {
    const today = dates.todayISO(dates.userTz(req.user));
    // Автопродляемые подписки с датой списания в прошлом — докатить до будущей.
    await Subscription.rollForwardStale(req.user.id, today);
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
      ...Subscription.billingInfo(s, today)
    }));

    res.json(enriched);
  } catch (error) {
    serverError(res, error);
  }
});

// Статистика подписок
router.get('/stats', async (req, res) => {
  try {
    const today = dates.todayISO(dates.userTz(req.user));
    await Subscription.rollForwardStale(req.user.id, today);
    const active = await query(
      'SELECT * FROM subscriptions WHERE user_id = ? AND is_active = 1',
      [req.user.id]
    );

    // Each subscription in its own currency -> totals in the base currency.
    const fx = await converterForUser(req.user.id);
    let monthlyTotal = 0;
    let yearlyTotal = 0;
    for (const s of active) {
      const yearly = calculateYearlyAmount(Number(s.amount) || 0, s.billing_cycle);
      const converted = await fx.convert(yearly, s.currency);
      yearlyTotal = money.add(yearlyTotal, converted);
    }
    monthlyTotal = money.round(yearlyTotal / 12);

    const upcoming = active.filter(s => {
      if (!s.next_billing_date) return false;
      const days = dates.diffDays(today, String(s.next_billing_date).slice(0, 10));
      return days !== null && days >= 0 && days <= 7;
    });

    res.json({
      activeCount: active.length,
      monthlyTotal,
      yearlyTotal,
      currency: fx.baseCurrency,
      missingRates: fx.missingRates,
      upcomingCount: upcoming.length,
      upcoming
    });
  } catch (error) {
    serverError(res, error);
  }
});

// Детектор регулярных списаний (кандидаты в подписки, которых ещё нет).
router.get('/detect', async (req, res) => {
  try {
    const result = await subscriptionDetector.detectRecurring(req.user.id);
    res.json(result);
  } catch (error) {
    serverError(res, error);
  }
});

// Создать подписку
router.post('/', async (req, res) => {
  try {
    const { name, description, amount, currency, billing_cycle, category, icon, color, start_date, reminder_days, auto_renew, account_id, url, notes } = req.body;

    if (!(await ownsAccount(account_id, req.user.id))) {
      return res.status(404).json({ message: 'Account not found' });
    }
    const nextBilling = Subscription.firstBillingDate(start_date, billing_cycle, dates.todayISO(dates.userTz(req.user)));

    const result = await run(
      `INSERT INTO subscriptions (user_id, name, description, amount, currency, billing_cycle, category, icon, color, start_date, next_billing_date, reminder_days, auto_renew, account_id, url, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, name, description, amount, currency || DEFAULT_CURRENCY, billing_cycle || 'monthly', category, icon, color, start_date, nextBilling, reminder_days || 3, auto_renew !== false ? 1 : 0, account_id, url, notes]
    );

    res.status(201).json({ id: result.id, message: 'Subscription created' });
  } catch (error) {
    serverError(res, error);
  }
});

// Обновить подписку
router.put('/:id', async (req, res) => {
  try {
    const sub = await get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!sub) return res.status(404).json({ message: 'Subscription not found' });

    const { name, description, amount, currency, billing_cycle, category, icon, color, reminder_days, auto_renew, account_id, url, notes, is_active } = req.body;
    if (!(await ownsAccount(account_id, req.user.id))) {
      return res.status(404).json({ message: 'Account not found' });
    }

    await run(
      `UPDATE subscriptions SET name = ?, description = ?, amount = ?, currency = ?, billing_cycle = ?, category = ?, icon = ?, color = ?, reminder_days = ?, auto_renew = ?, account_id = ?, url = ?, notes = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name || sub.name, description, amount || sub.amount, currency || sub.currency, billing_cycle || sub.billing_cycle, category, icon, color, reminder_days, auto_renew !== undefined ? (auto_renew ? 1 : 0) : sub.auto_renew, account_id, url, notes, is_active !== undefined ? (is_active ? 1 : 0) : sub.is_active, req.params.id]
    );

    res.json({ message: 'Subscription updated' });
  } catch (error) {
    serverError(res, error);
  }
});

// Отменить/возобновить подписку
router.post('/:id/toggle', async (req, res) => {
  try {
    const sub = await get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!sub) return res.status(404).json({ message: 'Subscription not found' });

    await run('UPDATE subscriptions SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sub.is_active ? 0 : 1, req.params.id]);

    res.json({ message: sub.is_active ? 'Subscription cancelled' : 'Subscription resumed' });
  } catch (error) {
    serverError(res, error);
  }
});

// Записать платёж
router.post('/:id/payment', async (req, res) => {
  try {
    const sub = await get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!sub) return res.status(404).json({ message: 'Subscription not found' });

    const { amount, payment_date, transaction_id } = req.body;
    if (transaction_id !== undefined && transaction_id !== null && transaction_id !== '' &&
        !(await get('SELECT id FROM transactions WHERE id = ? AND user_id = ?', [transaction_id, req.user.id]))) {
      return res.status(404).json({ message: 'Transaction not found' });
    }
    const todayStr = dates.todayISO(dates.userTz(req.user));

    await run(
      'INSERT INTO subscription_payments (subscription_id, amount, payment_date, transaction_id) VALUES (?, ?, ?, ?)',
      [req.params.id, amount || sub.amount, payment_date || todayStr, transaction_id]
    );

    // Обновить следующую дату оплаты: дата оплаты + цикл, но не раньше сегодня.
    const nextBilling = Subscription.nextAfterPayment(payment_date || todayStr, sub.billing_cycle, todayStr, sub.start_date);
    await run('UPDATE subscriptions SET next_billing_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextBilling, req.params.id]);

    res.json({ message: 'Payment recorded' });
  } catch (error) {
    serverError(res, error);
  }
});

// История платежей
router.get('/:id/payments', async (req, res) => {
  try {
    const payments = await query(
      `SELECT p.* FROM subscription_payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.subscription_id = ? AND s.user_id = ?
       ORDER BY p.payment_date DESC`,
      [req.params.id, req.user.id]
    );
    res.json(payments);
  } catch (error) {
    serverError(res, error);
  }
});

// Удалить подписку
router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Subscription deleted' });
  } catch (error) {
    serverError(res, error);
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

// Логика дат списания — в models/subscription.js (перекат до даты >= сегодня).

module.exports = router;
