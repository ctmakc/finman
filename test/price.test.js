// test/price.test.js — Wave-2 «price-feeds».
//
// Сеть полностью замокана через jest.mock('axios'): тесты офлайн и
// детерминированы. Проверяем:
//   - parseStooqCsv: парсинг валидных строк и отбрасывание N/D
//   - toStooqSymbol: маппинг акция/ETF/крипта/квалифицированный тикер
//   - fetchQuote: котировка парсится и кэшируется в investment_prices
//   - refreshUserPrices: current_price активов обновляется + история пишется
//   - P&L (calculateValue/getUserStats) использует СВЕЖИЕ цены
//   - POST /api/investments/refresh-prices обновляет цены и отдаёт stats
//   - per-portfolio refresh + проверка владения (чужой портфель -> 404)
//   - graceful failure: сетевой сбой/нет данных не валит запрос
//
// ВАЖНО: harness сбрасывает require-кэш services/* на каждый makeApp(), но
// jest.mock('axios') перехватывает модуль в реестре jest независимо от кэша,
// поэтому и priceService получает именно мок axios.

const { makeApp } = require('./helpers/app');

// --- Управляемый мок axios -------------------------------------------------
// axiosMock.handler(symbol) -> { data } | бросает (имитация сетевого сбоя).
const axiosState = {
  handler: null, // (stooqSymbol) => csvString
  calls: [],
};

jest.mock('axios', () => ({
  get: jest.fn(async (_url, opts) => {
    const sym = opts && opts.params && opts.params.s;
    axiosState.calls.push(sym);
    if (typeof axiosState.handler !== 'function') {
      throw new Error('no axios handler set in test');
    }
    return { data: axiosState.handler(sym) };
  }),
}));

// Хелпер: CSV-строка котировки Stooq.
function csvFor(symbol, close, date = '2026-06-19') {
  return (
    'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
    `${symbol},${date},22:00:01,${close},${close},${close},${close},1000000`
  );
}

