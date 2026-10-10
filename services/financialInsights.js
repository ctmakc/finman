// Deterministic, org-scoped financial signal engine. The AI layer narrates
// THESE pre-computed numbers instead of inventing them — this is what keeps
// the "AI CFO" grounded rather than generic/hallucinated.

const { query } = require('../db/database');
const orgScope = require('./orgScope');

const ANOMALY_FACTOR = 2.5; // a tx this far above its category norm is flagged
const ANOMALY_MIN_PRIOR = 2; // need at least this many priors to have a norm
const BUDGET_ALERT_PCT = 80;

function pad(n) {
  return String(n).padStart(2, '0');
}
function monthKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function monthStart(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}
function nextMonthStart(d) {
  const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-01`;
}
function prevMonthStart(d) {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${p.getFullYear()}-${pad(p.getMonth() + 1)}-01`;
}
function deltaPct(now, prev) {
  if (!prev) return now ? 100 : 0;
  return Math.round(((now - prev) / Math.abs(prev)) * 100);
}

async function buildDigest(principal, opts = {}) {
  const now = opts.now || new Date();
  const ids = await orgScope.scopeUserIds(principal);
  const ph = orgScope.placeholders(ids.length);

  const thisStart = monthStart(now);
  const thisEnd = nextMonthStart(now);
  const lastStart = prevMonthStart(now);

  // Pull this+last month plus a 90-day trailing window for anomaly norms.
  const windowStart = new Date(now.getTime() - 90 * 864e5)
    .toISOString()
    .slice(0, 10);
  const since = windowStart < lastStart ? windowStart : lastStart;

  const rows = await query(
    `SELECT date, category, amount, type
       FROM transactions
      WHERE user_id IN (${ph}) AND date >= ? AND date < ?`,
    [...ids, since, thisEnd]
  );

  const inMonth = (dt, s, e) => dt >= s && dt < e;
  let incomeThis = 0;
  let incomeLast = 0;
  let spendThis = 0;
  let spendLast = 0;
  const catThis = {};
  const catLast = {};

  for (const r of rows) {
    const isThis = inMonth(r.date, thisStart, thisEnd);
    const isLast = inMonth(r.date, lastStart, thisStart);
    if (r.type === 'income') {
      if (isThis) incomeThis += r.amount;
      else if (isLast) incomeLast += r.amount;
    } else if (r.type === 'expense') {
      const mag = Math.abs(r.amount);
      if (isThis) {
        spendThis += mag;
        catThis[r.category] = (catThis[r.category] || 0) + mag;
      } else if (isLast) {
        spendLast += mag;
        catLast[r.category] = (catLast[r.category] || 0) + mag;
      }
    }
  }

  const byCategory = Object.keys({ ...catThis, ...catLast })
    .map((category) => {
      const t = catThis[category] || 0;
      const l = catLast[category] || 0;
      return { category, thisMonth: t, lastMonth: l, deltaPct: deltaPct(t, l) };
    })
    .sort((a, b) => Math.abs(b.thisMonth - b.lastMonth) - Math.abs(a.thisMonth - a.lastMonth));

  const topMovers = byCategory
    .filter((c) => c.thisMonth > c.lastMonth)
    .slice(0, 3);

  // Anomalies: expense this month whose magnitude dwarfs the category's
  // trailing mean (computed from txns strictly before this month).
  const priorByCat = {};
  for (const r of rows) {
    if (r.type !== 'expense' || r.date >= thisStart) continue;
    (priorByCat[r.category] = priorByCat[r.category] || []).push(
      Math.abs(r.amount)
    );
  }
  const anomalies = [];
  for (const r of rows) {
    if (r.type !== 'expense' || !inMonth(r.date, thisStart, thisEnd)) continue;
    const priors = priorByCat[r.category] || [];
    if (priors.length < ANOMALY_MIN_PRIOR) continue;
    const mean = priors.reduce((s, x) => s + x, 0) / priors.length;
    const mag = Math.abs(r.amount);
    if (mean > 0 && mag > ANOMALY_FACTOR * mean) {
      anomalies.push({
        category: r.category,
        amount: mag,
        date: r.date,
        reason: `${(mag / mean).toFixed(1)}x the ${r.category} norm (~${Math.round(
          mean
        )})`,
      });
    }
  }

  // Budgets (org-scoped model) with this-month spend recomputed from txns.
  const Budget = require('../models/budget');
  let budgetRows = [];
  try {
    budgetRows = await Budget.getActiveBudgets(principal);
  } catch (_) {
    budgetRows = [];
  }
  const budgets = budgetRows.map((b) => {
    const spent = b.category ? catThis[b.category] || 0 : spendThis;
    const limit = b.amount || 0;
    const pctUsed = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0
    ).getDate();
    const projected = dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : spent;
    return {
      name: b.name,
      limit,
      spent,
      pctUsed,
      projectedBreach: limit > 0 && projected > limit,
    };
  });

  // Upcoming recurring (next 7d), org-scoped model.
  const RecurringPayment = require('../models/recurringPayment');
  let upcoming = [];
  try {
    upcoming = await RecurringPayment.getUpcoming(principal, 7);
  } catch (_) {
    upcoming = [];
  }
  const recurringUpcoming = upcoming
    .filter((p) => (p.type || 'expense') === 'expense')
    .reduce((s, p) => s + Math.abs(p.amount || 0), 0);

  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0
  ).getDate();
  const projectedSpend =
    dayOfMonth > 0 ? (spendThis / dayOfMonth) * daysInMonth : spendThis;
  const projectedNet = Math.round(
    incomeThis - projectedSpend - recurringUpcoming
  );

  const savingsRate =
    incomeThis > 0 ? (incomeThis - spendThis) / incomeThis : 0;

  return {
    period: monthKey(now),
    income: {
      thisMonth: incomeThis,
      lastMonth: incomeLast,
      deltaPct: deltaPct(incomeThis, incomeLast),
    },
    spend: {
      thisMonth: spendThis,
      lastMonth: spendLast,
      deltaPct: deltaPct(spendThis, spendLast),
    },
    byCategory,
    topMovers,
    anomalies,
    savingsRate,
    budgets,
    recurringUpcoming,
    cashFlow: { projectedNet },
  };
}

