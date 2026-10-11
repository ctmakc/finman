// ==================== МАРШРУТЫ УВЕДОМЛЕНИЙ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Notification = require('../models/notification');
const digestService = require('../services/digestService');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// ==================== ЕЖЕНЕДЕЛЬНАЯ СВОДКА (wave-2) ====================

// Отправить текущему пользователю его дайджест прямо сейчас.
// Создаёт in-app уведомление всегда (force), email — только если включён
// email_enabled и настроен RESEND_API_KEY (иначе тихий no-op).
// Уважает настройки: weekly_summary как флаг (но через ручной триггер
// строим всё равно, чтобы пользователь мог проверить), email_enabled — для письма.
// test-digest шлёт письмо на (непроверенный) email аккаунта: без лимита это
// рассыльщик спама с домена продукта. 3 письма в час на пользователя.
const DIGEST_TEST_LIMIT = 3;
const DIGEST_TEST_WINDOW_MS = 60 * 60 * 1000;
const digestTestHits = new Map();

router.post('/test-digest', async (req, res) => {
  try {
    const now = Date.now();
    const hits = (digestTestHits.get(req.user.id) || []).filter((t) => now - t < DIGEST_TEST_WINDOW_MS);
    if (hits.length >= DIGEST_TEST_LIMIT) {
      return res.status(429).json({ message: 'Too many test digests, try again later' });
    }
    hits.push(now);
    digestTestHits.set(req.user.id, hits);
    const result = await digestService.sendDigest(req.user.id, { force: true });
    res.json({
      success: true,
      digest: result.digest,
      subject: result.subject,
      notified: result.notified,
      notificationId: result.notificationId,
      emailed: result.emailed,
      email: result.email,
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

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
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить количество непрочитанных
router.get('/unread-count', async (req, res) => {
  try {
    const count = await Notification.getUnreadCount(req.user.id);
    res.json({ count });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить настройки
router.get('/settings', async (req, res) => {
  try {
    const settings = await Notification.getSettings(req.user.id);
    res.json(settings);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Обновить настройки
router.put('/settings', async (req, res) => {
  try {
    const settings = await Notification.updateSettings(req.user.id, req.body);
    res.json(settings);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Отметить как прочитанное
router.put('/:id(\\d+)/read', async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification || notification.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    const updated = await Notification.markAsRead(req.params.id);
    res.json(updated);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Отметить все как прочитанные
router.put('/read-all', async (req, res) => {
  try {
    await Notification.markAllAsRead(req.user.id);
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Удалить уведомление
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification || notification.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    await Notification.delete(req.params.id);
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Очистить старые уведомления
router.delete('/old', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    await Notification.deleteOld(req.user.id, days);
    res.json({ message: 'Old notifications deleted' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
