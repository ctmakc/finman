// services/currencyService.js — курсы валют: живой источник + страховочная таблица.
//
// Задача: CAD/USD/EUR/UAH должны конвертироваться всегда. Раньше при отсутствии
// строки в currency_rates конвертер падал («Cannot read properties of undefined
// (reading 'toFixed')»), а Net Worth писал «Нет курса для CAD — учтены 1:1».
//
// Источники (по приоритету, всё бесплатно и без ключей):
//   1) уже сохранённые строки currency_rates (NBU / exchangerate / manual / stooq);
//   2) живой Stooq CSV (тот же провайдер, что у services/priceService.js для акций):
//      https://stooq.com/q/l/?s=cadusd&f=sd2t2ohlcv&h&e=csv  -> цена = 1 CAD в USD;
//   3) страховочная таблица FALLBACK_TO_USD ниже (source='fallback', дата фикс.).
//      Любая более свежая строка из 1) или 2) её перекрывает (getRate берёт
//      последнюю по дате). Для UI источник отдаётся в ответе конвертера.
//
// В тестах (NODE_ENV=test) сеть не трогаем, кроме явного FX_LIVE=1.

const axios = require('axios');
const Currency = require('../models/currency');
const money = require('../lib/money');
const logger = require('../lib/logger');
const { AppError } = require('../middleware/error');

const STOOQ_BASE = 'https://stooq.com/q/l/';
const TIMEOUT_MS = 8000;

// Валюты, которые обязаны конвертироваться без настройки.
const CORE_CURRENCIES = ['USD', 'CAD', 'EUR', 'UAH'];

// Страховочные курсы «1 единица -> USD» ТОЛЬКО для базовых валют продукта
// (CAD/EUR/UAH; USD = 1). Ориентиры конца 2025 — начала 2026, помечены датой
// FALLBACK_DATE и source='fallback'; живые данные их перекрывают. Остальные
// валюты без курса по-прежнему идут 1:1 с флагом missingRates — не выдумываем.
const FALLBACK_DATE = '2026-01-01';
const FALLBACK_TO_USD = {
  CAD: 0.73,
  EUR: 1.17,
  UAH: 0.024,
};

function liveAllowed() {
  if (process.env.FX_LIVE === '1') return true;
  if (process.env.FX_LIVE === '0') return false;
  return process.env.NODE_ENV !== 'test';
}

function norm(code) {
  return String(code || '').trim().toUpperCase();
}

// Сетевой вызов Stooq для валютной пары (изолирован для мока в тестах).
async function fetchStooqPair(symbol) {
  const res = await axios.get(STOOQ_BASE, {
    params: { s: symbol, f: 'sd2t2ohlcv', h: '', e: 'csv' },
    timeout: TIMEOUT_MS,
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  return res.data;
}

// Парсер Stooq CSV для валют: берём Close БЕЗ округления до копеек
// (priceService.parseStooqCsv округляет цену акции до 2 знаков — для курса
// 0.024 UAH/USD это потеря смысла). Возвращает { rate, date } или null.
function parseFxCsv(csv) {
  if (typeof csv !== 'string') return null;
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idxClose = header.indexOf('close');
  const idxDate = header.indexOf('date');
  if (idxClose === -1) return null;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const rate = Number((cols[idxClose] || '').trim());
    if (!Number.isFinite(rate) || rate <= 0) continue; // N/D
    const d = idxDate !== -1 ? (cols[idxDate] || '').trim() : '';
    return { rate, date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null };
  }
  return null;
}

// Живой курс code -> USD через Stooq (пара '<code>usd'). null, если нет данных.
async function fetchLiveToUsd(code) {
  const c = norm(code);
  if (c === 'USD') return 1;
  const symbol = `${c.toLowerCase()}usd`;
  try {
    const csv = await currencyService._fetchStooqPair(symbol);
    const row = parseFxCsv(csv);
    if (!row) return null;
    return { rate: row.rate, date: row.date };
  } catch (err) {
    logger.warn({ symbol, err: err && err.message }, 'currencyService: stooq fx fetch failed');
    return null;
  }
}

const currencyService = {
  CORE_CURRENCIES,
  FALLBACK_TO_USD,
  FALLBACK_DATE,
  parseFxCsv,
  _fetchStooqPair: fetchStooqPair, // точка подмены в тестах

  // Гарантировать, что для каждой из валют есть курс к USD.
  // Возвращает { fetched: [...], seeded: [...], missing: [...] }.
  async ensureRates(codes = CORE_CURRENCIES, { live = liveAllowed() } = {}) {
    const result = { fetched: [], seeded: [], missing: [] };
    for (const raw of codes) {
      const code = norm(raw);
      if (!code || code === 'USD') continue;
      let rate = null;
      try {
        rate = await Currency.getRate(code, 'USD');
      } catch (e) {
        rate = null;
      }
      if (rate) continue;

      if (live) {
        const liveRate = await fetchLiveToUsd(code);
        if (liveRate && liveRate.rate > 0) {
          await Currency.saveRate(code, 'USD', liveRate.rate, 'stooq', liveRate.date || undefined);
          result.fetched.push(code);
          continue;
        }
      }

      if (FALLBACK_TO_USD[code]) {
        await Currency.saveRate(code, 'USD', FALLBACK_TO_USD[code], 'fallback', FALLBACK_DATE);
        result.seeded.push(code);
      } else {
        result.missing.push(code);
      }
    }
    return result;
  },

  // Курс from -> to; при отсутствии — досеять (live/fallback) и повторить.
  // Возвращает { rate, source } или null.
  async rateOrFallback(from, to, date = null) {
    const f = norm(from);
    const t = norm(to);
    if (!f || !t) return null;
    if (f === t) return { rate: 1, source: 'identity' };

    let rate = await Currency.getRate(f, t, date);
    if (rate) return { rate, source: 'stored' };

    const ensured = await this.ensureRates([f, t]);
    rate = await Currency.getRate(f, t, date);
    if (!rate) return null;
    const touched = [...ensured.fetched, ...ensured.seeded];
    const source = ensured.seeded.some((c) => c === f || c === t)
      ? 'fallback'
      : ensured.fetched.length
        ? 'stooq'
        : 'stored';
    void touched;
    return { rate, source };
  },

  // Конвертация с понятной ошибкой вместо undefined.toFixed.
  // -> { success:true, result, amount (=result, совместимость), original, rate, from, to, source }
  async convert(amount, from, to, date = null) {
    const value = Number(amount);
    if (!Number.isFinite(value)) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be a number');
    }
    const f = norm(from);
    const t = norm(to);
    if (!/^[A-Z]{3,5}$/.test(f) || !/^[A-Z]{3,5}$/.test(t)) {
      throw new AppError(400, 'INVALID_CURRENCY', 'Currency code must be 3 letters, e.g. CAD');
    }
    const found = await this.rateOrFallback(f, t, date);
    if (!found) {
      throw new AppError(422, 'RATE_NOT_FOUND', `No exchange rate ${f} → ${t}. Add one manually (POST /api/currency/rate) or refresh the rates.`);
    }
    const result = money.round(value * found.rate);
    return {
      success: true,
      result,
      amount: result,
      original: value,
      rate: found.rate,
      from: f,
      to: t,
      fromCurrency: f,
      toCurrency: t,
      source: found.source,
    };
  },
};

module.exports = currencyService;
