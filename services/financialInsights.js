// services/financialInsights.js — deterministic financial signal engine (PORT_PLAN A8).
// Ported from production; production's orgScope principal is replaced by a plain userId.
//
// The AI layer narrates THESE pre-computed numbers instead of inventing them — this is what
// keeps the "AI CFO" grounded. Everything here is pure SQL + arithmetic; the only LLM calls
// live in monthlyInsight() / weeklyBrief(), both of which degrade to a deterministic text
// when no provider is configured.
//
// Exports:
//   buildDigest(userId, { now })            -> digest (income/spend deltas, top movers, anomalies,
//                                              budgets + projections, upcoming recurring, savings rate)
//   deriveAlerts(digest)                    -> ranked actionable alerts (pure)
//   digestToPrompt(digest)                  -> FINANCIAL DIGEST text block for the system prompt (pure)
//   GROUNDING_SYSTEM                        -> guardrail instruction for the LLM
//   monthlyInsight(userId, { month, now, refresh }) -> { insight, cached, aiUsed, provider, model }
//   weeklyBrief(userId, { now })            -> { brief, totalSpent, totalEarned, transactionCount, aiUsed }

const { query, get, run } = require('../db/database');
const provider = require('../lib/ai/provider');
const logger = require('../lib/logger');

const ANOMALY_FACTOR = 2.5; // a tx this far above its category norm is flagged
const ANOMALY_MIN_PRIOR = 2; // need at least this many priors to have a norm
const BUDGET_ALERT_PCT = 80;
const DIGEST_CATEGORY_LIMIT = 8;

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
function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function deltaPct(now, prev) {
  if (!prev) return now ? 100 : 0;
  return Math.round(((now - prev) / Math.abs(prev)) * 100);
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
// Accept either a user object ({ id }) or a bare id.
function toUserId(userOrId) {
  if (userOrId && typeof userOrId === 'object') return userOrId.id;
  return userOrId;
}

// ---------------------------------------------------------------------------
// buildDigest — the deterministic core.
// ---------------------------------------------------------------------------

async function buildDigest(userOrId, opts = {}) {
  const userId = toUserId(userOrId);
  const now = opts.now || new Date();

  const thisStart = monthStart(now);
  const thisEnd = nextMonthStart(now);
  const lastStart = prevMonthStart(now);

  // Pull this+last month plus a 90-day trailing window for anomaly norms.
  const windowStart = isoDate(new Date(now.getTime() - 90 * 864e5));
  const since = windowStart < lastStart ? windowStart : lastStart;

  const rows = await query(
    `SELECT date, COALESCE(category, 'Uncategorized') AS category, amount, type
       FROM transactions
      WHERE user_id = ? AND date >= ? AND date < ?`,
    [userId, since, thisEnd]
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
      const mag = Math.abs(r.amount);
      if (isThis) incomeThis += mag;
      else if (isLast) incomeLast += mag;
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
  incomeThis = round2(incomeThis);
  incomeLast = round2(incomeLast);
  spendThis = round2(spendThis);
  spendLast = round2(spendLast);

  const byCategory = Object.keys({ ...catThis, ...catLast })
    .map((category) => {
      const t = round2(catThis[category] || 0);
      const l = round2(catLast[category] || 0);
      return { category, thisMonth: t, lastMonth: l, deltaPct: deltaPct(t, l) };
    })
    .sort((a, b) => Math.abs(b.thisMonth - b.lastMonth) - Math.abs(a.thisMonth - a.lastMonth));

  const topMovers = byCategory.filter((c) => c.thisMonth > c.lastMonth).slice(0, 3);

  // Anomalies: expense this month whose magnitude dwarfs the category's
  // trailing mean (computed from txns strictly before this month).
  const priorByCat = {};
  for (const r of rows) {
    if (r.type !== 'expense' || r.date >= thisStart) continue;
    (priorByCat[r.category] = priorByCat[r.category] || []).push(Math.abs(r.amount));
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
        amount: round2(mag),
        date: r.date,
        reason: `${(mag / mean).toFixed(1)}x the ${r.category} norm (~${Math.round(mean)})`,
      });
    }
  }

  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  // Budgets with this-month spend recomputed from transactions.
  const Budget = require('../models/budget');
  let budgetRows = [];
  try {
    budgetRows = await Budget.getActiveBudgets(userId);
  } catch (err) {
    logger.warn({ err: err && err.message }, 'financialInsights: budgets unavailable');
    budgetRows = [];
  }
  const budgets = budgetRows.map((b) => {
    const spent = round2(b.category ? catThis[b.category] || 0 : spendThis);
    const limit = round2(b.effectiveLimit != null ? b.effectiveLimit : b.amount || 0);
    const pctUsed = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    const projected = dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : spent;
    return {
      name: b.name,
      category: b.category || null,
      limit,
      spent,
      pctUsed,
      projectedBreach: limit > 0 && projected > limit,
    };
  });

  // Upcoming recurring expenses (next 7 days).
  const RecurringPayment = require('../models/recurringPayment');
  let upcoming = [];
  try {
    upcoming = await RecurringPayment.getUpcoming(userId, 7);
  } catch (err) {
    logger.warn({ err: err && err.message }, 'financialInsights: recurring payments unavailable');
    upcoming = [];
  }
  const recurringUpcoming = round2(
    upcoming
      .filter((p) => (p.type || 'expense') === 'expense')
      .reduce((s, p) => s + Math.abs(p.amount || 0), 0)
  );

  const projectedSpend = dayOfMonth > 0 ? (spendThis / dayOfMonth) * daysInMonth : spendThis;
  const projectedNet = Math.round(incomeThis - projectedSpend - recurringUpcoming);

  const savingsRate = incomeThis > 0 ? (incomeThis - spendThis) / incomeThis : 0;

  return {
    period: monthKey(now),
    income: { thisMonth: incomeThis, lastMonth: incomeLast, deltaPct: deltaPct(incomeThis, incomeLast) },
    spend: { thisMonth: spendThis, lastMonth: spendLast, deltaPct: deltaPct(spendThis, spendLast) },
    byCategory,
    topMovers,
    anomalies,
    savingsRate,
    budgets,
    recurringUpcoming,
    cashFlow: { projectedNet, projectedSpend: round2(projectedSpend) },
  };
}

