const express = require('express');
const passport = require('passport');
const RecurringPayment = require('../models/recurringPayment');
const Account = require('../models/account');

const router = express.Router();

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// Получение всех регулярных платежей
router.get('/', authenticate, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const payments = await RecurringPayment.findByUserId(req.user.id, includeInactive);
    res.json(payments);
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ error: true, message: 'Failed to get payments' });
  }
});

// Получение статистики
router.get('/stats', authenticate, async (req, res) => {
  try {
    const stats = await RecurringPayment.getStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: true, message: 'Failed to get stats' });
  }
});

// Получение ближайших платежей
router.get('/upcoming', authenticate, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const payments = await RecurringPayment.getUpcoming(req.user.id, days);
    res.json(payments);
  } catch (error) {
    console.error('Error fetching upcoming payments:', error);
    res.status(500).json({ error: true, message: 'Failed to get payments' });
  }
});

// Получение просроченных платежей
router.get('/overdue', authenticate, async (req, res) => {
  try {
    const payments = await RecurringPayment.getOverdue(req.user.id);
    res.json(payments);
  } catch (error) {
    console.error('Error fetching overdue payments:', error);
    res.status(500).json({ error: true, message: 'Failed to get payments' });
  }
});

// Получение списка частот
router.get('/frequencies', authenticate, (req, res) => {
  res.json(RecurringPayment.getFrequencies());
});

// Создание нового платежа
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      accountId,
      name,
      description,
      amount,
      type,
      category,
      frequency,
      dayOfMonth,
      dayOfWeek,
      startDate,
      endDate,
      autoCreate,
      notifyBefore
    } = req.body;

    // Валидация
    if (!accountId || !name || !amount || !startDate) {
      return res.status(400).json({
        error: true,
        message: 'Account, name, amount and start date are required'
      });
    }

    // Проверка счета
    const account = await Account.findById(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ error: true, message: 'Account not found' });
    }

    const payment = await RecurringPayment.create({
      userId: req.user.id,
      accountId,
      name,
      description,
      amount,
      type: type || 'expense',
      category,
      frequency: frequency || 'monthly',
      dayOfMonth,
      dayOfWeek,
      startDate,
      endDate,
      autoCreate: autoCreate || false,
      notifyBefore: notifyBefore || 3
    });

    res.status(201).json({ success: true, payment });
  } catch (error) {
    console.error('Error creating payment:', error);
    res.status(500).json({ error: true, message: 'Failed to create payment' });
  }
});

// Получение платежа по ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const payment = await RecurringPayment.findById(req.params.id);

    if (!payment || payment.user_id !== req.user.id) {
      return res.status(404).json({ error: true, message: 'Payment not found' });
    }

    res.json(payment);
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ error: true, message: 'Failed to get payment' });
  }
});

// Обновление платежа
router.put('/:id', authenticate, async (req, res) => {
  try {
    const success = await RecurringPayment.update(
      req.params.id,
      req.user.id,
      req.body
    );

    if (!success) {
      return res.status(404).json({ error: true, message: 'Payment not found' });
    }

    const payment = await RecurringPayment.findById(req.params.id);
    res.json({ success: true, payment });
  } catch (error) {
    console.error('Error updating payment:', error);
    res.status(500).json({ error: true, message: 'Failed to update payment' });
  }
});

// Удаление платежа
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const success = await RecurringPayment.delete(req.params.id, req.user.id);

    if (!success) {
      return res.status(404).json({ error: true, message: 'Payment not found' });
    }

    res.json({ success: true, message: 'Payment deleted' });
  } catch (error) {
    console.error('Error deleting payment:', error);
    res.status(500).json({ error: true, message: 'Failed to delete payment' });
  }
});

// Отметить как оплаченный
router.post('/:id/pay', authenticate, async (req, res) => {
  try {
    const createTransaction = req.body.createTransaction !== false;
    const result = await RecurringPayment.markAsPaid(
      req.params.id,
      req.user.id,
      createTransaction
    );

    if (!result.success) {
      return res.status(404).json({ error: true, message: result.message });
    }

    res.json(result);
  } catch (error) {
    console.error('Error processing payment:', error);
    res.status(500).json({ error: true, message: 'Failed to process payment' });
  }
});

// Пропустить платеж
router.post('/:id/skip', authenticate, async (req, res) => {
  try {
    const result = await RecurringPayment.skip(req.params.id, req.user.id);

    if (!result.success) {
      return res.status(404).json({ error: true, message: result.message });
    }

    res.json(result);
  } catch (error) {
    console.error('Error skipping payment:', error);
    res.status(500).json({ error: true, message: 'Failed to skip payment' });
  }
});

// Приостановить/возобновить платеж
router.post('/:id/toggle', authenticate, async (req, res) => {
  try {
    const payment = await RecurringPayment.findById(req.params.id);

    if (!payment || payment.user_id !== req.user.id) {
      return res.status(404).json({ error: true, message: 'Payment not found' });
    }

    await RecurringPayment.update(req.params.id, req.user.id, {
      isActive: !payment.is_active
    });

    const updated = await RecurringPayment.findById(req.params.id);
    res.json({ success: true, payment: updated });
  } catch (error) {
    console.error('Error toggling payment:', error);
    res.status(500).json({ error: true, message: 'Error' });
  }
});

module.exports = router;
