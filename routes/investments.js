// ==================== МАРШРУТЫ ИНВЕСТИЦИЙ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Investment = require('../models/investment');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

async function requirePortfolioOwner(portfolioId, userId) {
  const portfolio = await Investment.findPortfolioById(portfolioId);
  if (!portfolio || portfolio.user_id !== userId) return null;
  return portfolio;
}

async function requireInvestmentOwner(investmentId, userId) {
  const inv = await Investment.findInvestmentById(investmentId);
  if (!inv) return null;
  const portfolio = await Investment.findPortfolioById(inv.portfolio_id);
  if (!portfolio || portfolio.user_id !== userId) return null;
  return inv;
}

// ==================== ПОРТФЕЛИ ====================

router.get('/portfolios', async (req, res) => {
  try {
    const portfolios = await Investment.findPortfoliosByUser(req.user.id);
    res.json(portfolios);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await Investment.getUserStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/portfolios/:id', async (req, res) => {
  try {
    const portfolio = await requirePortfolioOwner(req.params.id, req.user.id);
    if (!portfolio) return res.status(404).json({ message: 'Portfolio not found' });
    const stats = await Investment.calculatePortfolioValue(req.params.id);
    res.json({ ...portfolio, ...stats });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/portfolios', async (req, res) => {
  try {
    const { name, description, currency } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    const portfolio = await Investment.createPortfolio({ user_id: req.user.id, name, description, currency });
    res.status(201).json(portfolio);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/portfolios/:id', async (req, res) => {
  try {
    if (!await requirePortfolioOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Portfolio not found' });
    }
    const updated = await Investment.updatePortfolio(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/portfolios/:id', async (req, res) => {
  try {
    if (!await requirePortfolioOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Portfolio not found' });
    }
    await Investment.deletePortfolio(req.params.id);
    res.json({ message: 'Portfolio deleted' });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== АКТИВЫ ====================

router.get('/portfolios/:id/investments', async (req, res) => {
  try {
    if (!await requirePortfolioOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Portfolio not found' });
    }
    const investments = await Investment.findByPortfolio(req.params.id);
    const withValues = await Promise.all(investments.map(inv => Investment.calculateValue(inv.id)));
    res.json(withValues.filter(v => v));
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/portfolios/:id/investments', async (req, res) => {
  try {
    if (!await requirePortfolioOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Portfolio not found' });
    }
    const { symbol, name, type, quantity, buy_price, currency, buy_date, notes, fee } = req.body;
    if (!symbol || !name || !type || !quantity || !buy_price || !buy_date) {
      return res.status(400).json({ message: 'Required fields are missing' });
    }
    const investment = await Investment.addInvestment({ portfolio_id: req.params.id, symbol, name, type, quantity, buy_price, currency, buy_date, notes, fee });
    res.status(201).json(investment);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/investments/:id', async (req, res) => {
  try {
    if (!await requireInvestmentOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Investment not found' });
    }
    const updated = await Investment.updateInvestment(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/investments/:id/price', async (req, res) => {
  try {
    if (!await requireInvestmentOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Investment not found' });
    }
    const { price } = req.body;
    if (!price) return res.status(400).json({ message: 'Price is required' });
    const updated = await Investment.updatePrice(req.params.id, price);
    res.json(updated);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/investments/:id/sell', async (req, res) => {
  try {
    if (!await requireInvestmentOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Investment not found' });
    }
    const { quantity, price, fee, date } = req.body;
    if (!quantity || !price) return res.status(400).json({ message: 'Quantity and price are required' });
    const result = await Investment.sell(req.params.id, quantity, price, fee, date);
    res.json(result);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: error.message || 'Server error' });
  }
});

router.get('/investments/:id/transactions', async (req, res) => {
  try {
    if (!await requireInvestmentOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Investment not found' });
    }
    const transactions = await Investment.getTransactions(req.params.id);
    res.json(transactions);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/portfolios/:id/transactions', async (req, res) => {
  try {
    if (!await requirePortfolioOwner(req.params.id, req.user.id)) {
      return res.status(404).json({ message: 'Portfolio not found' });
    }
    const transactions = await Investment.getPortfolioTransactions(req.params.id);
    res.json(transactions);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/types', (req, res) => {
  res.json(Investment.TYPES);
});

module.exports = router;
