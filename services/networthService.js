// services/networthService.js — currency-aware net worth computation.
//
// Computes total assets / liabilities / net worth by CONVERTING every component
// (accounts, investments, manual_assets, savings_goals -> assets; debts -> liabilities)
// into the user's base currency via the Currency model / currency_rates table.
//
// Rules:
//   - Base currency comes from user_currency_settings (Currency.getUserSettings), default 'UAH'.
//   - Each component is converted with Currency.getRate(from, base). If a rate is MISSING
//     (getRate -> null), we fall back to a 1:1 conversion and FLAG that currency in
//     `missingRates` so the caller/UI can warn the user that the total is approximate.
//   - All arithmetic goes through lib/money (round-safe against float drift).
//
// Exports:
//   computeNetWorth(userId, { baseCurrency?, date? }) -> Promise<{
//     baseCurrency, totalAssets, totalLiabilities, netWorth,
//     assetsBreakdown, liabilitiesBreakdown, missingRates, hasMissingRates
//   }>
//   takeSnapshot(userId, { notes?, baseCurrency?, date? }) -> Promise<{ id, snapshotDate, ...netWorth }>
//   getTrend(userId, { period? }) -> Promise<{ baseCurrency?, points: [...], change }>

const { query, get, run } = require('../db/database');
const Currency = require('../models/currency');
const money = require('../lib/money');

const DEFAULT_BASE = 'UAH';

// Liability debt types (mirrors the existing route's filter so we never break it).
const LIABILITY_DEBT_TYPES = ['i_owe', 'credit', 'mortgage', 'loan'];

// Resolve the user's base currency (settings-driven, with a safe fallback).
async function resolveBaseCurrency(userId, override) {
  if (override) return String(override).toUpperCase();
  try {
    const settings = await Currency.getUserSettings(userId);
    if (settings && settings.base_currency) {
      return String(settings.base_currency).toUpperCase();
    }
  } catch (e) {
    // settings table may be absent in some setups — fall back gracefully.
  }
  return DEFAULT_BASE;
}

// Convert a single amount into the base currency.
// Returns { amount, missing } where `missing` is true if no rate was found
// (in which case we used a 1:1 fallback).
async function convertAmount(amount, fromCurrency, baseCurrency, date, missingRates) {
  const value = Number(amount || 0);
  const from = String(fromCurrency || baseCurrency || DEFAULT_BASE).toUpperCase();

  if (from === baseCurrency) {
    return money.round(value);
  }

  let rate = null;
  try {
    rate = await Currency.getRate(from, baseCurrency, date);
  } catch (e) {
    rate = null;
  }

  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) {
    // No rate available — flag and fall back to 1:1 so the total is still usable.
    if (missingRates && from !== baseCurrency) missingRates.add(from);
    return money.round(value);
  }

  return money.mul(value, rate);
}

// Sum a list of { amount, currency } rows into the base currency.
async function convertRows(rows, baseCurrency, date, missingRates) {
  let total = 0;
  for (const row of rows) {
    const converted = await convertAmount(
      row.amount,
      row.currency,
      baseCurrency,
      date,
      missingRates
    );
    total = money.add(total, converted);
  }
  return money.round(total);
}