// ---------------------------------------------------------------------------
// deriveAlerts — pure: digest -> short, ranked list of actionable alerts.
// ---------------------------------------------------------------------------

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
      message: `Unusual ${a.category} charge of ${a.amount} — ${a.reason}.`,
    });
  }
  if (digest.cashFlow && digest.cashFlow.projectedNet < 0) {
    alerts.push({
      type: 'cashflow',
      severity: 'high',
      message: `This month is projected to end ${Math.abs(digest.cashFlow.projectedNet)} in the negative.`,
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

// ---------------------------------------------------------------------------
// Grounding context for the LLM + a guardrail instruction.
// ---------------------------------------------------------------------------

const GROUNDING_SYSTEM =
  'You are a personal CFO. Use ONLY the figures in the FINANCIAL DIGEST ' +
  'block for any numbers — never invent or estimate amounts. If asked for ' +
  'tax, legal or investment advice requiring a licensed professional, give ' +
  'general education only and recommend a qualified human. Be concise.';

function digestToPrompt(digest) {
  const cats = (digest.byCategory || [])
    .slice(0, DIGEST_CATEGORY_LIMIT)
    .map(
      (c) =>
        `  - ${c.category}: ${c.thisMonth} (was ${c.lastMonth}, ${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct}%)`
    )
    .join('\n');
  return [
    `FINANCIAL DIGEST (${digest.period}):`,
    `Income this month: ${digest.income.thisMonth} (last ${digest.income.lastMonth})`,
    `Spend this month: ${digest.spend.thisMonth} (last ${digest.spend.lastMonth})`,
    `Savings rate: ${(digest.savingsRate * 100).toFixed(0)}%`,
    `Projected month-end net: ${digest.cashFlow.projectedNet}`,
    `Upcoming recurring (7d): ${digest.recurringUpcoming}`,
    `Spend by category:\n${cats || '  (no spending yet)'}`,
    digest.anomalies.length
      ? `Anomalies: ${digest.anomalies.map((a) => `${a.category} ${a.amount}`).join(', ')}`
      : 'Anomalies: none',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic fallbacks (no provider). Numbers only from the digest.
// ---------------------------------------------------------------------------

// "2026-10" -> "October 2026" (English copy for the new UI strings).
function periodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return period || '';
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const idx = parseInt(m[2], 10) - 1;
  return names[idx] ? `${names[idx]} ${m[1]}` : period;
}

function fallbackMonthlyStory(digest) {
  const inc = digest.income.thisMonth;
  const sp = digest.spend.thisMonth;
  const label = periodLabel(digest.period);
  const parts = [];
  if (!inc && !sp) {
    parts.push(`No income or spending recorded for ${label} yet.`);
    return parts.join(' ');
  }
  parts.push(`In ${label} you earned ${inc} and spent ${sp}.`);
  if (digest.spend.lastMonth) {
    parts.push(
      `Spending is ${digest.spend.deltaPct >= 0 ? 'up' : 'down'} ${Math.abs(digest.spend.deltaPct)}% versus last month (${digest.spend.lastMonth}).`
    );
  }
  if (digest.topMovers.length) {
    const m = digest.topMovers[0];
    parts.push(`Biggest increase: ${m.category} at ${m.thisMonth} (was ${m.lastMonth}).`);
  }
  if (inc > 0) {
    parts.push(`Savings rate so far: ${(digest.savingsRate * 100).toFixed(0)}%.`);
  }
  parts.push(
    digest.cashFlow.projectedNet >= 0
      ? `At this pace the month ends about ${digest.cashFlow.projectedNet} ahead.`
      : `At this pace the month ends about ${Math.abs(digest.cashFlow.projectedNet)} short — trim the top category to close the gap.`
  );
  return parts.join(' ');
}

function fallbackWeeklyBrief(week) {
  if (!week.transactionCount) {
    return 'No transactions in the last 7 days.';
  }
  const bits = [`Last 7 days: ${week.transactionCount} transactions, spent ${week.totalSpent}, earned ${week.totalEarned}.`];
  if (week.topCategory) {
    bits.push(`Most of it went to ${week.topCategory.category} (${week.topCategory.total}).`);
  }
  if (week.busiestDay) {
    bits.push(`Busiest day: ${week.busiestDay.date} with ${week.busiestDay.spent} spent.`);
  }
  return bits.join(' ');
}

// ---------------------------------------------------------------------------
// monthlyInsight — "monthly financial story", cached in ai_insights.
// ---------------------------------------------------------------------------

function normalizeMonth(month, now) {
  if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)) return month;
  return monthKey(now);
}

// Build a Date inside the requested month so buildDigest treats it as "this month".
// For the current month we keep `now` (projections use the real day of month);
// for a past month we use its last day (the month is complete).
function anchorForMonth(month, now) {
  if (month === monthKey(now)) return now;
  const [y, m] = month.split('-').map((x) => parseInt(x, 10));
  return new Date(y, m, 0); // day 0 of next month = last day of `month`
}

async function monthlyInsight(userOrId, opts = {}) {
  const userId = toUserId(userOrId);
  const now = opts.now || new Date();
  const month = normalizeMonth(opts.month, now);

  if (!opts.refresh) {
    const cached = await get(
      `SELECT content, model FROM ai_insights WHERE user_id = ? AND period = ? AND type = 'monthly'`,
      [userId, month]
    );
    if (cached) {
      let insight = null;
      try {
        insight = JSON.parse(cached.content);
      } catch (_) {
        insight = null;
      }
      if (insight) return { insight, cached: true, aiUsed: Boolean(insight.aiUsed), model: cached.model || null };
    }
  }

  const digest = await buildDigest(userId, { now: anchorForMonth(month, now) });
  const insight = {
    month,
    totalIncome: digest.income.thisMonth,
    totalSpent: digest.spend.thisMonth,
    savingsRate: digest.savingsRate,
    topMovers: digest.topMovers,
    text: '',
    aiUsed: false,
  };
  let model = null;
  let aiError = null;

  if (provider.isConfigured()) {
    try {
      const result = await provider.chat({
        system: `${GROUNDING_SYSTEM}\n\n${digestToPrompt(digest)}`,
        messages: [
          {
            role: 'user',
            content:
              'Write a brief monthly financial story (3-4 sentences) for the period above. ' +
              'Be specific with the digest numbers, highlight the single most important insight, ' +
              'and end with one actionable tip.',
          },
        ],
        maxTokens: 400,
      });
      insight.text = (result && result.text) || '';
      insight.aiUsed = Boolean(insight.text);
      model = (result && result.model) || null;
    } catch (err) {
      // A provider outage (quota, network) must not take the dashboard down:
      // fall back to the deterministic story and report the failure code.
      aiError = (err && err.code) || 'AI_REQUEST_FAILED';
      logger.warn({ err: err && err.message, userId }, 'monthlyInsight: provider failed, deterministic fallback');
    }
  }
  if (!insight.text) {
    insight.text = fallbackMonthlyStory(digest);
    insight.aiUsed = false;
  }

  // Cache only AI-generated stories; deterministic text is cheap to recompute and
  // should pick up a provider the moment one is configured.
  if (insight.aiUsed) {
    await run(`DELETE FROM ai_insights WHERE user_id = ? AND period = ? AND type = 'monthly'`, [userId, month]);
    await run(
      `INSERT INTO ai_insights (user_id, period, type, content, model) VALUES (?, ?, 'monthly', ?, ?)`,
      [userId, month, JSON.stringify(insight), model]
    );
  }

  return { insight, cached: false, aiUsed: insight.aiUsed, model, aiError };
}

// ---------------------------------------------------------------------------
// weeklyBrief — last 7 days, grounded on the digest. Not cached (recency matters).
// ---------------------------------------------------------------------------

async function weeklyBrief(userOrId, opts = {}) {
  const userId = toUserId(userOrId);
  const now = opts.now || new Date();
  const since = isoDate(new Date(now.getTime() - 7 * 864e5));
  const until = isoDate(now);

  const [transactions, dailyTotals] = await Promise.all([
    query(
      `SELECT amount, description, date, type, COALESCE(category, 'Uncategorized') AS category
         FROM transactions
        WHERE user_id = ? AND date >= ? AND date <= ? AND type IN ('income', 'expense')
        ORDER BY date DESC, id DESC`,
      [userId, since, until]
    ),
    query(
      `SELECT date,
              SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END) AS spent,
              SUM(CASE WHEN type = 'income' THEN ABS(amount) ELSE 0 END) AS earned
         FROM transactions
        WHERE user_id = ? AND date >= ? AND date <= ? AND type IN ('income', 'expense')
        GROUP BY date ORDER BY date`,
      [userId, since, until]
    ),
  ]);

  const totalSpent = round2(
    transactions.filter((t) => t.type === 'expense').reduce((s, t) => s + Math.abs(t.amount), 0)
  );
  const totalEarned = round2(
    transactions.filter((t) => t.type === 'income').reduce((s, t) => s + Math.abs(t.amount), 0)
  );
  const byCat = {};
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    byCat[t.category] = (byCat[t.category] || 0) + Math.abs(t.amount);
  }
  const topCategory = Object.keys(byCat)
    .map((category) => ({ category, total: round2(byCat[category]) }))
    .sort((a, b) => b.total - a.total)[0] || null;
  const busiestDay =
    dailyTotals
      .map((d) => ({ date: d.date, spent: round2(d.spent), earned: round2(d.earned) }))
      .sort((a, b) => b.spent - a.spent)[0] || null;

  const week = {
    since,
    until,
    totalSpent,
    totalEarned,
    transactionCount: transactions.length,
    topCategory,
    busiestDay: busiestDay && busiestDay.spent > 0 ? busiestDay : null,
    dailyTotals: dailyTotals.map((d) => ({ date: d.date, spent: round2(d.spent), earned: round2(d.earned) })),
  };

  let brief = '';
  let aiUsed = false;
  let aiError = null;
  if (provider.isConfigured() && transactions.length) {
    try {
    const digest = await buildDigest(userId, { now });
    const weekData = {
      since,
      totalSpent,
      totalEarned,
      dailyTotals: week.dailyTotals,
      recentTransactions: transactions.slice(0, 10).map((t) => ({
        date: t.date,
        amount: round2(t.amount),
        type: t.type,
        category: t.category,
        description: t.description,
      })),
    };
    const result = await provider.chat({
      system: `${GROUNDING_SYSTEM}\n\n${digestToPrompt(digest)}`,
      messages: [
        {
          role: 'user',
          content:
            'Write a 2-3 sentence weekly spending brief. Be specific, casual and friendly. ' +
            'Use the FINANCIAL DIGEST for the month context and the week data below for recency.\n\n' +
            `Week data: ${JSON.stringify(weekData)}`,
        },
      ],
      maxTokens: 300,
    });
    brief = (result && result.text) || '';
    aiUsed = Boolean(brief);
    } catch (err) {
      aiError = (err && err.code) || 'AI_REQUEST_FAILED';
      logger.warn({ err: err && err.message, userId }, 'weeklyBrief: provider failed, deterministic fallback');
    }
  }
  if (!brief) brief = fallbackWeeklyBrief(week);

  return {
    brief,
    since,
    totalSpent,
    totalEarned,
    transactionCount: transactions.length,
    topCategory,
    dailyTotals: week.dailyTotals,
    aiUsed,
    aiError,
  };
}

module.exports = {
  buildDigest,
  deriveAlerts,
  digestToPrompt,
  GROUNDING_SYSTEM,
  monthlyInsight,
  weeklyBrief,
  // test hooks
  _internal: { fallbackMonthlyStory, fallbackWeeklyBrief, anchorForMonth, normalizeMonth, periodLabel },
};