// Промис-обёртки над raw sqlite3 handle.
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// Сеем портфель + актив. Возвращает { portfolioId, investmentId }.
async function seedHolding(db, userId, opts = {}) {
  const p = await dbRun(
    db,
    `INSERT INTO investment_portfolios (user_id, name, currency, is_active)
     VALUES (?, ?, ?, 1)`,
    [userId, opts.portfolioName || 'My Stocks', opts.currency || 'USD']
  );
  const inv = await dbRun(
    db,
    `INSERT INTO investments
       (portfolio_id, symbol, name, type, quantity, buy_price, current_price, currency, buy_date, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      p.id,
      (opts.symbol || 'AAPL').toUpperCase(),
      opts.name || 'Apple Inc.',
      opts.type || 'stock',
      opts.quantity != null ? opts.quantity : 10,
      opts.buyPrice != null ? opts.buyPrice : 100,
      opts.currentPrice != null ? opts.currentPrice : 100,
      opts.currency || 'USD',
      opts.buyDate || '2026-01-01',
    ]
  );
  return { portfolioId: p.id, investmentId: inv.id };
}

beforeEach(() => {
  axiosState.handler = null;
  axiosState.calls = [];
});

// ===========================================================================
// Чистые юниты (без БД / сети)
// ===========================================================================
describe('priceService — pure helpers', () => {
  const priceService = require('../services/priceService');

  test('parseStooqCsv: парсит валидную строку (close -> price)', () => {
    const rows = priceService.parseStooqCsv(csvFor('AAPL.US', '201.23'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'AAPL.US', price: 201.23, date: '2026-06-19' });
  });

  test('parseStooqCsv: отбрасывает N/D и нечисловой close', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
      'NOPE.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D';
    expect(priceService.parseStooqCsv(csv)).toEqual([]);
  });

  test('parseStooqCsv: пустой/мусорный вход -> []', () => {
    expect(priceService.parseStooqCsv('')).toEqual([]);
    expect(priceService.parseStooqCsv(null)).toEqual([]);
    expect(priceService.parseStooqCsv('garbage')).toEqual([]);
  });

  test('toStooqSymbol: акция -> .us, крипта -> usd-пара, квалиф. тикер как есть', () => {
    expect(priceService.toStooqSymbol('AAPL', 'stock')).toBe('aapl.us');
    expect(priceService.toStooqSymbol('SPY', 'etf')).toBe('spy.us');
    expect(priceService.toStooqSymbol('BTC', 'crypto')).toBe('btcusd');
    expect(priceService.toStooqSymbol('ETH')).toBe('ethusd'); // эвристика по типу
    expect(priceService.toStooqSymbol('FOO.DE', 'stock')).toBe('foo.de');
    expect(priceService.toStooqSymbol('  ', 'stock')).toBe('');
  });
});

// ===========================================================================
// Интеграция с БД (кэш, P&L)
// ===========================================================================
describe('priceService — caching & price refresh (DB)', () => {
  test('fetchQuote: парсит и кэширует цену в investment_prices', async () => {
    const ctx = await makeApp();
    try {
      const priceService = require('../services/priceService');
      axiosState.handler = (sym) => csvFor(sym, '150.50');

      const quote = await priceService.fetchQuote('AAPL', 'stock', 'USD');
      expect(quote).toMatchObject({ symbol: 'AAPL', price: 150.5, currency: 'USD', source: 'stooq' });

      // Закэшировано под ПОЛЬЗОВАТЕЛЬСКИМ символом (AAPL, не AAPL.US).
      const cached = await dbGet(
        ctx.db,
        'SELECT * FROM investment_prices WHERE symbol = ?',
        ['AAPL']
      );
      expect(cached).toBeTruthy();
      expect(cached.price).toBe(150.5);
      expect(cached.source).toBe('stooq');
    } finally {
      await ctx.close();
    }
  });

  test('fetchQuote: сетевой сбой -> null, БЕЗ кэша (graceful)', async () => {
    const ctx = await makeApp();
    try {
      const priceService = require('../services/priceService');
      axiosState.handler = () => { throw new Error('ETIMEDOUT'); };

      const quote = await priceService.fetchQuote('AAPL', 'stock');
      expect(quote).toBeNull();

      const rows = await dbAll(ctx.db, 'SELECT * FROM investment_prices', []);
      expect(rows).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  test('refreshUserPrices: обновляет current_price и пересчитывает P&L по свежей цене', async () => {
    const ctx = await makeApp();
    try {
      const priceService = require('../services/priceService');
      const Investment = require('../models/investment');

      // 10 акций по $100; стартовая current_price тоже 100 -> P&L 0.
      const { investmentId } = await seedHolding(ctx.db, ctx.userId, {
        symbol: 'AAPL', quantity: 10, buyPrice: 100, currentPrice: 100,
      });

      const before = await Investment.calculateValue(investmentId);
      expect(before.profitLoss).toBe(0);

      // Свежая котировка $120.
      axiosState.handler = (sym) => csvFor(sym, '120');
      const summary = await priceService.refreshUserPrices(ctx.userId);
      expect(summary.updated).toBe(1);
      expect(summary.failed).toBe(0);

      // current_price обновился в БД.
      const inv = await dbGet(ctx.db, 'SELECT * FROM investments WHERE id = ?', [investmentId]);
      expect(inv.current_price).toBe(120);

      // P&L использует свежую цену: (120-100)*10 = 200.
      const after = await Investment.calculateValue(investmentId);
      expect(after.currentValue).toBe(1200);
      expect(after.profitLoss).toBe(200);
      expect(after.profitLossPercent).toBe(20);

      // История цены записана.
      const hist = await dbAll(ctx.db, 'SELECT * FROM investment_prices WHERE symbol = ?', ['AAPL']);
      expect(hist).toHaveLength(1);
      expect(hist[0].price).toBe(120);
    } finally {
      await ctx.close();
    }
  });

  test('refreshUserPrices: P&L учитывает комиссии и не регрессирует', async () => {
    const ctx = await makeApp();
    try {
      const priceService = require('../services/priceService');
      const Investment = require('../models/investment');

      const { investmentId } = await seedHolding(ctx.db, ctx.userId, {
        symbol: 'MSFT', quantity: 5, buyPrice: 200, currentPrice: 200,
      });
      // Комиссия 7.50 по сделке покупки.
      await dbRun(
        ctx.db,
        `INSERT INTO investment_transactions (investment_id, type, quantity, price, fee, date)
         VALUES (?, 'buy', 5, 200, 7.5, '2026-01-01')`,
        [investmentId]
      );

      axiosState.handler = (sym) => csvFor(sym, '210');
      await priceService.refreshUserPrices(ctx.userId);

      // (210-200)*5 = 50 gross; минус комиссия 7.50 = 42.50 чистыми.
      const val = await Investment.calculateValue(investmentId);
      expect(val.fees).toBe(7.5);
      expect(val.profitLoss).toBe(42.5);
    } finally {
      await ctx.close();
    }
  });

  test('refreshUserPrices: один недоступный символ не валит остальные', async () => {
    const ctx = await makeApp();
    try {
      const priceService = require('../services/priceService');

      await seedHolding(ctx.db, ctx.userId, { symbol: 'AAPL', portfolioName: 'P1' });
      await seedHolding(ctx.db, ctx.userId, { symbol: 'ZZZZ', portfolioName: 'P2' });

      // AAPL.us -> цена; zzzz.us -> N/D.
      axiosState.handler = (sym) =>
        sym === 'aapl.us'
          ? csvFor('AAPL.US', '111')
          : 'Symbol,Date,Time,Open,High,Low,Close,Volume\nZZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D';

      const summary = await priceService.refreshUserPrices(ctx.userId);
      expect(summary.updated).toBe(1);
      expect(summary.failed).toBe(1);

      const aapl = await dbGet(ctx.db, "SELECT current_price FROM investments WHERE symbol = 'AAPL'");
      expect(aapl.current_price).toBe(111);
    } finally {
      await ctx.close();
    }
  });

  test('refreshUserPrices: нет холдингов -> пустая сводка, сеть не дёргается', async () => {
    const ctx = await makeApp();
    try {
      const priceService = require('../services/priceService');
      axiosState.handler = () => { throw new Error('should not be called'); };

      const summary = await priceService.refreshUserPrices(ctx.userId);
      expect(summary).toEqual({ updated: 0, failed: 0, symbols: [] });
      expect(axiosState.calls).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });
});

// ===========================================================================
// HTTP endpoints
// ===========================================================================
describe('POST /api/investments/refresh-prices', () => {
  test('требует аутентификацию', async () => {
    const ctx = await makeApp();
    try {
      const res = await ctx.request.post('/api/investments/refresh-prices');
      expect(res.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  test('обновляет цены пользователя и возвращает свежую статистику', async () => {
    const ctx = await makeApp();
    try {
      await seedHolding(ctx.db, ctx.userId, {
        symbol: 'AAPL', quantity: 10, buyPrice: 100, currentPrice: 100,
      });
      axiosState.handler = (sym) => csvFor(sym, '130');

      const res = await ctx.request
        .post('/api/investments/refresh-prices')
        .set('Authorization', 'Bearer ' + ctx.token);

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
      expect(res.body.failed).toBe(0);
      // Свежий P&L в stats: (130-100)*10 = 300.
      expect(res.body.stats).toBeTruthy();
      expect(res.body.stats.totalValue).toBe(1300);
      expect(res.body.stats.totalProfitLoss).toBe(300);
    } finally {
      await ctx.close();
    }
  });

  test('per-portfolio refresh обновляет только этот портфель', async () => {
    const ctx = await makeApp();
    try {
      const { portfolioId } = await seedHolding(ctx.db, ctx.userId, {
        symbol: 'AAPL', quantity: 2, buyPrice: 50, currentPrice: 50,
      });
      axiosState.handler = (sym) => csvFor(sym, '75');

      const res = await ctx.request
        .post('/api/investments/portfolios/' + portfolioId + '/refresh-prices')
        .set('Authorization', 'Bearer ' + ctx.token);

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
      expect(res.body.stats.totalValue).toBe(150); // 2 * 75
      expect(res.body.stats.totalProfitLoss).toBe(50); // (75-50)*2
    } finally {
      await ctx.close();
    }
  });

  test('per-portfolio refresh: чужой/несуществующий портфель -> 404', async () => {
    const ctx = await makeApp();
    try {
      // Портфель другого пользователя.
      const other = await dbRun(
        ctx.db,
        `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
        ['other', 'other@example.com', 'x', 'Other']
      );
      const foreign = await dbRun(
        ctx.db,
        `INSERT INTO investment_portfolios (user_id, name, is_active) VALUES (?, 'Foreign', 1)`,
        [other.id]
      );
      axiosState.handler = () => { throw new Error('should not be called'); };

      const res = await ctx.request
        .post('/api/investments/portfolios/' + foreign.id + '/refresh-prices')
        .set('Authorization', 'Bearer ' + ctx.token);

      expect(res.status).toBe(404);
      expect(axiosState.calls).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  test('graceful: сеть лежит -> 200 с failed>0, current_price не затёрт', async () => {
    const ctx = await makeApp();
    try {
      const { investmentId } = await seedHolding(ctx.db, ctx.userId, {
        symbol: 'AAPL', quantity: 1, buyPrice: 100, currentPrice: 100,
      });
      axiosState.handler = () => { throw new Error('ENETUNREACH'); };

      const res = await ctx.request
        .post('/api/investments/refresh-prices')
        .set('Authorization', 'Bearer ' + ctx.token);

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(0);
      expect(res.body.failed).toBe(1);

      // Старая цена сохранена.
      const inv = await dbGet(ctx.db, 'SELECT current_price FROM investments WHERE id = ?', [investmentId]);
      expect(inv.current_price).toBe(100);
    } finally {
      await ctx.close();
    }
  });
});
