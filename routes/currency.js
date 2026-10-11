const express = require('express');
const passport = require('passport');
const Currency = require('../models/currency');
const Tag = require('../models/tag');
const currencyService = require('../services/currencyService');
const config = require('../config/config');
const { get } = require('../db/database');

const router = express.Router();
const authenticate = passport.authenticate('jwt', { session: false });

function isRateAdmin(user) {
  const email = String(user && user.email || '').toLowerCase();
  return Boolean(email) && config.adminEmails.includes(email);
}

async function ownsTransaction(transactionId, userId) {
  const row = await get(`SELECT id FROM transactions WHERE id = ? AND user_id = ?`, [transactionId, userId]);
  return Boolean(row);
}

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
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to fetch settings' });
  }
});

// Обновить настройки пользователя
router.put('/settings', authenticate, async (req, res) => {
  try {
    await Currency.updateUserSettings(req.user.id, req.body);
    const settings = await Currency.getUserSettings(req.user.id);
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error:', error);
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
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to fetch rates' });
  }
});

// Получить курс для пары валют
router.get('/rate/:from/:to', authenticate, async (req, res) => {
  try {
    const { from, to } = req.params;
    const found = await currencyService.rateOrFallback(from, to);

    if (!found) {
      return res.status(404).json({ error: true, code: 'RATE_NOT_FOUND', message: `No exchange rate ${String(from).toUpperCase()} → ${String(to).toUpperCase()}` });
    }

    res.json({ from: String(from).toUpperCase(), to: String(to).toUpperCase(), rate: found.rate, source: found.source });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to fetch rate' });
  }
});

// Конвертировать сумму
router.get('/convert', authenticate, async (req, res) => {
  try {
    const { amount, from, to } = req.query;

    if (amount === undefined || !from || !to) {
      return res.status(400).json({
        error: true,
        message: 'amount, from and to are required'
      });
    }

    // Нет курса -> 422 с понятным текстом (раньше фронт получал success:false
    // без result и падал на undefined.toFixed).
    const result = await currencyService.convert(amount, from, to);
    res.json(result);
  } catch (error) {
    if (error && error.isOperational) {
      return res.status(error.status).json({ error: true, code: error.code, message: error.message });
    }
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Conversion failed' });
  }
});

// Обновить курсы с НБУ
router.post('/fetch-nbu', authenticate, async (req, res) => {
  try {
    const result = await Currency.fetchRatesFromNBU();
    res.json(result);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to update rates' });
  }
});

// Установить курс вручную
router.post('/rate', authenticate, async (req, res) => {
  try {
    // currency_rates is one table for every user: a manual rate changes net
    // worth, forecasts and budgets of all accounts. Only operators listed in
    // ADMIN_EMAILS may write it.
    if (!isRateAdmin(req.user)) {
      return res.status(403).json({ error: true, message: 'Only an administrator can set exchange rates' });
    }
    const { from, to, rate, date } = req.body;
    const value = Number(rate);
    const code = /^[A-Z]{3,5}$/i;

    if (!from || !to || !code.test(from) || !code.test(to) || !Number.isFinite(value) || value <= 0) {
      return res.status(400).json({
        error: true,
        message: 'from, to (currency codes) and a positive rate are required'
      });
    }
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: true, message: 'date must be YYYY-MM-DD' });
    }

    await Currency.saveRate(from, to, value, 'manual', date);
    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error);
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
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to fetch history' });
  }
});

// ==================== ТЕГИ ====================

// Получить все теги пользователя
router.get('/tags', authenticate, async (req, res) => {
  try {
    const tags = await Tag.findByUserId(req.user.id);
    res.json(tags);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to fetch tags' });
  }
});

// Создать тег
router.post('/tags', authenticate, async (req, res) => {
  try {
    const { name, color } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: true, message: 'Tag name is required' });
    }

    const result = await Tag.create(req.user.id, name, color);

    if (result.error) {
      return res.status(400).json(result);
    }

    res.status(201).json({ success: true, tag: result });
  } catch (error) {
    console.error('Error:', error);
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

    const tag = await Tag.findById(req.params.id, req.user.id);
    if (!tag) {
      return res.status(404).json({ error: true, message: 'Tag not found' });
    }
    res.json({ success: true, tag });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to update tag' });
  }
});

// Удалить тег
router.delete('/tags/:id', authenticate, async (req, res) => {
  try {
    const success = await Tag.delete(req.params.id, req.user.id);

    if (!success) {
      return res.status(404).json({ error: true, message: 'Tag not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to delete tag' });
  }
});

// Получить статистику по тегу
router.get('/tags/:id/stats', authenticate, async (req, res) => {
  try {
    const stats = await Tag.getTagStats(req.params.id, req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to fetch statistics' });
  }
});

// Получить теги транзакции
router.get('/transaction/:transactionId/tags', authenticate, async (req, res) => {
  try {
    if (!(await ownsTransaction(req.params.transactionId, req.user.id))) {
      return res.status(404).json({ error: true, message: 'Transaction not found' });
    }
    const tags = await Tag.getTransactionTags(req.params.transactionId);
    res.json(tags);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to fetch tags' });
  }
});

// Установить теги для транзакции
router.put('/transaction/:transactionId/tags', authenticate, async (req, res) => {
  try {
    const { tagIds } = req.body;

    if (!Array.isArray(tagIds)) {
      return res.status(400).json({ error: true, message: 'tagIds must be an array' });
    }

    if (!(await ownsTransaction(req.params.transactionId, req.user.id))) {
      return res.status(404).json({ error: true, message: 'Transaction not found' });
    }
    await Tag.setTransactionTags(req.params.transactionId, tagIds, req.user.id);
    const tags = await Tag.getTransactionTags(req.params.transactionId);

    res.json({ success: true, tags });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Failed to set tags' });
  }
});

// Поиск тегов
router.get('/tags/search/:query', authenticate, async (req, res) => {
  try {
    const tags = await Tag.search(req.user.id, req.params.query);
    res.json(tags);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Search failed' });
  }
});

// Популярные теги
router.get('/tags/popular', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const tags = await Tag.getPopular(req.user.id, limit);
    res.json(tags);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: true, message: 'Error' });
  }
});

module.exports = router;
