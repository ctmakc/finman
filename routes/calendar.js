const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Получить события за период
router.get('/events', async (req, res) => {
  try {
    const { start, end, type } = req.query;

    let typeFilter = '';
    if (type) typeFilter = `AND event_type = '${type}'`;

    // Пользовательские события
    const events = await query(
      `SELECT * FROM calendar_events
       WHERE user_id = ? AND event_date >= ? AND event_date <= ? ${typeFilter}
       ORDER BY event_date`,
      [req.user.id, start, end]
    );

    // Регулярные платежи
    const recurring = await query(
      `SELECT id, description as title, amount, 'recurring' as event_type, next_execution_date as event_date, '#FF9800' as color
       FROM recurring_payments
       WHERE user_id = ? AND is_active = 1 AND next_execution_date >= ? AND next_execution_date <= ?`,
      [req.user.id, start, end]
    );

    // Subscriptions
    const subscriptions = await query(
      `SELECT id, name as title, amount, 'subscription' as event_type, next_billing_date as event_date, color
       FROM subscriptions
       WHERE user_id = ? AND is_active = 1 AND next_billing_date >= ? AND next_billing_date <= ?`,
      [req.user.id, start, end]
    );

    // Сроки долгов
    const debts = await query(
      `SELECT id, name as title, (amount - paid_amount) as amount, 'debt' as event_type, due_date as event_date, '#F44336' as color
       FROM debts
       WHERE user_id = ? AND is_active = 1 AND is_paid = 0 AND due_date >= ? AND due_date <= ?`,
      [req.user.id, start, end]
    );

    // Goals
    const goals = await query(
      `SELECT id, name as title, target_amount as amount, 'goal' as event_type, target_date as event_date, color
       FROM savings_goals
       WHERE user_id = ? AND is_active = 1 AND is_completed = 0 AND target_date >= ? AND target_date <= ?`,
      [req.user.id, start, end]
    );

    const allEvents = [
      ...events,
      ...recurring.map(e => ({ ...e, source: 'recurring', related_id: e.id, related_type: 'recurring' })),
      ...subscriptions.map(e => ({ ...e, source: 'subscription', related_id: e.id, related_type: 'subscription' })),
      ...debts.map(e => ({ ...e, source: 'debt', related_id: e.id, related_type: 'debt' })),
      ...goals.map(e => ({ ...e, source: 'goal', related_id: e.id, related_type: 'goal' }))
    ].sort((a, b) => new Date(a.event_date) - new Date(b.event_date));

    res.json(allEvents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Предстоящие события (7 дней)
router.get('/upcoming', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const events = await query(
      `SELECT * FROM calendar_events
       WHERE user_id = ? AND event_date >= ? AND event_date <= ? AND is_completed = 0
       ORDER BY event_date LIMIT 10`,
      [req.user.id, today, weekLater]
    );

    const recurring = await query(
      `SELECT id, description as title, amount, type, 'recurring' as event_type, next_execution_date as event_date
       FROM recurring_payments
       WHERE user_id = ? AND is_active = 1 AND next_execution_date >= ? AND next_execution_date <= ?`,
      [req.user.id, today, weekLater]
    );

    const subscriptions = await query(
      `SELECT id, name as title, amount, 'subscription' as event_type, next_billing_date as event_date
       FROM subscriptions
       WHERE user_id = ? AND is_active = 1 AND next_billing_date >= ? AND next_billing_date <= ?`,
      [req.user.id, today, weekLater]
    );

    const all = [...events, ...recurring, ...subscriptions]
      .sort((a, b) => new Date(a.event_date) - new Date(b.event_date))
      .slice(0, 10);

    res.json(all);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Создать событие
router.post('/events', async (req, res) => {
  try {
    const { title, description, event_type, amount, currency, event_date, end_date, is_recurring, recurrence_rule, reminder_enabled, reminder_days, color } = req.body;

    const result = await run(
      `INSERT INTO calendar_events (user_id, title, description, event_type, amount, currency, event_date, end_date, is_recurring, recurrence_rule, reminder_enabled, reminder_days, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, title, description, event_type, amount, currency || 'UAH', event_date, end_date, is_recurring ? 1 : 0, recurrence_rule, reminder_enabled !== false ? 1 : 0, reminder_days || 1, color || '#5D5CDE']
    );

    res.status(201).json({ id: result.id, message: 'Event created' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Обновить событие
router.put('/events/:id', async (req, res) => {
  try {
    const event = await get('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const { title, description, event_type, amount, currency, event_date, end_date, is_recurring, recurrence_rule, reminder_enabled, reminder_days, color, is_completed } = req.body;

    await run(
      `UPDATE calendar_events SET title = ?, description = ?, event_type = ?, amount = ?, currency = ?, event_date = ?, end_date = ?, is_recurring = ?, recurrence_rule = ?, reminder_enabled = ?, reminder_days = ?, color = ?, is_completed = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [title || event.title, description, event_type || event.event_type, amount, currency || event.currency, event_date || event.event_date, end_date, is_recurring !== undefined ? (is_recurring ? 1 : 0) : event.is_recurring, recurrence_rule, reminder_enabled !== undefined ? (reminder_enabled ? 1 : 0) : event.reminder_enabled, reminder_days || event.reminder_days, color || event.color, is_completed ? 1 : 0, is_completed ? new Date().toISOString() : null, req.params.id]
    );

    res.json({ message: 'Event updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Отметить выполненным
router.post('/events/:id/complete', async (req, res) => {
  try {
    await run(
      'UPDATE calendar_events SET is_completed = 1, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Event completed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Удалить событие
router.delete('/events/:id', async (req, res) => {
  try {
    await run('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Event deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Типы событий
router.get('/event-types', (req, res) => {
  res.json({
    'payment': 'Платёж',
    'income': 'Доход',
    'reminder': 'Напоминание',
    'goal': 'Цель',
    'debt': 'Долг',
    'subscription': 'Подписка',
    'recurring': 'Регулярный платёж',
    'other': 'Другое'
  });
});

module.exports = router;
