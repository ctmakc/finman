// services/anomalyService.js — детектор аномальных транзакций.
//
// detectForUser(userId, opts) -> Promise<[{ transactionId, reason, severity, ... }]>
//
// Три класса аномалий:
//   1) Статистический выброс по сумме внутри категории (z-score + IQR fallback).
//   2) Дубль-списание: тот же мерчант (description) + та же сумма в пределах N дней.
//   3) Рост цены подписки: текущая цена заметно выше исторической медианы платежей.
//
// severity: 'low' | 'medium' | 'high'.
// Опционально пишет уведомления через существующую модель Notification.

const { query, get } = require('../db/database');
const money = require('../lib/money');
const { AppError } = require('../middleware/error');
const logger = require('../lib/logger');

// ---- настройки по умолчанию (можно переопределить через opts) ----
const DEFAULTS = {
  lookbackDays: 180,        // глубина анализа истории
  minSamplesForStats: 4,    // минимум транзакций в категории для z-score/IQR
  zThreshold: 3,            // |z| >= 3 -> выброс
  iqrMultiplier: 1.5,       // классический коэффициент для IQR-усов
  duplicateWindowDays: 3,   // окно для поиска дублей
  subHikePercent: 15,       // рост цены подписки в % для флага
  expenseOnly: true,        // выбросы ищем только по расходам
};

// ---------- статистические помощники ----------

function mean(nums) {
  if (!nums.length) return 0;
  return money.sum(nums) / nums.length;
}

// Стандартное отклонение по выборке (n-1). Возвращает 0 для <2 точек.
function stdDev(nums) {
  const n = nums.length;
  if (n < 2) return 0;
  const m = mean(nums);
  const variance =
    nums.reduce((acc, x) => acc + Math.pow(Number(x) - m, 2), 0) / (n - 1);
  return Math.sqrt(variance);
}

// Линейная интерполяция перцентиля (0..1) по отсортированному массиву.
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return Number(sortedAsc[0]);
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Number(sortedAsc[lo]);
  const frac = idx - lo;
  return Number(sortedAsc[lo]) + (Number(sortedAsc[hi]) - Number(sortedAsc[lo])) * frac;
}

function severityFromZ(z) {
  const a = Math.abs(z);
  if (a >= 5) return 'high';
  if (a >= 4) return 'medium';
  return 'low';
}

// ---------- 1) Статистические выбросы по сумме внутри категории ----------

function detectAmountOutliers(transactions, cfg) {
  const anomalies = [];

  // Группируем по категории (null -> '__uncategorized__').
  const byCategory = new Map();
  for (const t of transactions) {
    if (cfg.expenseOnly && t.type !== 'expense') continue;
    const key = t.category || '__uncategorized__';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(t);
  }

  for (const [category, txs] of byCategory.entries()) {
    if (txs.length < cfg.minSamplesForStats) continue;

    const amounts = txs.map((t) => Math.abs(Number(t.amount) || 0));
    const m = mean(amounts);
    const sd = stdDev(amounts);

    // IQR-границы как запасной вариант, когда sd == 0 (нет разброса).
    const sorted = [...amounts].sort((a, b) => a - b);
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const iqr = q3 - q1;
    const upperFence = q3 + cfg.iqrMultiplier * iqr;

    for (const t of txs) {
      const amt = Math.abs(Number(t.amount) || 0);

      let flagged = false;
      let z = 0;
      let severity = 'low';

      if (sd > 0) {
        z = (amt - m) / sd;
        if (z >= cfg.zThreshold) {
          flagged = true;
          severity = severityFromZ(z);
        }
      } else if (iqr > 0 && amt > upperFence) {
        // Нет разброса по sd, но IQR ловит верхний выброс.
        flagged = true;
        severity = 'medium';
      }

      if (flagged) {
        anomalies.push({
          transactionId: t.id,
          type: 'amount_outlier',
          reason:
            `Необычно крупная транзакция в категории "${category === '__uncategorized__' ? 'без категории' : category}": ` +
            `${money.round(amt)} при среднем ${money.round(m)}`,
          severity,
          category: category === '__uncategorized__' ? null : category,
          amount: money.round(Number(t.amount) || 0),
          zScore: sd > 0 ? money.round(z) : null,
          date: t.date,
        });
      }
    }
  }

  return anomalies;
}

// ---------- 2) Дубль-списания (тот же мерчант+сумма в окне N дней) ----------

function dayDiff(aStr, bStr) {
  const a = new Date(aStr);
  const b = new Date(bStr);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return Infinity;
  return Math.abs((a - b) / (1000 * 60 * 60 * 24));
}

function detectDuplicates(transactions, cfg) {
  const anomalies = [];

  // Ключ = description|amount. Внутри — отсортированный по дате список.
  const groups = new Map();
  for (const t of transactions) {
    const merchant = (t.description || '').trim().toLowerCase();
    if (!merchant) continue; // без мерчанта дубль не определить надёжно
    const amt = money.round(Number(t.amount) || 0);
    if (amt === 0) continue;
    const key = `${merchant}|${amt}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  for (const txs of groups.values()) {
    if (txs.length < 2) continue;
    const sorted = [...txs].sort((a, b) => new Date(a.date) - new Date(b.date));

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const diff = dayDiff(prev.date, cur.date);
      if (diff <= cfg.duplicateWindowDays) {
        // Флагуем второй (более поздний) — вероятный повторный платёж.
        anomalies.push({
          transactionId: cur.id,
          type: 'duplicate_charge',
          reason:
            `Возможное повторное списание у "${cur.description}" на сумму ` +
            `${money.round(Number(cur.amount) || 0)} в пределах ${Math.round(diff)} дн. ` +
            `(дубликат транзакции #${prev.id})`,
          severity: diff <= 1 ? 'high' : 'medium',
          duplicateOf: prev.id,
          amount: money.round(Number(cur.amount) || 0),
          date: cur.date,
        });
      }
    }
  }

  return anomalies;
}

