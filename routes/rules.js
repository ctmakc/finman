// routes/rules.js — CRUD правил категоризации + применение их к транзакциям.
// Стиль соответствует другим legacy-роутерам (passport jwt + res.json).
// НЕ смонтирован здесь: Integrator добавит app.use('/api/rules', rulesRoutes).
const express = require('express');
const passport = require('passport');
const CategoryRule = require('../models/categoryRule');
const rulesEngine = require('../services/rulesEngine');

const router = express.Router();

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Список правил пользователя (в порядке приоритета)
router.get('/', async (req, res) => {
  try {
    const rules = await CategoryRule.findByUserId(req.user.id);
    res.json(rules);
  } catch (error) {
    console.error('Ошибка при получении правил:', error);
    res.status(500).json({ error: true, message: 'Не удалось получить правила' });
  }
});

// Создать правило
router.post('/', async (req, res) => {
  try {
    const { priority, match_field, match_op, match_value, set_category, is_active } = req.body;
    const result = await CategoryRule.create(req.user.id, {
      priority,
      match_field,
      match_op,
      match_value,
      set_category,
      is_active,
    });
    if (result && result.error) {
      return res.status(400).json({ error: true, message: result.message });
    }
    res.status(201).json(result);
  } catch (error) {
    console.error('Ошибка при создании правила:', error);
    res.status(500).json({ error: true, message: 'Не удалось создать правило' });
  }
});

// Применить активные правила к некатегоризированным расходам.
// ВАЖНО: объявлено ДО '/:id', чтобы 'apply' не перехватывался как id.
router.post('/apply', async (req, res) => {
  try {
    const dryRun = req.body && (req.body.dryRun === true || req.body.preview === true);
    const result = await rulesEngine.applyToUncategorized(req.user.id, { dryRun });
    res.json(result);
  } catch (error) {
    console.error('Ошибка при применении правил:', error);
    res.status(500).json({ error: true, message: 'Не удалось применить правила' });
  }
});

// Получить одно правило
router.get('/:id', async (req, res) => {
  try {
    const rule = await CategoryRule.findById(req.params.id, req.user.id);
    if (!rule) return res.status(404).json({ error: true, message: 'Правило не найдено' });
    res.json(rule);
  } catch (error) {
    console.error('Ошибка при получении правила:', error);
    res.status(500).json({ error: true, message: 'Не удалось получить правило' });
  }
});

// Обновить правило
router.put('/:id', async (req, res) => {
  try {
    const { priority, match_field, match_op, match_value, set_category, is_active } = req.body;
    const result = await CategoryRule.update(req.params.id, req.user.id, {
      priority,
      match_field,
      match_op,
      match_value,
      set_category,
      is_active,
    });
    if (result === null) {
      return res.status(404).json({ error: true, message: 'Правило не найдено' });
    }
    if (result && result.error) {
      return res.status(400).json({ error: true, message: result.message });
    }
    res.json(result);
  } catch (error) {
    console.error('Ошибка при обновлении правила:', error);
    res.status(500).json({ error: true, message: 'Не удалось обновить правило' });
  }
});

// Удалить правило
router.delete('/:id', async (req, res) => {
  try {
    const ok = await CategoryRule.delete(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ error: true, message: 'Правило не найдено' });
    res.json({ success: true, message: 'Правило удалено' });
  } catch (error) {
    console.error('Ошибка при удалении правила:', error);
    res.status(500).json({ error: true, message: 'Не удалось удалить правило' });
  }
});

module.exports = router;