// Compute currency-aware net worth.
async function computeNetWorth(userId, options = {}) {
  const { date = null } = options;
  const baseCurrency = await resolveBaseCurrency(userId, options.baseCurrency);
  const missingRates = new Set();

  // ---- ASSETS ----

  // Accounts (each may have its own currency).
  const accountRows = await query(
    `SELECT balance AS amount, currency FROM accounts WHERE user_id = ? AND is_active = 1`,
    [userId]
  );
  const accountsTotal = await convertRows(accountRows, baseCurrency, date, missingRates);

  // Investments (quantity * current_price, in the investment's currency).
  const investmentRows = await query(
    `SELECT (i.quantity * COALESCE(i.current_price, i.buy_price)) AS amount,
            i.currency AS currency
     FROM investments i
     JOIN investment_portfolios p ON i.portfolio_id = p.id
     WHERE p.user_id = ? AND i.is_active = 1`,
    [userId]
  );
  const investmentsTotal = await convertRows(investmentRows, baseCurrency, date, missingRates);

  // Savings goals (current_amount, per-goal currency).
  const goalRows = await query(
    `SELECT current_amount AS amount, currency FROM savings_goals WHERE user_id = ? AND is_active = 1`,
    [userId]
  );
  const goalsTotal = await convertRows(goalRows, baseCurrency, date, missingRates);

  // Manual assets (value, per-asset currency).
  const manualRows = await query(
    `SELECT value AS amount, currency FROM manual_assets WHERE user_id = ? AND is_active = 1`,
    [userId]
  );
  const manualTotal = await convertRows(manualRows, baseCurrency, date, missingRates);

  // ---- LIABILITIES ----

  // Debts (remaining = amount - paid_amount), per-debt currency, liability types only.
  const placeholders = LIABILITY_DEBT_TYPES.map(() => '?').join(', ');
  const debtRows = await query(
    `SELECT (amount - COALESCE(paid_amount, 0)) AS amount, currency
     FROM debts
     WHERE user_id = ? AND is_active = 1 AND type IN (${placeholders})`,
    [userId, ...LIABILITY_DEBT_TYPES]
  );
  const debtsTotal = await convertRows(debtRows, baseCurrency, date, missingRates);

  const totalAssets = money.add(accountsTotal, investmentsTotal, goalsTotal, manualTotal);
  const totalLiabilities = money.round(debtsTotal);
  const netWorth = money.sub(totalAssets, totalLiabilities);

  return {
    baseCurrency,
    totalAssets,
    totalLiabilities,
    netWorth,
    assetsBreakdown: {
      accounts: accountsTotal,
      investments: investmentsTotal,
      savings: goalsTotal,
      manual: manualTotal,
    },
    liabilitiesBreakdown: {
      debts: debtsTotal,
    },
    missingRates: Array.from(missingRates),
    hasMissingRates: missingRates.size > 0,
  };
}

// Persist a daily snapshot (one row per snapshot_date per user — re-running the
// same day overwrites the prior snapshot for that day so trends stay clean).
async function takeSnapshot(userId, options = {}) {
  const { notes = null } = options;
  const data = await computeNetWorth(userId, options);
  const snapshotDate = options.date || new Date().toISOString().split('T')[0];

  // Replace any existing snapshot for the same day (idempotent daily snapshot).
  const existing = await get(
    `SELECT id FROM networth_snapshots WHERE user_id = ? AND snapshot_date = ?`,
    [userId, snapshotDate]
  );

  const assetsJson = JSON.stringify(data.assetsBreakdown);
  const liabilitiesJson = JSON.stringify(data.liabilitiesBreakdown);

  let id;
  if (existing) {
    await run(
      `UPDATE networth_snapshots
       SET total_assets = ?, total_liabilities = ?, net_worth = ?,
           assets_breakdown = ?, liabilities_breakdown = ?, notes = ?
       WHERE id = ?`,
      [
        data.totalAssets,
        data.totalLiabilities,
        data.netWorth,
        assetsJson,
        liabilitiesJson,
        notes,
        existing.id,
      ]
    );
    id = existing.id;
  } else {
    const result = await run(
      `INSERT INTO networth_snapshots
         (user_id, total_assets, total_liabilities, net_worth,
          assets_breakdown, liabilities_breakdown, snapshot_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        data.totalAssets,
        data.totalLiabilities,
        data.netWorth,
        assetsJson,
        liabilitiesJson,
        snapshotDate,
        notes,
      ]
    );
    id = result.id;
  }

  return { id, snapshotDate, ...data };
}

// Build a snapshot trend (chronological points + overall change).
async function getTrend(userId, options = {}) {
  const { period } = options;
  let dateFilter = '';
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
    default:
      dateFilter = '';
  }

  const rows = await query(
    `SELECT id, snapshot_date, total_assets, total_liabilities, net_worth
     FROM networth_snapshots
     WHERE user_id = ? ${dateFilter}
     ORDER BY snapshot_date ASC, id ASC`,
    [userId]
  );

  const points = rows.map((r) => ({
    id: r.id,
    date: r.snapshot_date,
    totalAssets: money.round(r.total_assets),
    totalLiabilities: money.round(r.total_liabilities),
    netWorth: money.round(r.net_worth),
  }));

  let change = { amount: 0, percent: 0 };
  if (points.length >= 2) {
    const first = points[0].netWorth;
    const last = points[points.length - 1].netWorth;
    const amount = money.sub(last, first);
    const percent =
      first !== 0 ? money.round((amount / Math.abs(first)) * 100) : 0;
    change = { amount, percent, from: points[0].date, to: points[points.length - 1].date };
  }

  return { points, change };
}

module.exports = {
  computeNetWorth,
  takeSnapshot,
  getTrend,
  resolveBaseCurrency,
  convertAmount,
  LIABILITY_DEBT_TYPES,
};
