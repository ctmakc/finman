// ==================== МОДЕЛЬ ИНВЕСТИЦИЙ ====================

const { query, get, run } = require('../db/database');

const Investment = {
  // Типы активов
  TYPES: {
    STOCK: 'stock',       // Акции
    ETF: 'etf',           // ETF
    BOND: 'bond',         // Облигации
    CRYPTO: 'crypto',     // Криптовалюта
    FUND: 'fund',         // Фонды
    COMMODITY: 'commodity', // Товары (золото, нефть)
    OTHER: 'other'
  },

  // Типы транзакций
  TX_TYPES: {
    BUY: 'buy',
    SELL: 'sell',
    DIVIDEND: 'dividend',
    SPLIT: 'split',
    TRANSFER: 'transfer'
  },

  // ==================== ПОРТФЕЛИ ====================

  // Создание портфеля
  async createPortfolio(data) {
    const result = await run(
      `INSERT INTO investment_portfolios (user_id, name, description, currency)
       VALUES (?, ?, ?, ?)`,
      [data.user_id, data.name, data.description, data.currency || 'USD']
    );
    return this.findPortfolioById(result.id);
  },

  // Получить портфель по ID
  async findPortfolioById(id) {
    return get('SELECT * FROM investment_portfolios WHERE id = ?', [id]);
  },

  // Получить портфели пользователя
  async findPortfoliosByUser(userId) {
    return query(
      'SELECT * FROM investment_portfolios WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC',
      [userId]
    );
  },

  // Обновить портфель
  async updatePortfolio(id, data) {
    const fields = [];
    const values = [];

    ['name', 'description', 'is_active'].forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    });

    if (fields.length === 0) return this.findPortfolioById(id);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await run(`UPDATE investment_portfolios SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findPortfolioById(id);
  },

  // Удалить портфель
  async deletePortfolio(id) {
    return run('UPDATE investment_portfolios SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  // ==================== АКТИВЫ ====================

  // Добавить актив
  async addInvestment(data) {
    const result = await run(
      `INSERT INTO investments (portfolio_id, symbol, name, type, quantity, buy_price, current_price, currency, buy_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.portfolio_id, data.symbol.toUpperCase(), data.name, data.type,
       data.quantity, data.buy_price, data.current_price || data.buy_price,
       data.currency || 'USD', data.buy_date, data.notes]
    );

    // Записываем транзакцию покупки
    await this.addTransaction({
      investment_id: result.id,
      type: 'buy',
      quantity: data.quantity,
      price: data.buy_price,
      fee: data.fee || 0,
      date: data.buy_date
    });

    return this.findInvestmentById(result.id);
  },

  // Получить актив по ID
  async findInvestmentById(id) {
    return get('SELECT * FROM investments WHERE id = ?', [id]);
  },

  // Получить активы портфеля
  async findByPortfolio(portfolioId, includeInactive = false) {
    const sql = includeInactive
      ? 'SELECT * FROM investments WHERE portfolio_id = ? ORDER BY symbol ASC'
      : 'SELECT * FROM investments WHERE portfolio_id = ? AND is_active = 1 ORDER BY symbol ASC';
    return query(sql, [portfolioId]);
  },

  // Обновить актив
  async updateInvestment(id, data) {
    const fields = [];
    const values = [];

    ['name', 'quantity', 'current_price', 'notes', 'is_active'].forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    });

    if (fields.length === 0) return this.findInvestmentById(id);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await run(`UPDATE investments SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findInvestmentById(id);
  },

  // Обновить текущую цену
  async updatePrice(id, price) {
    await run(
      'UPDATE investments SET current_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [price, id]
    );
    return this.findInvestmentById(id);
  },

  // Массовое обновление цен по символу
  async updatePriceBySymbol(symbol, price, currency = 'USD') {
    const date = new Date().toISOString().split('T')[0];

    // Обновляем текущую цену активов
    await run(
      'UPDATE investments SET current_price = ?, updated_at = CURRENT_TIMESTAMP WHERE symbol = ? AND currency = ?',
      [price, symbol.toUpperCase(), currency]
    );

    // Сохраняем в историю цен
    await run(
      `INSERT OR REPLACE INTO investment_prices (symbol, price, currency, date)
       VALUES (?, ?, ?, ?)`,
      [symbol.toUpperCase(), price, currency, date]
    );
  },

  // Продать актив
  async sell(investmentId, quantity, price, fee = 0, date = null) {
    const investment = await this.findInvestmentById(investmentId);
    if (!investment) throw new Error('Asset not found');
    if (investment.quantity < quantity) throw new Error('Insufficient assets to sell');

    const sellDate = date || new Date().toISOString().split('T')[0];

    // Записываем транзакцию продажи
    await this.addTransaction({
      investment_id: investmentId,
      type: 'sell',
      quantity,
      price,
      fee,
      date: sellDate
    });

    // Обновляем количество
    const newQuantity = investment.quantity - quantity;

    if (newQuantity === 0) {
      await run('UPDATE investments SET quantity = 0, is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [investmentId]);
    } else {
      await run('UPDATE investments SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newQuantity, investmentId]);
    }

    return this.findInvestmentById(investmentId);
  },

  // ==================== ТРАНЗАКЦИИ ====================

  // Добавить транзакцию
  async addTransaction(data) {
    const result = await run(
      `INSERT INTO investment_transactions (investment_id, type, quantity, price, fee, date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.investment_id, data.type, data.quantity, data.price, data.fee || 0, data.date, data.notes]
    );
    return get('SELECT * FROM investment_transactions WHERE id = ?', [result.id]);
  },

  // Получить транзакции актива
  async getTransactions(investmentId) {
    return query(
      'SELECT * FROM investment_transactions WHERE investment_id = ? ORDER BY date DESC',
      [investmentId]
    );
  },

  // Получить все транзакции портфеля
  async getPortfolioTransactions(portfolioId) {
    return query(
      `SELECT it.*, i.symbol, i.name as investment_name
       FROM investment_transactions it
       INNER JOIN investments i ON it.investment_id = i.id
       WHERE i.portfolio_id = ?
       ORDER BY it.date DESC`,
      [portfolioId]
    );
  },

  // ==================== АНАЛИТИКА ====================

  // Рассчитать стоимость актива
  async calculateValue(investmentId) {
    const investment = await this.findInvestmentById(investmentId);
    if (!investment) return null;

    const currentValue = investment.quantity * investment.current_price;
    const buyValue = investment.quantity * investment.buy_price;
    const profitLoss = currentValue - buyValue;
    const profitLossPercent = buyValue > 0 ? (profitLoss / buyValue) * 100 : 0;

    return {
      ...investment,
      currentValue,
      buyValue,
      profitLoss,
      profitLossPercent: Math.round(profitLossPercent * 100) / 100
    };
  },

  // Рассчитать стоимость портфеля
  async calculatePortfolioValue(portfolioId) {
    const investments = await this.findByPortfolio(portfolioId);

    let totalValue = 0;
    let totalCost = 0;
    const holdings = [];

    for (const inv of investments) {
      const value = inv.quantity * inv.current_price;
      const cost = inv.quantity * inv.buy_price;
      const profitLoss = value - cost;
      const profitLossPercent = cost > 0 ? (profitLoss / cost) * 100 : 0;

      totalValue += value;
      totalCost += cost;

      holdings.push({
        ...inv,
        currentValue: value,
        buyValue: cost,
        profitLoss,
        profitLossPercent: Math.round(profitLossPercent * 100) / 100,
        weight: 0 // Будет рассчитано после
      });
    }

    // Рассчитываем веса
    holdings.forEach(h => {
      h.weight = totalValue > 0 ? Math.round((h.currentValue / totalValue) * 10000) / 100 : 0;
    });

    const totalProfitLoss = totalValue - totalCost;
    const totalProfitLossPercent = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0;

    return {
      portfolioId,
      totalValue: Math.round(totalValue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalProfitLoss: Math.round(totalProfitLoss * 100) / 100,
      totalProfitLossPercent: Math.round(totalProfitLossPercent * 100) / 100,
      holdings,
      byType: this.groupByType(holdings)
    };
  },

  // Группировка по типу
  groupByType(holdings) {
    const byType = {};

    holdings.forEach(h => {
      if (!byType[h.type]) {
        byType[h.type] = { value: 0, cost: 0, count: 0 };
      }
      byType[h.type].value += h.currentValue;
      byType[h.type].cost += h.buyValue;
      byType[h.type].count++;
    });

    return byType;
  },

  // Получить историю цен
  async getPriceHistory(symbol, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return query(
      `SELECT * FROM investment_prices
       WHERE symbol = ? AND date >= ?
       ORDER BY date ASC`,
      [symbol.toUpperCase(), startDate.toISOString().split('T')[0]]
    );
  },

  // Статистика пользователя
  async getUserStats(userId) {
    const portfolios = await this.findPortfoliosByUser(userId);

    let totalValue = 0;
    let totalCost = 0;
    let portfolioStats = [];

    for (const portfolio of portfolios) {
      const stats = await this.calculatePortfolioValue(portfolio.id);
      totalValue += stats.totalValue;
      totalCost += stats.totalCost;
      portfolioStats.push({ ...portfolio, ...stats });
    }

    const totalProfitLoss = totalValue - totalCost;
    const totalProfitLossPercent = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0;

    return {
      portfolioCount: portfolios.length,
      totalValue: Math.round(totalValue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalProfitLoss: Math.round(totalProfitLoss * 100) / 100,
      totalProfitLossPercent: Math.round(totalProfitLossPercent * 100) / 100,
      portfolios: portfolioStats
    };
  }
};

module.exports = Investment;
