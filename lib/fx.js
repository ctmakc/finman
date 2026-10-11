// lib/fx.js — currency conversion for income/expense aggregates.
//
// The transactions table has no currency column: a transaction is in the
// currency of its account (accounts.currency). Summing raw amounts across
// accounts mixes currencies (100 CAD + 4000 UAH shown as "4100 CAD").
//
// Pattern used by every aggregate (analytics, forecast, widgets, reports,
// digest, budgets, Transaction.getStats):
//   1) SQL groups by the usual key AND by a.currency (JOIN accounts a);
//   2) a converter turns each group into the target currency (the user's base
//      currency by default, or e.g. a budget's currency);
//   3) regroup() merges the converted groups back by key.
//
// One converter per request: rates are looked up once per currency pair and
// cached. A missing rate falls back to 1:1 and the currency is reported in
// missingRates (same contract as services/networthService).

const money = require('./money');

function norm(code) {
  return code ? String(code).trim().toUpperCase() : null;
}

// Rate from -> to (number) or null when no rate exists anywhere.
async function lookupRate(from, to, date) {
  const Currency = require('../models/currency');
  const currencyService = require('../services/currencyService');
  let rate = null;
  try {
    rate = await Currency.getRate(from, to, date || null);
  } catch (e) {
    rate = null;
  }
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) {
    try {
      const found = await currencyService.rateOrFallback(from, to, date || null);
      rate = found ? found.rate : null;
    } catch (e) {
      rate = null;
    }
  }
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate)) || Number(rate) <= 0) {
    return null;
  }
  return Number(rate);
}

// createConverter(baseCurrency, { date }) -> converter bound to a target currency.
function createConverter(baseCurrency, options = {}) {
  const base = norm(baseCurrency) || require('../config/config').defaultCurrency;
  const date = options.date || null;
  const cache = new Map();
  const missing = new Set();

  async function rate(from, to = base) {
    const f = norm(from) || norm(to);
    const t = norm(to) || base;
    if (f === t) return 1;
    const key = `${f}>${t}`;
    if (!cache.has(key)) {
      cache.set(key, lookupRate(f, t, date));
    }
    const r = await cache.get(key);
    if (r === null) {
      missing.add(f);
      return 1;
    }
    return r;
  }

  // Convert one amount (null currency = already in the target currency).
  async function convert(amount, from, to = base) {
    const value = Number(amount) || 0;
    if (!value) return 0;
    const r = await rate(from || to, to);
    return r === 1 ? money.round(value) : money.mul(value, r);
  }

  // Merge rows grouped by (keys..., currency) into rows grouped by keys only.
  // amounts are converted and summed; counts are summed as-is; other fields
  // keep the first row's value. Order follows the first appearance of a key.
  async function regroup(rows, { keys = [], amounts = [], counts = [], currencyField = 'currency', to = base } = {}) {
    const out = new Map();
    for (const row of rows || []) {
      const key = JSON.stringify(keys.map((k) => row[k]));
      let acc = out.get(key);
      if (!acc) {
        acc = { ...row };
        delete acc[currencyField];
        for (const f of amounts) acc[f] = 0;
        for (const f of counts) acc[f] = 0;
        out.set(key, acc);
      }
      for (const f of amounts) {
        acc[f] = money.add(acc[f], await convert(row[f], row[currencyField], to));
      }
      for (const f of counts) {
        acc[f] += Number(row[f]) || 0;
      }
    }
    return Array.from(out.values());
  }

  // Sum the given amount fields over rows (each row in its own currency).
  async function totals(rows, amounts, opts = {}) {
    const merged = await regroup(rows, { keys: [], amounts, counts: opts.counts || [], currencyField: opts.currencyField, to: opts.to });
    if (merged.length) return merged[0];
    const empty = {};
    for (const f of amounts) empty[f] = 0;
    for (const f of opts.counts || []) empty[f] = 0;
    return empty;
  }

  return {
    baseCurrency: base,
    rate,
    convert,
    regroup,
    totals,
    get missingRates() {
      return Array.from(missing);
    },
  };
}

// Converter in the user's base currency (user_currency_settings, default CAD).
async function converterForUser(userId, options = {}) {
  const networthService = require('../services/networthService');
  const base = await networthService.resolveBaseCurrency(userId, options.baseCurrency);
  return createConverter(base, options);
}

module.exports = { createConverter, converterForUser, lookupRate };
