const express = require('express');
const passport = require('passport');
const Currency = require('../models/currency');
const Tag = require('../models/tag');

const router = express.Router();
const authenticate = passport.authenticate('jwt', { session: false });

// ==================== ВАЛЮТЫ ====================

// Получить список поддерживаемых валют
router.get('/supported', authenticate, (req, res) => {
  res.json(Currency.getSupportedCurrencies());
});

// Получить настройки пользователя
router.get('/settings', authenticate, async (req, res) => {
  try {
    const settings = await Currency.getUserSettings(req.user.id);
    res.json(settings);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to get settings' });
  }
});

// Обновить настройки пользователя
router.put('/settings', authenticate, async (req, res) => {
  try {
    await Currency.updateUserSettings(req.user.id, req.body);
    const settings = await Currency.getUserSettings(req.user.id);
    res.json({ success: true, settings });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to update settings' });
  }
});

// Получить текущие курсы
router.get('/rates', authenticate, async (req, res) => {
  try {
    const { base } = req.query;
    const settings = await Currency.getUserSettings(req.user.id);
    const baseCurrency = base || settings.base_currency;

    const rates = await Currency.getRatesForCurrency(baseCurrency);
    res.json({ base: baseCurrency, rates });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to get rates' });
  }
});

// Получить курс для пары валют
router.get('/rate/:from/:to', authenticate, async (req, res) => {
  try {
    const { from, to } = req.params;
    const rate = await Currency.getRate(from, to);

    if (rate === null) {
      return res.status(404).json({ error: true, message: 'Курс не найден' });
    }

    res.json({ from, to, rate });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to get rate' });
  }
});

// Конвертировать сумму
router.get('/convert', authenticate, async (req, res) => {
  try {
    const { amount, from, to } = req.query;

    if (!amount || !from || !to) {
      return res.status(400).json({
        error: true,
        message: 'Укажите amount, from и to'
      });
    }

    const result = await Currency.convert(parseFloat(amount), from, to);
    res.json(result);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Conversion error' });
  }
});

// Обновить курсы с НБУ
router.post('/fetch-nbu', authenticate, async (req, res) => {
  try {
    const result = await Currency.fetchRatesFromNBU();
    res.json(result);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to update rates' });
  }
});

// Установить курс вручную
router.post('/rate', authenticate, async (req, res) => {
  try {
    const { from, to, rate, date } = req.body;

    if (!from || !to || !rate) {
      return res.status(400).json({
        error: true,
        message: 'Укажите from, to и rate'
      });
    }

    await Currency.saveRate(from, to, parseFloat(rate), 'manual', date);
    res.json({ success: true });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to save rate' });
  }
});

// История курсов
router.get('/history/:from/:to', authenticate, async (req, res) => {
  try {
    const { from, to } = req.params;
    const days = parseInt(req.query.days) || 30;

    const history = await Currency.getRateHistory(from, to, days);
    res.json(history);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to get history' });
  }
});

// ==================== ТЕГИ ====================

// Получить все теги пользователя
router.get('/tags', authenticate, async (req, res) => {
  try {
    const tags = await Tag.findByUserId(req.user.id);
    res.json(tags);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to get tags' });
  }
});

// Создать тег
router.post('/tags', authenticate, async (req, res) => {
  try {
    const { name, color } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: true, message: 'Укажите название тега' });
    }

    const result = await Tag.create(req.user.id, name, color);

    if (result.error) {
      return res.status(400).json(result);
    }

    res.status(201).json({ success: true, tag: result });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to create tag' });
  }
});

// Обновить тег
router.put('/tags/:id', authenticate, async (req, res) => {
  try {
    const result = await Tag.update(req.params.id, req.user.id, req.body);

    if (result?.error) {
      return res.status(400).json(result);
    }

    const tag = await Tag.findById(req.params.id);
    res.json({ success: true, tag });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to update tag' });
  }
});

// Удалить тег
router.delete('/tags/:id', authenticate, async (req, res) => {
  try {
    const success = await Tag.delete(req.params.id, req.user.id);

    if (!success) {
      return res.status(404).json({ error: true, message: 'Тег не найден' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to delete tag' });
  }
});

// Получить статистику по тегу
router.get('/tags/:id/stats', authenticate, async (req, res) => {
  try {
    const stats = await Tag.getTagStats(req.params.id, req.user.id);
    res.json(stats);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to get stats' });
  }
});

// Получить теги транзакции
router.get('/transaction/:transactionId/tags', authenticate, async (req, res) => {
  try {
    const tags = await Tag.getTransactionTags(req.params.transactionId);
    res.json(tags);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to get tags' });
  }
});

// Установить теги для транзакции
router.put('/transaction/:transactionId/tags', authenticate, async (req, res) => {
  try {
    const { tagIds } = req.body;

    if (!Array.isArray(tagIds)) {
      return res.status(400).json({ error: true, message: 'tagIds должен быть массивом' });
    }

    await Tag.setTransactionTags(req.params.transactionId, tagIds);
    const tags = await Tag.getTransactionTags(req.params.transactionId);

    res.json({ success: true, tags });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Failed to set tags' });
  }
});

// Поиск тегов
router.get('/tags/search/:query', authenticate, async (req, res) => {
  try {
    const tags = await Tag.search(req.user.id, req.params.query);
    res.json(tags);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Error поиска' });
  }
});

// Популярные теги
router.get('/tags/popular', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const tags = await Tag.getPopular(req.user.id, limit);
    res.json(tags);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ error: true, message: 'Error' });
  }
});

module.exports = router;
