// ==================== МОДЕЛЬ ИНВЕСТИЦИЙ ====================

const { query, get, run } = require('../db/database');
const money = require('../lib/money');

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

  // Типы событий по активу (investment depth — migration 015).
  // Хранятся в investment_events, не меняют количество актива:
  //  - dividend: полученные дивиденды (увеличивают чистый P&L);
  //  - fee: дополнительные комиссии/налоги (уменьшают чистый P&L);
  //  - split: информационное событие (для истории; на деньги не влияет).
  EVENT_TYPES: {
    DIVIDEND: 'dividend',
    FEE: 'fee',
    SPLIT: 'split'
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
    if (!investment) throw new Error('Актив не найден');
    if (investment.quantity < quantity) throw new Error('Недостаточно активов для продажи');

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

    // Обновляем количество (округляем до 2 знаков, чтобы не копить float-дрейф)
    const newQuantity = money.round(investment.quantity - quantity);

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

  // ==================== СОБЫТИЯ ПО АКТИВУ (investment depth) ====================

  // Добавить событие (dividend / fee / split) по активу.
  // amount хранится как положительная величина; знак в P&L задаёт тип события.
  async addEvent(data) {
    const type = data.type;
    if (!Object.values(this.EVENT_TYPES).includes(type)) {
      throw new Error('Неизвестный тип события');
    }
    const date = data.date || new Date().toISOString().split('T')[0];
    // Нормализуем сумму до 2 знаков и берём модуль (направление — от типа).
    const amount = Math.abs(money.round(data.amount));
    const result = await run(
      `INSERT INTO investment_events (investment_id, type, amount, date, note)
       VALUES (?, ?, ?, ?, ?)`,
      [data.investment_id, type, amount, date, data.note || null]
    );
    return get('SELECT * FROM investment_events WHERE id = ?', [result.id]);
  },

  // Получить события актива (свежие сверху).
  async getEvents(investmentId) {
    return query(
      'SELECT * FROM investment_events WHERE investment_id = ? ORDER BY date DESC, id DESC',
      [investmentId]
    );
  },

  // Агрегаты событий по активу: суммарные дивиденды и суммарные event-комиссии.
  // split-события на деньги не влияют (информационные).
  async getEventTotals(investmentId) {
    const row = await get(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'dividend' THEN amount ELSE 0 END), 0) AS dividends,
         COALESCE(SUM(CASE WHEN type = 'fee'      THEN amount ELSE 0 END), 0) AS event_fees
       FROM investment_events WHERE investment_id = ?`,
      [investmentId]
    );
    return {
      dividends: money.round(row ? row.dividends : 0),
      eventFees: money.round(row ? row.event_fees : 0)
    };
  },

  // ==================== АНАЛИТИКА ====================

  // Суммарные комиссии по активу (по всем его транзакциям).
  async getTotalFees(investmentId) {
    const row = await get(
      `SELECT COALESCE(SUM(fee), 0) as total_fees
       FROM investment_transactions WHERE investment_id = ?`,
      [investmentId]
    );
    return money.round(row ? row.total_fees : 0);
  },

  // Рассчитать стоимость актива.
  // P&L учитывает комиссии: чистая прибыль = (рыночная стоимость - стоимость
  // покупки) - суммарные комиссии по сделкам.
  async calculateValue(investmentId) {
    const investment = await this.findInvestmentById(investmentId);
    if (!investment) return null;

    const fees = await this.getTotalFees(investmentId);

    const currentValue = money.mul(investment.quantity, investment.current_price);
    const buyValue = money.mul(investment.quantity, investment.buy_price);
    // Чистый P&L за вычетом комиссий по сделкам (как раньше — НЕ менять).
    const profitLoss = money.sub(money.sub(currentValue, buyValue), fees);
    const profitLossPercent = buyValue > 0 ? money.round((profitLoss / buyValue) * 100) : 0;

    // Investment depth: дивиденды повышают чистый P&L, event-комиссии понижают.
    const { dividends, eventFees } = await this.getEventTotals(investmentId);
    // netProfitLoss = profitLoss + дивиденды - event-комиссии.
    const netProfitLoss = money.sub(money.add(profitLoss, dividends), eventFees);
    const netProfitLossPercent = buyValue > 0 ? money.round((netProfitLoss / buyValue) * 100) : 0;

    return {
      ...investment,
      currentValue,
      buyValue,
      fees,
      profitLoss,
      profitLossPercent,
      // Новые depth-поля (ADDITIVE):
      dividends,
      eventFees,
      netProfitLoss,
      netProfitLossPercent
    };
  },

  // Рассчитать стоимость портфеля
  async calculatePortfolioValue(portfolioId) {
    const investments = await this.findByPortfolio(portfolioId);

    let totalValue = 0;
    let totalCost = 0;
    let totalFees = 0;
    let totalDividends = 0;
    let totalEventFees = 0;
    const holdings = [];

    for (const inv of investments) {
      const fees = await this.getTotalFees(inv.id);
      const value = money.mul(inv.quantity, inv.current_price);
      const cost = money.mul(inv.quantity, inv.buy_price);
      // Чистый P&L за вычетом комиссий по сделкам (как раньше — НЕ менять).
      const profitLoss = money.sub(money.sub(value, cost), fees);
      const profitLossPercent = cost > 0 ? money.round((profitLoss / cost) * 100) : 0;

      // Investment depth: дивиденды/event-комиссии по этому активу.
      const { dividends, eventFees } = await this.getEventTotals(inv.id);
      const netProfitLoss = money.sub(money.add(profitLoss, dividends), eventFees);

      totalValue = money.add(totalValue, value);
      totalCost = money.add(totalCost, cost);
      totalFees = money.add(totalFees, fees);
      totalDividends = money.add(totalDividends, dividends);
      totalEventFees = money.add(totalEventFees, eventFees);

      holdings.push({
        ...inv,
        currentValue: value,
        buyValue: cost,
        fees,
        profitLoss,
        profitLossPercent,
        dividends,
        eventFees,
        netProfitLoss,
        weight: 0 // Будет рассчитано после
      });
    }

    // Рассчитываем веса
    holdings.forEach(h => {
      h.weight = totalValue > 0 ? Math.round((h.currentValue / totalValue) * 10000) / 100 : 0;
    });

    // Чистая прибыль портфеля учитывает комиссии по сделкам (как раньше).
    const totalProfitLoss = money.sub(money.sub(totalValue, totalCost), totalFees);
    const totalProfitLossPercent = totalCost > 0 ? money.round((totalProfitLoss / totalCost) * 100) : 0;

    // Чистый P&L с учётом дивидендов и event-комиссий (investment depth).
    const totalNetProfitLoss = money.sub(money.add(totalProfitLoss, totalDividends), totalEventFees);
    const totalNetProfitLossPercent = totalCost > 0 ? money.round((totalNetProfitLoss / totalCost) * 100) : 0;

    return {
      portfolioId,
      totalValue: money.round(totalValue),
      totalCost: money.round(totalCost),
      totalFees: money.round(totalFees),
      totalProfitLoss: money.round(totalProfitLoss),
      totalProfitLossPercent,
      // Новые depth-агрегаты (ADDITIVE):
      totalDividends: money.round(totalDividends),
      totalEventFees: money.round(totalEventFees),
      totalNetProfitLoss: money.round(totalNetProfitLoss),
      totalNetProfitLossPercent,
      holdings,
      byType: this.groupByType(holdings)
    };
  },

  // Аллокация портфеля: разбивка % стоимости по типу актива и по символу.
  // Суммы весов в каждой группировке ~100% (если есть стоимость).
  async getAllocation(portfolioId) {
    const stats = await this.calculatePortfolioValue(portfolioId);
    const totalValue = stats.totalValue;

    const pct = (v) =>
      totalValue > 0 ? money.round((v / totalValue) * 100) : 0;

    // По типу актива.
    const byTypeMap = {};
    // По символу.
    const bySymbolMap = {};

    for (const h of stats.holdings) {
      const t = h.type || 'other';
      byTypeMap[t] = money.add(byTypeMap[t] || 0, h.currentValue);

      const s = (h.symbol || '').toUpperCase() || '—';
      bySymbolMap[s] = money.add(bySymbolMap[s] || 0, h.currentValue);
    }

    const byType = Object.entries(byTypeMap).map(([type, value]) => ({
      type,
      value: money.round(value),
      percent: pct(value)
    })).sort((a, b) => b.value - a.value);

    const bySymbol = Object.entries(bySymbolMap).map(([symbol, value]) => ({
      symbol,
      value: money.round(value),
      percent: pct(value)
    })).sort((a, b) => b.value - a.value);

    return {
      portfolioId,
      totalValue,
      byType,
      bySymbol
    };
  },

  // Простая FIRE-проекция: за сколько лет текущая стоимость + ежемесячные
  // взносы под заданную годовую доходность дорастут до целевой суммы.
  // Формула будущей стоимости с регулярными взносами (помесячная капитализация):
  //   FV = PV*(1+i)^n + PMT*(((1+i)^n - 1)/i),  i = годовая ставка / 12, n = месяцы.
  // Решаем относительно n численно (помесячная симуляция) — устойчиво к i=0
  // и не требует логарифмов с краевыми случаями. Возвращает { years, months, ... }.
  // Если цель недостижима за горизонт — reachable=false, years=null.
  fireProjection({ currentValue = 0, contribution = 0, rate = 0, target = 0 }) {
    const pv = money.round(Number(currentValue) || 0);
    const pmt = money.round(Number(contribution) || 0);
    // rate приходит как доля (0.07) ИЛИ как проценты (7) — нормализуем: >1 => проценты.
    let r = Number(rate);
    if (!Number.isFinite(r) || r < 0) r = 0;
    if (r > 1) r = r / 100;
    const tgt = money.round(Number(target) || 0);

    // Уже достигнуто.
    if (tgt <= pv) {
      return { reachable: true, years: 0, months: 0, finalValue: pv,
        contributions: pmt, rate: r, target: tgt, currentValue: pv };
    }
    // Нечем расти — ни взносов, ни доходности, ни капитала под процент.
    if (pmt <= 0 && r <= 0) {
      return { reachable: false, years: null, months: null, finalValue: pv,
        contributions: pmt, rate: r, target: tgt, currentValue: pv };
    }

    const i = r / 12;
    const MAX_MONTHS = 100 * 12; // горизонт 100 лет
    let balance = pv;
    let months = 0;
    while (balance < tgt && months < MAX_MONTHS) {
      balance = balance * (1 + i) + pmt;
      months += 1;
    }

    if (balance < tgt) {
      return { reachable: false, years: null, months: null,
        finalValue: money.round(balance), contributions: pmt, rate: r,
        target: tgt, currentValue: pv };
    }

    const years = money.round(months / 12);
    return {
      reachable: true,
      years,
      months,
      finalValue: money.round(balance),
      contributions: pmt,
      rate: r,
      target: tgt,
      currentValue: pv
    };
  },

  // Группировка по типу
  groupByType(holdings) {
    const byType = {};

    holdings.forEach(h => {
      if (!byType[h.type]) {
        byType[h.type] = { value: 0, cost: 0, count: 0 };
      }
      byType[h.type].value = money.add(byType[h.type].value, h.currentValue);
      byType[h.type].cost = money.add(byType[h.type].cost, h.buyValue);
      byType[h.type].count++;
    });

    return byType;
  },

  // Последняя закэшированная цена символа (Wave-2 price-feeds).
  // Возвращает строку investment_prices или null. Используется как
  // офлайн-фолбэк/индикатор свежести в UI; current_price на активе
  // обновляет services/priceService.refreshUserPrices.
  async getLatestPrice(symbol, currency = 'USD') {
    if (!symbol) return null;
    return get(
      `SELECT * FROM investment_prices
       WHERE symbol = ? AND currency = ?
       ORDER BY date DESC, id DESC LIMIT 1`,
      [String(symbol).toUpperCase(), currency]
    );
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
    let totalFees = 0;
    let totalDividends = 0;
    let totalEventFees = 0;
    let portfolioStats = [];

    for (const portfolio of portfolios) {
      const stats = await this.calculatePortfolioValue(portfolio.id);
      totalValue = money.add(totalValue, stats.totalValue);
      totalCost = money.add(totalCost, stats.totalCost);
      totalFees = money.add(totalFees, stats.totalFees || 0);
      totalDividends = money.add(totalDividends, stats.totalDividends || 0);
      totalEventFees = money.add(totalEventFees, stats.totalEventFees || 0);
      portfolioStats.push({ ...portfolio, ...stats });
    }

    // Чистая прибыль по всем портфелям учитывает комиссии по сделкам (как раньше).
    const totalProfitLoss = money.sub(money.sub(totalValue, totalCost), totalFees);
    const totalProfitLossPercent = totalCost > 0 ? money.round((totalProfitLoss / totalCost) * 100) : 0;

    // Чистый P&L с учётом дивидендов и event-комиссий (investment depth).
    const totalNetProfitLoss = money.sub(money.add(totalProfitLoss, totalDividends), totalEventFees);
    const totalNetProfitLossPercent = totalCost > 0 ? money.round((totalNetProfitLoss / totalCost) * 100) : 0;

    return {
      portfolioCount: portfolios.length,
      totalValue: money.round(totalValue),
      totalCost: money.round(totalCost),
      totalFees: money.round(totalFees),
      totalProfitLoss: money.round(totalProfitLoss),
      totalProfitLossPercent,
      // Новые depth-агрегаты (ADDITIVE):
      totalDividends: money.round(totalDividends),
      totalEventFees: money.round(totalEventFees),
      totalNetProfitLoss: money.round(totalNetProfitLoss),
      totalNetProfitLossPercent,
      portfolios: portfolioStats
    };
  }
};

module.exports = Investment;
