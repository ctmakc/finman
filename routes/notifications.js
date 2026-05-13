// ==================== МАРШРУТЫ УВЕДОМЛЕНИЙ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Notification = require('../models/notification');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Получить уведомления
router.get('/', async (req, res) => {
  try {
    const { limit, offset, unreadOnly, type } = req.query;
    const notifications = await Notification.findByUser(req.user.id, {
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      unreadOnly: unreadOnly === 'true',
      type
    });
    res.json(notifications);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить количество непрочитанных
router.get('/unread-count', async (req, res) => {
  try {
    const count = await Notification.getUnreadCount(req.user.id);
    res.json({ count });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить настройки
router.get('/settings', async (req, res) => {
  try {
    const settings = await Notification.getSettings(req.user.id);
    res.json(settings);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Обновить настройки
router.put('/settings', async (req, res) => {
  try {
    const settings = await Notification.updateSettings(req.user.id, req.body);
    res.json(settings);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Отметить как прочитанное
router.put('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification || notification.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Уведомление не найдено' });
    }

    const updated = await Notification.markAsRead(req.params.id);
    res.json(updated);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Отметить все как прочитанные
router.put('/read-all', async (req, res) => {
  try {
    await Notification.markAllAsRead(req.user.id);
    res.json({ message: 'Все уведомления прочитаны' });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Удалить уведомление
router.delete('/:id', async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification || notification.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Уведомление не найдено' });
    }

    await Notification.delete(req.params.id);
    res.json({ message: 'Уведомление удалено' });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Очистить старые уведомления
router.delete('/old', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    await Notification.deleteOld(req.user.id, days);
    res.json({ message: 'Старые уведомления удалены' });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
