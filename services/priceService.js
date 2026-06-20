// services/priceService.js — Wave-2 «price-feeds».
//
// Тянет живые котировки из БЕСПЛАТНОГО источника (Stooq CSV, без ключа),
// кэширует их в таблицу investment_prices и аккуратно деградирует при сбоях
// сети/парсинга (никогда не роняет refresh целиком из-за одного символа).
//
// Источник: https://stooq.com/q/l/?s=<symbol>&f=sd2t2ohlcv&h&e=csv
//   Формат строки: Symbol,Date,Time,Open,High,Low,Close,Volume
//   Пример:        AAPL,2026-06-19,22:00:01,200.1,201.5,199.8,201.23,12345678
//   Нет данных:    AAPL,N/D,N/D,N/D,N/D,N/D,N/D,N/D
//
// Символы Stooq:
//   - акции/ETF США котируются c суффиксом «.US» (AAPL -> aapl.us);
//   - крипта — пары к USD (BTC -> btcusd, ETH -> ethusd);
//   - если символ уже содержит точку (FOO.DE) — берём как есть.
//
// Кэш: INSERT OR REPLACE в investment_prices по UNIQUE(symbol, date).
// P&L не пересчитываем здесь — он живёт в models/investment.js и работает
// поверх current_price, который мы обновляем через Investment.updatePriceBySymbol.

const axios = require('axios');
const { query, get, run } = require('../db/database');
const money = require('../lib/money');
const { AppError } = require('../middleware/error');
const logger = require('../lib/logger');

const STOOQ_BASE = 'https://stooq.com/q/l/';
const DEFAULT_TIMEOUT_MS = 8000;
const SOURCE = 'stooq';

// Криптосимволы, для которых строим пару к USD.
const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'BNB', 'XRP', 'ADA', 'SOL', 'DOGE', 'DOT', 'LTC', 'TRX',
  'MATIC', 'AVAX', 'LINK', 'ATOM', 'XLM', 'BCH', 'ETC', 'FIL', 'NEAR', 'USDT',
]);

// ==================== ВСПОМОГАТЕЛЬНОЕ ====================

// Преобразует пользовательский символ + тип в тикер Stooq.
// type необязателен; крипту определяем эвристикой по списку CRYPTO_SYMBOLS.
function toStooqSymbol(symbol, type) {
  const raw = String(symbol || '').trim().toLowerCase();
  if (!raw) return '';

  // Уже квалифицированный тикер биржи (есть точка) — оставляем как есть.
  if (raw.includes('.')) return raw;

  const upper = raw.toUpperCase();
  const isCrypto =
    type === 'crypto' || (type == null && CRYPTO_SYMBOLS.has(upper));

  if (isCrypto) {
    // Уже пара к фиату (btcusd / ethusd) — не дублируем.
    if (/usd$|usdt$|eur$/.test(raw)) return raw;
    return `${raw}usd`;
  }

  // По умолчанию — американская акция/ETF.
  return `${raw}.us`;
}

// Парсит CSV-ответ Stooq. Возвращает массив { symbol, price, date } —
// только валидные строки (N/D и мусор отбрасываются).
function parseStooqCsv(csv) {
  const out = [];
  if (typeof csv !== 'string') return out;

  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return out;

  // Заголовок: Symbol,Date,Time,Open,High,Low,Close,Volume
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idxSymbol = header.indexOf('symbol');
  const idxDate = header.indexOf('date');
  const idxClose = header.indexOf('close');
  if (idxSymbol === -1 || idxClose === -1) return out;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= idxClose) continue;

    const sym = (cols[idxSymbol] || '').trim();
    const closeStr = (cols[idxClose] || '').trim();
    const dateStr = idxDate !== -1 ? (cols[idxDate] || '').trim() : '';

    const price = Number(closeStr);
    if (!sym || !Number.isFinite(price) || price <= 0) continue; // N/D и пр.

    out.push({
      symbol: sym,
      price: money.round(price),
      date:
        dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
          ? dateStr
          : new Date().toISOString().split('T')[0],
    });
  }

  return out;
}

// Сетевой вызов. Изолирован для удобного мока в тестах (jest.mock('axios')).
async function fetchStooq(stooqSymbol) {
  const res = await axios.get(STOOQ_BASE, {
    params: { s: stooqSymbol, f: 'sd2t2ohlcv', h: '', e: 'csv' },
    timeout: DEFAULT_TIMEOUT_MS,
    responseType: 'text',
    // Stooq иногда отдаёт text/plain — не даём axios пытаться парсить JSON.
    transformResponse: [(d) => d],
  });
  return res.data;
}

// ==================== ПУБЛИЧНЫЙ API ====================

