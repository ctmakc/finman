const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');
const orgScope = require('../services/orgScope');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

async function scopeOf(req) {
  const ids = await orgScope.scopeUserIds(req.user);
  return { ids, ph: orgScope.placeholders(ids.length) };
}

// Получить текущий net worth
router.get('/current', async (req, res) => {
  try {
    const data = await calculateNetWorth(req.user);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// История net worth
router.get('/history', async (req, res) => {
  try {
    const { period } = req.query; // month, quarter, year, all
    let dateFilter = '';
    const now = new Date();

    switch (period) {
      case 'month':
        dateFilter = `AND snapshot_date >= date('now', '-1 month')`;
        break;
      case 'quarter':
        dateFilter = `AND snapshot_date >= date('now', '-3 months')`;
        break;
      case 'year':
        dateFilter = `AND snapshot_date >= date('now', '-1 year')`;
        break;
    }

    const { ids, ph } = await scopeOf(req);
    const snapshots = await query(
      `SELECT * FROM networth_snapshots WHERE user_id IN (${ph}) ${dateFilter} ORDER BY snapshot_date`,
      ids
    );

    res.json(snapshots.map(s => ({
      ...s,
      assets_breakdown: JSON.parse(s.assets_breakdown || '{}'),
      liabilities_breakdown: JSON.parse(s.liabilities_breakdown || '{}')
    })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Создать snapshot
router.post('/snapshot', async (req, res) => {
  try {
    const data = await calculateNetWorth(req.user);
    const { notes } = req.body;

    const result = await run(
      `INSERT INTO networth_snapshots (user_id, total_assets, total_liabilities, net_worth, assets_breakdown, liabilities_breakdown, snapshot_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, data.totalAssets, data.totalLiabilities, data.netWorth, JSON.stringify(data.assetsBreakdown), JSON.stringify(data.liabilitiesBreakdown), new Date().toISOString().split('T')[0], notes]
    );

    res.status(201).json({ id: result.id, message: 'Snapshot created', data });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Ручные активы
router.get('/assets', async (req, res) => {
  try {
    const { ids, ph } = await scopeOf(req);
    const assets = await query(`SELECT * FROM manual_assets WHERE user_id IN (${ph}) AND is_active = 1`, ids);
    res.json(assets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Добавить ручной актив
router.post('/assets', async (req, res) => {
  try {
    const { name, type, value, currency, purchase_date, purchase_price, description } = req.body;

    const result = await run(
      `INSERT INTO manual_assets (user_id, name, type, value, currency, purchase_date, purchase_price, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, name, type, value, currency || 'USD', purchase_date, purchase_price, description]
    );

    res.status(201).json({ id: result.id, message: 'Asset added' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Обновить актив
router.put('/assets/:id', async (req, res) => {
  try {
    const { ids, ph } = await scopeOf(req);
    const asset = await get(`SELECT * FROM manual_assets WHERE id = ? AND user_id IN (${ph})`, [req.params.id, ...ids]);
    if (!asset) return res.status(404).json({ message: 'Asset not found' });

    const { name, type, value, currency, purchase_date, purchase_price, description, is_active } = req.body;

    await run(
      `UPDATE manual_assets SET name = ?, type = ?, value = ?, currency = ?, purchase_date = ?, purchase_price = ?, description = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name || asset.name, type || asset.type, value || asset.value, currency || asset.currency, purchase_date, purchase_price, description, is_active !== undefined ? (is_active ? 1 : 0) : asset.is_active, req.params.id]
    );

    res.json({ message: 'Asset updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Удалить актив
router.delete('/assets/:id', async (req, res) => {
  try {
    const { ids, ph } = await scopeOf(req);
    await run(`DELETE FROM manual_assets WHERE id = ? AND user_id IN (${ph})`, [req.params.id, ...ids]);
    res.json({ message: 'Asset deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Типы активов
router.get('/asset-types', (req, res) => {
  res.json({
    'real_estate': 'Real Estate',
    'vehicle': 'Vehicle',
    'jewelry': 'Jewelry',
    'collectibles': 'Collectibles',
    'equipment': 'Equipment',
    'other': 'Other'
  });
});

// Вспомогательная функция расчёта net worth
async function calculateNetWorth(principal) {
  const ids = await orgScope.scopeUserIds(principal);
  const ph = orgScope.placeholders(ids.length);

  // Счета (активы) — across the whole org
  const accounts = await query(`SELECT SUM(balance) as total FROM accounts WHERE user_id IN (${ph})`, ids);
  const accountsTotal = accounts[0]?.total || 0;

  // Investments
  const investments = await query(
    `SELECT SUM(i.quantity * i.current_price) as total
     FROM investments i
     JOIN investment_portfolios p ON i.portfolio_id = p.id
     WHERE p.user_id IN (${ph}) AND i.is_active = 1`,
    ids
  );
  const investmentsTotal = investments[0]?.total || 0;

  // Goals накопления
  const goals = await query(`SELECT SUM(current_amount) as total FROM savings_goals WHERE user_id IN (${ph}) AND is_active = 1`, ids);
  const goalsTotal = goals[0]?.total || 0;

  // Ручные активы
  const manualAssets = await query(`SELECT SUM(value) as total FROM manual_assets WHERE user_id IN (${ph}) AND is_active = 1`, ids);
  const manualTotal = manualAssets[0]?.total || 0;

  // Debts (обязательства)
  const debts = await query(
    `SELECT SUM(amount - paid_amount) as total FROM debts WHERE user_id IN (${ph}) AND is_active = 1 AND type IN ('i_owe', 'credit', 'mortgage', 'loan')`,
    ids
  );
  const debtsTotal = debts[0]?.total || 0;

  const totalAssets = accountsTotal + investmentsTotal + goalsTotal + manualTotal;
  const totalLiabilities = debtsTotal;
  const netWorth = totalAssets - totalLiabilities;

  return {
    netWorth,
    totalAssets,
    totalLiabilities,
    assetsBreakdown: {
      accounts: { total: accountsTotal },
      investments: { total: investmentsTotal },
      manualAssets: { total: manualTotal },
      receivables: { total: goalsTotal }
    },
    liabilitiesBreakdown: {
      debts: debtsTotal
    },
    change: await calculateChange(ids, ph, netWorth)
  };
}

async function calculateChange(ids, ph, currentNetWorth) {
  const lastSnapshot = await get(
    `SELECT * FROM networth_snapshots WHERE user_id IN (${ph}) ORDER BY snapshot_date DESC LIMIT 1`,
    ids
  );

  if (!lastSnapshot) return { amount: 0, percent: 0 };

  const change = currentNetWorth - lastSnapshot.net_worth;
  const percent = lastSnapshot.net_worth !== 0 ? (change / Math.abs(lastSnapshot.net_worth)) * 100 : 0;

  return { amount: change, percent: Math.round(percent * 100) / 100, since: lastSnapshot.snapshot_date };
}

module.exports = router;
