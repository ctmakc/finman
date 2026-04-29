// ==================== МАРШРУТЫ ДОЛГОВ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Debt = require('../models/debt');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Получить все долги
router.get('/', async (req, res) => {
  try {
    const includeSettled = req.query.includeSettled === 'true';
    const debts = await Debt.findByUser(req.user.id, includeSettled);
    const debtsWithInfo = debts.map(d => Debt.calculateDebtInfo ? Debt.calculateDebtInfo(d) : d);
    res.json(debtsWithInfo);
  } catch (error) {
    console.error('Ошибка получения долгов:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Stats summary
router.get('/stats', async (req, res) => {
  try {
    const debts = await Debt.findByUser(req.user.id, false);
    let iOwe = 0, theyOwe = 0;
    debts.forEach(d => {
      const amt = parseFloat(d.amount) || 0;
      if (d.type === 'i_owe') iOwe += amt;
      else theyOwe += amt;
    });
    res.json({ iOwe, theyOweMe: theyOwe, balance: theyOwe - iOwe, count: debts.length });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ iOwe: 0, theyOweMe: 0, balance: 0, count: 0 });
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
    res.json(Debt.calculateDebtInfo ? Debt.calculateDebtInfo(debt) : debt);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Создать долг
router.post('/', async (req, res) => {
  try {
    const { name, description, type, amount, interest_rate, currency, counterparty, start_date, due_date } = req.body;
    
    if (!name || !type || !amount || !start_date) {
      return res.status(400).json({ message: 'Заполните обязательные поля' });
    }

    const debt = await Debt.create({
      user_id: req.user.id,
      name, description, type, amount, interest_rate, currency, counterparty, start_date, due_date
    });

    res.status(201).json(debt);
  } catch (error) {
    console.error('Ошибка создания:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Обновить долг
router.put('/:id', async (req, res) => {
  try {
    const debt = await Debt.findById(req.params.id);
    if (!debt || debt.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Долг не найден' });
    }

    const updated = await Debt.update(req.params.id, req.body);
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