const priceService = {
  toStooqSymbol,
  parseStooqCsv,

  // Котировка ОДНОГО символа. Возвращает { symbol, price, date, currency,
  // source, cached } либо null при недоступности (graceful).
  // symbol — пользовательский тикер (AAPL/BTC/...); type — опц. подсказка.
  async fetchQuote(symbol, type, currency = 'USD') {
    const userSymbol = String(symbol || '').trim().toUpperCase();
    if (!userSymbol) return null;

    const stooqSymbol = toStooqSymbol(userSymbol, type);
    if (!stooqSymbol) return null;

    let csv;
    try {
      csv = await fetchStooq(stooqSymbol);
    } catch (err) {
      logger.warn(
        { symbol: userSymbol, stooqSymbol, err: err && err.message },
        'priceService: fetch failed'
      );
      return null; // graceful: сеть недоступна
    }

    const rows = parseStooqCsv(csv);
    if (!rows.length) {
      logger.warn({ symbol: userSymbol, stooqSymbol }, 'priceService: no quote');
      return null;
    }

    const row = rows[0];
    const quote = {
      symbol: userSymbol, // кэшируем под ПОЛЬЗОВАТЕЛЬСКИМ символом
      price: row.price,
      date: row.date,
      currency,
      source: SOURCE,
    };

    await this.cachePrice(quote);
    return quote;
  },

  // Котировки нескольких символов. items: [{ symbol, type, currency }].
  // Дедупликация по (symbol+currency). Возвращает Map<symbol, quote|null>.
  async fetchQuotes(items) {
    const result = new Map();
    if (!Array.isArray(items) || items.length === 0) return result;

    // Уникальные пары symbol+currency, чтобы не дёргать сеть дважды.
    const seen = new Map();
    for (const it of items) {
      const sym = String(it.symbol || '').trim().toUpperCase();
      if (!sym) continue;
      const key = `${sym}|${(it.currency || 'USD').toUpperCase()}`;
      if (!seen.has(key)) seen.set(key, { ...it, symbol: sym });
    }

    for (const it of seen.values()) {
      // Последовательно — бережём бесплатный источник от rate-limit.
      // Один сбой не валит остальные (fetchQuote уже graceful).
      // eslint-disable-next-line no-await-in-loop
      const quote = await this.fetchQuote(it.symbol, it.type, it.currency || 'USD');
      result.set(it.symbol, quote);
    }

    return result;
  },

  // Кэширование котировки в investment_prices (история цен).
  // Идемпотентно по UNIQUE(symbol, date) -> INSERT OR REPLACE.
  async cachePrice(quote) {
    if (!quote || !quote.symbol || !Number.isFinite(Number(quote.price))) return;
    const date = quote.date || new Date().toISOString().split('T')[0];
    await run(
      `INSERT OR REPLACE INTO investment_prices (symbol, price, currency, date, source)
       VALUES (?, ?, ?, ?, ?)`,
      [
        quote.symbol.toUpperCase(),
        money.round(quote.price),
        quote.currency || 'USD',
        date,
        quote.source || SOURCE,
      ]
    );
  },

  // Последняя закэшированная цена символа (для офлайн-фолбэка/UI).
  async getCachedPrice(symbol, currency = 'USD') {
    if (!symbol) return null;
    return get(
      `SELECT * FROM investment_prices
       WHERE symbol = ? AND currency = ?
       ORDER BY date DESC, id DESC LIMIT 1`,
      [String(symbol).toUpperCase(), currency]
    );
  },

  // Обновить current_price для всех активов пользователя по свежим котировкам.
  // Возвращает сводку { updated, failed, symbols:[{symbol,price,status}] }.
  // Никогда не бросает из-за одного недоступного символа — деградирует.
  async refreshUserPrices(userId) {
    if (!userId) throw new AppError(400, 'INVALID_USER', 'userId required');

    // Все активные холдинги пользователя (через его портфели).
    const holdings = await query(
      `SELECT DISTINCT i.symbol AS symbol, i.type AS type, i.currency AS currency
       FROM investments i
       INNER JOIN investment_portfolios p ON i.portfolio_id = p.id
       WHERE p.user_id = ? AND p.is_active = 1 AND i.is_active = 1`,
      [userId]
    );

    const summary = { updated: 0, failed: 0, symbols: [] };
    if (!holdings.length) return summary;

    const quotes = await this.fetchQuotes(holdings);

    for (const h of holdings) {
      const sym = String(h.symbol || '').toUpperCase();
      const quote = quotes.get(sym);

      if (quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0) {
        // updatePriceBySymbol обновляет current_price активов + пишет историю.
        // eslint-disable-next-line no-await-in-loop
        await run(
          `UPDATE investments
           SET current_price = ?, updated_at = CURRENT_TIMESTAMP
           WHERE symbol = ? AND currency = ?`,
          [money.round(quote.price), sym, h.currency || 'USD']
        );
        summary.updated++;
        summary.symbols.push({ symbol: sym, price: money.round(quote.price), status: 'updated' });
      } else {
        summary.failed++;
        summary.symbols.push({ symbol: sym, price: null, status: 'unavailable' });
      }
    }

    return summary;
  },

  // Обновить цены для конкретного портфеля (пер-портфельная кнопка).
  async refreshPortfolioPrices(portfolioId) {
    if (!portfolioId) throw new AppError(400, 'INVALID_PORTFOLIO', 'portfolioId required');

    const holdings = await query(
      `SELECT DISTINCT symbol, type, currency
       FROM investments
       WHERE portfolio_id = ? AND is_active = 1`,
      [portfolioId]
    );

    const summary = { updated: 0, failed: 0, symbols: [] };
    if (!holdings.length) return summary;

    const quotes = await this.fetchQuotes(holdings);

    for (const h of holdings) {
      const sym = String(h.symbol || '').toUpperCase();
      const quote = quotes.get(sym);
      if (quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0) {
        // eslint-disable-next-line no-await-in-loop
        await run(
          `UPDATE investments
           SET current_price = ?, updated_at = CURRENT_TIMESTAMP
           WHERE portfolio_id = ? AND symbol = ? AND currency = ?`,
          [money.round(quote.price), portfolioId, sym, h.currency || 'USD']
        );
        summary.updated++;
        summary.symbols.push({ symbol: sym, price: money.round(quote.price), status: 'updated' });
      } else {
        summary.failed++;
        summary.symbols.push({ symbol: sym, price: null, status: 'unavailable' });
      }
    }

    return summary;
  },
};

module.exports = priceService;