// ---------- 3) Рост цены подписок ----------

async function detectSubscriptionHikes(userId, cfg) {
  const anomalies = [];

  const subs = await query(
    `SELECT id, name, amount FROM subscriptions
     WHERE user_id = ? AND is_active = 1`,
    [userId]
  );

  for (const sub of subs) {
    const current = Number(sub.amount) || 0;
    if (current <= 0) continue;

    // История платежей по подписке (если есть таблица subscription_payments).
    let payments = [];
    try {
      payments = await query(
        `SELECT amount FROM subscription_payments
         WHERE subscription_id = ?
         ORDER BY payment_date ASC`,
        [sub.id]
      );
    } catch (e) {
      // Таблицы может не быть в каком-то окружении — деградируем мягко.
      payments = [];
    }

    const hist = payments
      .map((p) => Number(p.amount) || 0)
      .filter((a) => a > 0);

    if (hist.length < 2) continue;

    // Базовая цена = медиана исторических платежей (устойчивее среднего).
    const sorted = [...hist].sort((a, b) => a - b);
    const base = percentile(sorted, 0.5);
    if (base <= 0) continue;

    const hikePct = ((current - base) / base) * 100;
    if (hikePct >= cfg.subHikePercent) {
      anomalies.push({
        transactionId: null, // привязки к транзакции нет — это сущность подписки
        subscriptionId: sub.id,
        type: 'subscription_hike',
        reason:
          `Цена подписки "${sub.name}" выросла на ${money.round(hikePct)}% ` +
          `(${money.round(base)} -> ${money.round(current)})`,
        severity: hikePct >= 50 ? 'high' : hikePct >= 25 ? 'medium' : 'low',
        amount: money.round(current),
        previousAmount: money.round(base),
        increasePercent: money.round(hikePct),
      });
    }
  }

  return anomalies;
}

// ---------- агрегатор ----------

/**
 * Находит аномалии по всем транзакциям пользователя.
 * @param {number} userId
 * @param {object} [opts] переопределение DEFAULTS + { notify:boolean }
 * @returns {Promise<Array<{transactionId, reason, severity}>>}
 */
async function detectForUser(userId, opts = {}) {
  if (!userId && userId !== 0) {
    throw new AppError(400, 'INVALID_USER', 'userId is required');
  }
  const cfg = { ...DEFAULTS, ...opts };

  const sinceDate = new Date(Date.now() - cfg.lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const transactions = await query(
    `SELECT id, account_id, user_id, date, description, category, amount, type
     FROM transactions
     WHERE user_id = ? AND date >= ?
     ORDER BY date ASC`,
    [userId, sinceDate]
  );

  const outliers = detectAmountOutliers(transactions, cfg);
  const duplicates = detectDuplicates(transactions, cfg);
  const hikes = await detectSubscriptionHikes(userId, cfg);

  let anomalies = [...outliers, ...duplicates, ...hikes];

  // Сортируем по серьёзности (high -> low), затем по дате (свежие выше).
  const sevRank = { high: 3, medium: 2, low: 1 };
  anomalies.sort((a, b) => {
    const s = (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0);
    if (s !== 0) return s;
    return String(b.date || '').localeCompare(String(a.date || ''));
  });

  // Опциональная запись уведомлений (дедуп — на стороне вызова, чтобы не
  // плодить дубликаты делаем простую проверку существующих за сутки).
  if (cfg.notify && anomalies.length) {
    try {
      const Notification = require('../models/notification');
      for (const a of anomalies) {
        const dataTag =
          a.transactionId != null
            ? `%"anomaly_ref":"tx:${a.transactionId}"%`
            : `%"anomaly_ref":"sub:${a.subscriptionId}"%`;
        const existing = await get(
          `SELECT id FROM notifications
           WHERE user_id = ? AND type = 'system' AND data LIKE ?
             AND created_at > date('now', '-1 day')`,
          [userId, dataTag]
        );
        if (existing) continue;
        await Notification.create({
          user_id: userId,
          type: Notification.TYPES.SYSTEM,
          title: 'Обнаружена аномалия в транзакциях',
          message: a.reason,
          data: {
            anomaly_ref:
              a.transactionId != null
                ? `tx:${a.transactionId}`
                : `sub:${a.subscriptionId}`,
            anomaly_type: a.type,
            severity: a.severity,
          },
        });
      }
    } catch (e) {
      // Уведомления — побочный эффект, не валим основной ответ.
      logger.warn({ err: e }, 'anomaly notify failed');
    }
  }

  return anomalies;
}

module.exports = {
  detectForUser,
  // экспортируем внутренние помощники для модульных тестов
  _internals: {
    mean,
    stdDev,
    percentile,
    detectAmountOutliers,
    detectDuplicates,
    DEFAULTS,
  },
};