// Pure: turn a digest into a short, ranked list of actionable alerts.
function deriveAlerts(digest) {
  const alerts = [];
  for (const b of digest.budgets || []) {
    if (b.pctUsed >= BUDGET_ALERT_PCT || b.projectedBreach) {
      alerts.push({
        type: 'budget',
        severity: b.pctUsed >= 100 || b.projectedBreach ? 'high' : 'medium',
        message: `Budget "${b.name}" at ${b.pctUsed}% of its ${b.limit} limit${
          b.projectedBreach ? ' — on track to overspend' : ''
        }.`,
      });
    }
  }
  for (const a of digest.anomalies || []) {
    alerts.push({
      type: 'anomaly',
      severity: 'medium',
      message: `Unusual ${a.category} charge of ${a.amount} (${a.reason}).`,
    });
  }
  if (digest.cashFlow && digest.cashFlow.projectedNet < 0) {
    alerts.push({
      type: 'cashflow',
      severity: 'high',
      message: `This month is projected to end ${Math.abs(
        digest.cashFlow.projectedNet
      )} in the negative.`,
    });
  }
  if (typeof digest.savingsRate === 'number' && digest.savingsRate < 0) {
    alerts.push({
      type: 'savings',
      severity: 'high',
      message: 'You are spending more than you earn this month.',
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return alerts.sort((x, y) => rank[x.severity] - rank[y.severity]);
}

// Grounding context for the LLM + a guardrail instruction.
const GROUNDING_SYSTEM =
  'You are a personal CFO. Use ONLY the figures in the FINANCIAL DIGEST ' +
  'block for any numbers — never invent or estimate amounts. If asked for ' +
  'tax, legal or investment advice requiring a licensed professional, give ' +
  'general education only and recommend a qualified human. Be concise.';

function digestToPrompt(digest) {
  const cats = digest.byCategory
    .slice(0, 8)
    .map(
      (c) =>
        `  - ${c.category}: ${c.thisMonth} (was ${c.lastMonth}, ${
          c.deltaPct >= 0 ? '+' : ''
        }${c.deltaPct}%)`
    )
    .join('\n');
  return [
    `FINANCIAL DIGEST (${digest.period}):`,
    `Income this month: ${digest.income.thisMonth} (last ${digest.income.lastMonth})`,
    `Spend this month: ${digest.spend.thisMonth} (last ${digest.spend.lastMonth})`,
    `Savings rate: ${(digest.savingsRate * 100).toFixed(0)}%`,
    `Projected month-end net: ${digest.cashFlow.projectedNet}`,
    `Spend by category:\n${cats}`,
    digest.anomalies.length
      ? `Anomalies: ${digest.anomalies
          .map((a) => `${a.category} ${a.amount}`)
          .join(', ')}`
      : 'Anomalies: none',
  ].join('\n');
}

module.exports = {
  buildDigest,
  deriveAlerts,
  digestToPrompt,
  GROUNDING_SYSTEM,
};
