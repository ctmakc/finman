// ==================== МАРШРУТЫ ДОЛГОВ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Debt = require('../models/debt');
const { todayISO, userTz } = require('../lib/dates');
const { normalizeBody, missingFields, missingFieldsMessage } = require('../lib/bodyFields');

// Body fields accepted in snake_case or camelCase (public API docs vs PWA).
const DEBT_FIELDS = {
  name: [],
  description: [],
  type: ['debtType'],
  amount: ['totalAmount', 'total_amount', 'principal'],
  paid_amount: ['paidAmount'],
  interest_rate: ['interestRate', 'rate'],
  minimum_payment: ['minimumPayment', 'minPayment', 'min_payment'],
  currency: [],
  counterparty: ['lender', 'creditor'],
  start_date: ['startDate'],
  due_date: ['dueDate', 'endDate', 'end_date'],
  is_active: ['isActive'],
};
const DEBT_REQUIRED = ['name', 'type', 'amount', 'start_date'];
const DEBT_TYPES = ['i_owe', 'owe_me', 'credit', 'mortgage', 'loan'];

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Получить все долги
router.get('/', async (req, res) => {
  try {
    const includeSettled = req.query.includeSettled === 'true';
    const debts = await Debt.findByUser(req.user.id, includeSettled);
    const today = todayISO(userTz(req.user));
    res.json(debts.map(d => Debt.calculateDebtInfo(d, today)));
  } catch (error) {
    console.error('Ошибка получения долгов:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Статистика
router.get('/stats', async (req, res) => {
  try {
    const stats = await Debt.getUserStats(req.user.id, todayISO(userTz(req.user)));
    res.json(stats);
  } catch (error) {
    console.error('Ошибка статистики:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Предстоящие платежи
router.get('/upcoming', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const debts = await Debt.getUpcomingPayments(req.user.id, days);
    res.json(debts);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Получить долг по ID
router.get('/:id', async (req, res) => {
  try {
    const debt = await Debt.findById(req.params.id);
    if (!debt || debt.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Долг не найден' });
    }
    res.json(Debt.calculateDebtInfo(debt, todayISO(userTz(req.user))));
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Create a debt. Accepts snake_case and camelCase bodies.
router.post('/', async (req, res) => {
  try {
    const data = normalizeBody(req.body, DEBT_FIELDS);
    const missing = missingFields(data, DEBT_REQUIRED);
    if (missing.length) {
      return res.status(400).json({ message: missingFieldsMessage(missing), missing });
    }
    if (!DEBT_TYPES.includes(String(data.type))) {
      return res.status(400).json({ message: `type must be one of: ${DEBT_TYPES.join(', ')}` });
    }
    const amount = Number(data.amount);
    if (!(amount > 0)) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }
    const paid = data.paid_amount === undefined ? 0 : Number(data.paid_amount);
    if (!(paid >= 0) || paid > amount) {
      return res.status(400).json({ message: 'paid_amount must be between 0 and amount' });
    }

    const debt = await Debt.create({
      user_id: req.user.id,
      name: data.name,
      description: data.description,
      type: data.type,
      amount,
      paid_amount: paid,
      interest_rate: data.interest_rate,
      minimum_payment: data.minimum_payment,
      currency: data.currency,
      counterparty: data.counterparty,
      start_date: data.start_date,
      due_date: data.due_date
    });

    res.status(201).json(debt);
  } catch (error) {
    console.error('Error creating debt:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Обновить долг
router.put('/:id', async (req, res) => {
  try {
    const debt = await Debt.findById(req.params.id);
    if (!debt || debt.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Долг не найден' });
    }

    const updated = await Debt.update(req.params.id, normalizeBody(req.body, DEBT_FIELDS));
    res.json(updated);
  } catch (error) {
    console.error('Ошибка обновления:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Добавить платёж
router.post('/:id/payment', async (req, res) => {
  try {
    const debt = await Debt.findById(req.params.id);
    if (!debt || debt.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Долг не найден' });
    }

    const { amount, payment_type, note, payment_date } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Сумма должна быть положительной' });
    }

    const updated = await Debt.addPayment(req.params.id, amount, payment_type, note, null, payment_date);
    res.json(updated);
  } catch (error) {
    console.error('Ошибка платежа:', error);
    res.status(500).json({ message: error.message || 'Ошибка сервера' });
  }
});

// Получить историю платежей
router.get('/:id/payments', async (req, res) => {
  try {
    const debt = await Debt.findById(req.params.id);
    if (!debt || debt.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Долг не найден' });
    }

    const payments = await Debt.getPayments(req.params.id);
    res.json(payments);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Удалить долг
router.delete('/:id', async (req, res) => {
  try {
    const debt = await Debt.findById(req.params.id);
    if (!debt || debt.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Долг не найден' });
    }

    await Debt.delete(req.params.id);
    res.json({ message: 'Долг удалён' });
  } catch (error) {
    console.error('Ошибка удаления:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
