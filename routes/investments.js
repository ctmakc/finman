// ==================== МАРШРУТЫ ИНВЕСТИЦИЙ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Investment = require('../models/investment');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// ==================== ПОРТФЕЛИ ====================

// Получить портфели
router.get('/portfolios', async (req, res) => {
  try {
    const portfolios = await Investment.findPortfoliosByUser(req.user.id);
    res.json(portfolios);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Статистика пользователя
router.get('/stats', async (req, res) => {
  try {
    const stats = await Investment.getUserStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
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
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
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
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
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
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
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
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== АКТИВЫ ====================

// Получить активы портфеля
router.get('/portfolios/:id/investments', async (req, res) => {
  try {
    const investments = await Investment.findByPortfolio(req.params.id);
    const withValues = await Promise.all(
      investments.map(inv => Investment.calculateValue(inv.id))
    );
    res.json(withValues.filter(v => v));
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Добавить актив
router.post('/portfolios/:id/investments', async (req, res) => {
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
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Обновить актив
router.put('/investments/:id', async (req, res) => {
  try {
    const updated = await Investment.updateInvestment(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Обновить цену
router.put('/investments/:id/price', async (req, res) => {
  try {
    const { price } = req.body;
    if (!price) {
      return res.status(400).json({ message: 'Цена обязательна' });
    }

    const updated = await Investment.updatePrice(req.params.id, price);
    res.json(updated);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Продать актив
router.post('/investments/:id/sell', async (req, res) => {
  try {
    const { quantity, price, fee, date } = req.body;
    
    if (!quantity || !price) {
      return res.status(400).json({ message: 'Количество и цена обязательны' });
    }

    const result = await Investment.sell(req.params.id, quantity, price, fee, date);
    res.json(result);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: error.message || 'Server error' });
  }
});

// Получить транзакции актива
router.get('/investments/:id/transactions', async (req, res) => {
  try {
    const transactions = await Investment.getTransactions(req.params.id);
    res.json(transactions);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить транзакции портфеля
router.get('/portfolios/:id/transactions', async (req, res) => {
  try {
    const transactions = await Investment.getPortfolioTransactions(req.params.id);
    res.json(transactions);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Типы активов
router.get('/types', (req, res) => {
  res.json(Investment.TYPES);
});

module.exports = router;
