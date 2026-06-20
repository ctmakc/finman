// services/subscriptionDetector.js — эвристический детектор регулярных списаний.
// Находит повторяющиеся траты (близкая сумма + регулярный интервал по одинаковому
// описанию), которых ещё НЕТ среди активных подписок пользователя.
// Чисто детерминированно (без ИИ) — работает для всех.
'use strict';

const { query } = require('../db/database');
const money = require('../lib/money');

// Нормализация описания: убираем числа (даты/номера), оставляем буквы.
function normalize(desc) {
  return String(desc || '')
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Классификация частоты по медианному интервалу (в днях).
function classifyFrequency(gapDays) {
  if (gapDays >= 6 && gapDays <= 9) return { cycle: 'weekly', perMonth: 4.345 };
  if (gapDays >= 12 && gapDays <= 16) return { cycle: 'biweekly', perMonth: 2.17 };
  if (gapDays >= 25 && gapDays <= 35) return { cycle: 'monthly', perMonth: 1 };
  if (gapDays >= 80 && gapDays <= 100) return { cycle: 'quarterly', perMonth: 1 / 3 };
  if (gapDays >= 330 && gapDays <= 400) return { cycle: 'yearly', perMonth: 1 / 12 };
  return null; // нерегулярно
}

async function detectRecurring(userId, { now, lookbackDays = 120 } = {}) {
  const reference = now ? (now instanceof Date ? now : new Date(now)) : new Date();
  const cutoff = new Date(reference.getTime() - lookbackDays * 86400000)
    .toISOString()
    .slice(0, 10);

  const txs = await query(
    `SELECT date, description, ABS(amount) AS amount, category
       FROM transactions
      WHERE user_id = ? AND type = 'expense' AND description IS NOT NULL AND date >= ?
      ORDER BY date ASC`,
    [userId, cutoff]
  );

  const existing = await query(
    `SELECT name FROM subscriptions WHERE user_id = ? AND is_active = 1`,
    [userId]
  );
  const existingKeys = new Set(existing.map((s) => normalize(s.name)).filter(Boolean));

  const groups = new Map();
  for (const t of txs) {
    const key = normalize(t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const candidates = [];
  for (const [key, items] of groups) {
    if (items.length < 2) continue;
    if (existingKeys.has(key)) continue;

    const amounts = items.map((i) => i.amount);
    const medAmount = median(amounts);
    if (medAmount <= 0) continue;
    // суммы стабильны (±20% от медианы)
    if (!amounts.every((a) => Math.abs(a - medAmount) <= medAmount * 0.2)) continue;

    const dates = items.map((i) => new Date(i.date)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
    }
    const medGap = median(gaps);
    const freq = classifyFrequency(medGap);
    if (!freq) continue;
    // интервалы регулярны (±35% от медианы)
    if (!gaps.every((g) => g >= medGap * 0.65 && g <= medGap * 1.35)) continue;

    const amount = money.round(medAmount);
    candidates.push({
      description: items[items.length - 1].description,
      normalizedKey: key,
      amount,
      currency: 'UAH',
      billingCycle: freq.cycle,
      category: items[items.length - 1].category || null,
      occurrences: items.length,
      firstDate: dates[0].toISOString().slice(0, 10),
      lastDate: dates[dates.length - 1].toISOString().slice(0, 10),
      avgGapDays: Math.round(medGap),
      monthlyCost: money.round(amount * freq.perMonth),
    });
  }

  candidates.sort((a, b) => b.monthlyCost - a.monthlyCost);
  return { candidates, monthlyTotal: money.sum(candidates.map((c) => c.monthlyCost)) };
}

module.exports = { detectRecurring, normalize, classifyFrequency, median };
