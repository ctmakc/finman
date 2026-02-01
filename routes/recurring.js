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
    console.error('Ошибка при получении платежей:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении платежей' });
  }
});

// Получение статистики
router.get('/stats', authenticate, async (req, res) => {
  try {
    const stats = await RecurringPayment.getStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Ошибка при получении статистики:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении статистики' });
  }
});

// Получение ближайших платежей
router.get('/upcoming', authenticate, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const payments = await RecurringPayment.getUpcoming(req.user.id, days);
    res.json(payments);
  } catch (error) {
    console.error('Ошибка при получении ближайших платежей:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении платежей' });
  }
});

// Получение просроченных платежей
router.get('/overdue', authenticate, async (req, res) => {
  try {
    const payments = await RecurringPayment.getOverdue(req.user.id);
    res.json(payments);
  } catch (error) {
    console.error('Ошибка при получении просроченных платежей:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении платежей' });
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
        message: 'Необходимо указать счет, название, сумму и дату начала'
      });
    }

    // Проверка счета
    const account = await Account.findById(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ error: true, message: 'Счет не найден' });
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
    console.error('Ошибка при создании платежа:', error);
    res.status(500).json({ error: true, message: 'Ошибка при создании платежа' });
  }
});

// Получение платежа по ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const payment = await RecurringPayment.findById(req.params.id);

    if (!payment || payment.user_id !== req.user.id) {
      return res.status(404).json({ error: true, message: 'Платеж не найден' });
    }

    res.json(payment);
  } catch (error) {
    console.error('Ошибка при получении платежа:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении платежа' });
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
      return res.status(404).json({ error: true, message: 'Платеж не найден' });
    }

    const payment = await RecurringPayment.findById(req.params.id);
    res.json({ success: true, payment });
  } catch (error) {
    console.error('Ошибка при обновлении платежа:', error);
    res.status(500).json({ error: true, message: 'Ошибка при обновлении платежа' });
  }
});

// Удаление платежа
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const success = await RecurringPayment.delete(req.params.id, req.user.id);

    if (!success) {
      return res.status(404).json({ error: true, message: 'Платеж не найден' });
    }

    res.json({ success: true, message: 'Платеж удален' });
  } catch (error) {
    console.error('Ошибка при удалении платежа:', error);
    res.status(500).json({ error: true, message: 'Ошибка при удалении платежа' });
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
    console.error('Ошибка при оплате:', error);
    res.status(500).json({ error: true, message: 'Ошибка при оплате' });
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
    console.error('Ошибка при пропуске:', error);
    res.status(500).json({ error: true, message: 'Ошибка при пропуске платежа' });
  }
});

// Приостановить/возобновить платеж
router.post('/:id/toggle', authenticate, async (req, res) => {
  try {
    const payment = await RecurringPayment.findById(req.params.id);

    if (!payment || payment.user_id !== req.user.id) {
      return res.status(404).json({ error: true, message: 'Платеж не найден' });
    }

    await RecurringPayment.update(req.params.id, req.user.id, {
      isActive: !payment.is_active
    });

    const updated = await RecurringPayment.findById(req.params.id);
    res.json({ success: true, payment: updated });
  } catch (error) {
    console.error('Ошибка при переключении:', error);
    res.status(500).json({ error: true, message: 'Ошибка' });
  }
});

module.exports = router;
