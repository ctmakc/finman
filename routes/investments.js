// ==================== МАРШРУТЫ ИНВЕСТИЦИЙ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Investment = require('../models/investment');
const priceService = require('../services/priceService');
const { get } = require('../db/database');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// ---- Guards владения (закрывают IDOR на sub-resource роутах) ----
// :id = id портфеля.
async function ownPortfolio(req, res, next) {
  try {
    const portfolio = await Investment.findPortfolioById(req.params.id);
    if (!portfolio || Number(portfolio.user_id) !== Number(req.user.id)) {
      return res.status(404).json({ message: 'Портфель не найден' });
    }
    req.portfolio = portfolio;
    next();
  } catch (error) {
    console.error('Ошибка ownPortfolio:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
}

// :id = id актива -> его портфель -> владелец.
async function ownInvestment(req, res, next) {
  try {
    const inv = await get('SELECT portfolio_id FROM investments WHERE id = ?', [req.params.id]);
    if (!inv) return res.status(404).json({ message: 'Актив не найден' });
    const portfolio = await Investment.findPortfolioById(inv.portfolio_id);
    if (!portfolio || Number(portfolio.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ message: 'Нет доступа' });
    }
    next();
  } catch (error) {
    console.error('Ошибка ownInvestment:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
}

// ==================== ЖИВЫЕ ЦЕНЫ (Wave-2 price-feeds) ====================

// Обновить current_price всех активов пользователя по живым котировкам
// (Stooq, бесплатно). Деградирует мягко: недоступные символы помечаются,
// весь запрос не падает. После апдейта возвращаем свежую статистику с P&L.
router.post('/refresh-prices', async (req, res) => {
  try {
    const summary = await priceService.refreshUserPrices(req.user.id);
    const stats = await Investment.getUserStats(req.user.id);
    res.json({ ...summary, stats });
  } catch (error) {
    console.error('Ошибка обновления цен:', error);
    res.status(error.status || 500).json({ message: error.message || 'Ошибка сервера' });
  }
});

// Обновить цены активов конкретного портфеля (с проверкой владения).
router.post('/portfolios/:id/refresh-prices', async (req, res) => {
  try {
    const portfolio = await Investment.findPortfolioById(req.params.id);
    if (!portfolio || portfolio.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Портфель не найден' });
    }

    const summary = await priceService.refreshPortfolioPrices(req.params.id);
    const stats = await Investment.calculatePortfolioValue(req.params.id);
    res.json({ ...summary, stats });
  } catch (error) {
    console.error('Ошибка обновления цен:', error);
    res.status(error.status || 500).json({ message: error.message || 'Ошибка сервера' });
  }
});

// ==================== ПОРТФЕЛИ ====================

// Получить портфели
router.get('/portfolios', async (req, res) => {
  try {
    const portfolios = await Investment.findPortfoliosByUser(req.user.id);
    res.json(portfolios);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Статистика пользователя
router.get('/stats', async (req, res) => {
  try {
    const stats = await Investment.getUserStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Получить портфель
router.get('/portfolios/:id', async (req, res) => {
  try {
    const portfolio = await Investment.findPortfolioById(req.params.id);
    if (!portfolio || portfolio.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Портфель не найден' });
    }

    const stats = await Investment.calculatePortfolioValue(req.params.id);
    res.json({ ...portfolio, ...stats });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Создать портфель
router.post('/portfolios', async (req, res) => {
  try {
    const { name, description, currency } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Название обязательно' });
    }

    const portfolio = await Investment.createPortfolio({
      user_id: req.user.id,
      name, description, currency
    });

    res.status(201).json(portfolio);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Обновить портфель
router.put('/portfolios/:id', async (req, res) => {
  try {
    const portfolio = await Investment.findPortfolioById(req.params.id);
    if (!portfolio || portfolio.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Портфель не найден' });
    }

    const updated = await Investment.updatePortfolio(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Удалить портфель
router.delete('/portfolios/:id', async (req, res) => {
  try {
    const portfolio = await Investment.findPortfolioById(req.params.id);
    if (!portfolio || portfolio.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Портфель не найден' });
    }

    await Investment.deletePortfolio(req.params.id);
    res.json({ message: 'Портфель удалён' });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ==================== АКТИВЫ ====================

// Получить активы портфеля
router.get('/portfolios/:id/investments', ownPortfolio, async (req, res) => {
  try {
    const investments = await Investment.findByPortfolio(req.params.id);
    const withValues = await Promise.all(
      investments.map(inv => Investment.calculateValue(inv.id))
    );
    res.json(withValues.filter(v => v));
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Добавить актив
router.post('/portfolios/:id/investments', ownPortfolio, async (req, res) => {
  try {
    const { symbol, name, type, quantity, buy_price, currency, buy_date, notes, fee } = req.body;
    
    if (!symbol || !name || !type || !quantity || !buy_price || !buy_date) {
      return res.status(400).json({ message: 'Заполните обязательные поля' });
    }

    const investment = await Investment.addInvestment({
      portfolio_id: req.params.id,
      symbol, name, type, quantity, buy_price, currency, buy_date, notes, fee
    });

    res.status(201).json(investment);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Обновить актив
router.put('/investments/:id', ownInvestment, async (req, res) => {
  try {
    const updated = await Investment.updateInvestment(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Обновить цену
router.put('/investments/:id/price', ownInvestment, async (req, res) => {
  try {
    const { price } = req.body;
    if (!price) {
      return res.status(400).json({ message: 'Цена обязательна' });
    }

    const updated = await Investment.updatePrice(req.params.id, price);
    res.json(updated);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Продать актив
router.post('/investments/:id/sell', ownInvestment, async (req, res) => {
  try {
    const { quantity, price, fee, date } = req.body;
    
    if (!quantity || !price) {
      return res.status(400).json({ message: 'Количество и цена обязательны' });
    }

    const result = await Investment.sell(req.params.id, quantity, price, fee, date);
    res.json(result);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: error.message || 'Ошибка сервера' });
  }
});

// Получить транзакции актива
router.get('/investments/:id/transactions', ownInvestment, async (req, res) => {
  try {
    const transactions = await Investment.getTransactions(req.params.id);
    res.json(transactions);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Получить транзакции портфеля
router.get('/portfolios/:id/transactions', ownPortfolio, async (req, res) => {
  try {
    const transactions = await Investment.getPortfolioTransactions(req.params.id);
    res.json(transactions);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Типы активов
router.get('/types', (req, res) => {
  res.json(Investment.TYPES);
});

module.exports = router;
