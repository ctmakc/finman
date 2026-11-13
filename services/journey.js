// services/journey.js — the path from sign-up to habit.
//
// Steps (order = the dashboard checklist):
//   first_insight   own money in (import, bank or a manual transaction; demo data does not count)
//   second_source   a second statement, a second account with data or a bank connection
//   budget          one active budget
//   goal            one active savings goal
//   weekly_review   opened "Your week in money" (in the app, from the email or a push)
//
// Streak: consecutive Monday–Sunday weeks (Toronto) with any activity in the
// app. The current week keeps the streak alive until it ends.
//
// Milestones (user_milestones, once per user) feed the OpenPanel funnel:
//   sign_up → activated → week1_active → week4_active
//   activated     = first own transaction
//   week1_active  = any activity 7+ days after sign-up
//   week4_active  = any activity 28+ days after sign-up (also sets week1_active)
// Each new milestone is one tracker event; users whose sign-up predates the
// tracking (no user_acquisition row or backfilled = 1) stay out of OpenPanel so
// old accounts do not flood the funnel with "today" events.
'use strict';

const { query, get, run } = require('../db/database');
const dates = require('../lib/dates');
const tracker = require('./tracker');
const logger = require('../lib/logger');

const TZ = 'America/Toronto';
const STEPS = ['first_insight', 'second_source', 'budget', 'goal', 'weekly_review'];
const STREAK_BADGES = [2, 4, 8, 12, 26, 52];
const DAY_MS = 86400000;
// Events the server writes on the user's behalf: they are not the user showing up.
const SYSTEM_EVENTS = ['activated', 'week1_active', 'week4_active', 'journey_step_done', 'badge_earned',
  'checklist_dismissed', 'weekly_email_sent', 'monthly_email_sent', 'push_sent', 'email_unsubscribe',
  'referral_signup', 'friend_joined'];
const SYSTEM_SQL = SYSTEM_EVENTS.map((e) => `'${e}'`).join(', ');

// ---------- pure helpers (unit-tested) ----------

// Monday (YYYY-MM-DD) of the week that contains the ISO date.
function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return dates.addDaysISO(iso, -dow);
}

// Streak over a set of active days (ISO dates, Toronto).
//   current  weeks in a row up to this week (or last week while this one is still empty)
//   best     longest run in the data
//   thisWeek active days this week as booleans Mon..Sun
function streakFrom(activeDays, todayIso) {
  const weeks = new Set(activeDays.map(weekStart));
  const thisMonday = weekStart(todayIso);
  let cursor = weeks.has(thisMonday) ? thisMonday : dates.addDaysISO(thisMonday, -7);
  let current = 0;
  while (weeks.has(cursor)) { current += 1; cursor = dates.addDaysISO(cursor, -7); }
  const sorted = Array.from(weeks).sort();
  let best = 0;
  let run_ = 0;
  let prev = null;
  for (const w of sorted) {
    run_ = prev && dates.addDaysISO(prev, 7) === w ? run_ + 1 : 1;
    if (run_ > best) best = run_;
    prev = w;
  }
  const daySet = new Set(activeDays);
  const thisWeek = [];
  for (let i = 0; i < 7; i += 1) thisWeek.push(daySet.has(dates.addDaysISO(thisMonday, i)));
  return { current, best: Math.max(best, current), thisWeek, activeThisWeek: weeks.has(thisMonday) };
}

function torontoDate(utcSql) {
  const s = String(utcSql || '').replace(' ', 'T');
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return dates.todayISO(TZ, d);
}

// ---------- data ----------

async function ownTxStats(userId) {
  const row = await get(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT t.account_id) AS accounts, MIN(t.date) AS first_date, MAX(t.date) AS last_date
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND COALESCE(a.is_demo, 0) = 0`,
    [userId],
  ).catch(() => null);
  return row || { n: 0, accounts: 0 };
}

async function count(sql, params) {
  const row = await get(sql, params).catch(() => null);
  return (row && Number(row.n)) || 0;
}

async function milestones(userId) {
  const rows = await query('SELECT key, at, props FROM user_milestones WHERE user_id = ?', [userId]).catch(() => []);
  const out = {};
  for (const r of rows) out[r.key] = r.at;
  return out;
}

async function activeDays(userId, sinceDays = 400) {
  const rows = await query(
    `SELECT DISTINCT substr(datetime(created_at, '-5 hours'), 1, 10) AS d
       FROM analytics_events
      WHERE user_id = ? AND created_at >= datetime('now', ?) AND event NOT IN (${SYSTEM_SQL})`,
    [userId, `-${sinceDays} days`],
  ).catch(() => []);
  return rows.map((r) => r.d).filter(Boolean);
}

async function userRow(userId) {
  return get(
    `SELECT u.id, u.email, u.created_at, u.referred_by, u.ref_code, ua.backfilled
       FROM users u LEFT JOIN user_acquisition ua ON ua.user_id = u.id
      WHERE u.id = ?`,
    [userId],
  ).catch(() => null);
}

// Whether this user's events belong in OpenPanel at all.
function trackable(u) {
  return Boolean(u) && u.backfilled != null && Number(u.backfilled) === 0;
}

// Record a milestone once; returns true when it is new.
async function mark(u, key, props) {
  const res = await run(
    'INSERT OR IGNORE INTO user_milestones (user_id, key, props) VALUES (?, ?, ?)',
    [u.id, key, props ? JSON.stringify(props).slice(0, 500) : null],
  ).catch((e) => { logger.warn({ err: e.message, key }, '[journey] mark failed'); return null; });
  const isNew = Boolean(res && res.changes);
  if (isNew) {
    const test = tracker.isTestEmail(u.email) || !trackable(u);
    let event = key;
    let evProps = props || {};
    if (key.startsWith('step_')) { event = 'journey_step_done'; evProps = { step: key.slice(5), ...evProps }; }
    else if (key.startsWith('badge_')) { event = 'badge_earned'; evProps = { badge: key.slice(6), ...evProps }; }
    else if (key.startsWith('weekly_review:')) { event = 'weekly_review_opened'; evProps = { week: key.slice(14), ...evProps }; }
    tracker.track(event, { userId: u.id, props: evProps, test });
  }
  return isNew;
}

// Compute the journey; with { record: true } also store new milestones (and send their events).
async function compute(userId, { record = true, now = new Date() } = {}) {
  const u = await userRow(userId);
  if (!u) return null;
  const today = dates.todayISO(TZ, now);
  const tx = await ownTxStats(userId);
  const [imports, banks, budgets, goals, ms, days] = await Promise.all([
    count(`SELECT COUNT(*) AS n FROM analytics_events WHERE user_id = ? AND event = 'import_done'`, [userId]),
    count('SELECT COUNT(*) AS n FROM bank_connections WHERE user_id = ? AND is_active = 1', [userId]),
    count('SELECT COUNT(*) AS n FROM budgets WHERE user_id = ? AND is_active = 1', [userId]),
    count('SELECT COUNT(*) AS n FROM savings_goals WHERE user_id = ? AND is_active = 1', [userId]),
    milestones(userId),
    activeDays(userId),
  ]);
  const reviewed = Object.keys(ms).some((k) => k.startsWith('weekly_review:'));

  const done = {
    first_insight: Number(tx.n) > 0,
    second_source: imports >= 2 || banks > 0 || Number(tx.accounts) >= 2,
    budget: budgets > 0,
    goal: goals > 0,
    weekly_review: reviewed,
  };
  const streak = streakFrom(days, today);

  const signupAgeDays = u.created_at ? Math.floor((now.getTime() - new Date(`${String(u.created_at).replace(' ', 'T')}Z`).getTime()) / DAY_MS) : 0;
  const lastActive = days.length ? days.slice().sort().pop() : null;
  const lastActiveAge = lastActive ? dates.diffDays(u.created_at ? torontoDate(u.created_at) : lastActive, lastActive) : 0;

  const fresh = [];
  if (record) {
    const add = async (key, props) => { if (!ms[key] && (await mark(u, key, props))) { ms[key] = new Date().toISOString(); fresh.push(key); } };
    if (done.first_insight) await add('activated', { tx: Number(tx.n), via: imports > 0 ? 'import' : (banks > 0 ? 'bank' : 'manual'), days_from_signup: signupAgeDays });
    if (lastActiveAge >= 7) await add('week1_active', { days_from_signup: lastActiveAge });
    if (lastActiveAge >= 28) await add('week4_active', { days_from_signup: lastActiveAge });
    for (const s of STEPS) if (done[s]) await add(`step_${s}`);
    for (const n of STREAK_BADGES) if (streak.best >= n) await add(`badge_streak_${n}`, { weeks: n });
    if (STEPS.every((s) => done[s])) await add('badge_journey_done');
  }

  const steps = STEPS.map((key) => ({ key, done: done[key], at: ms[`step_${key}`] || null }));
  const next = steps.find((s) => !s.done) || null;
  const badges = Object.keys(ms).filter((k) => k.startsWith('badge_')).map((k) => ({ key: k.slice(6), at: ms[k] }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const nextBadge = STREAK_BADGES.find((n) => n > streak.current) || null;

  return {
    steps,
    doneCount: steps.filter((s) => s.done).length,
    total: steps.length,
    next: next ? next.key : null,
    complete: !next,
    dismissed: Boolean(ms.checklist_dismissed),
    streak: { ...streak, nextBadge },
    badges,
    fresh,
    data: { transactions: Number(tx.n), lastDate: tx.last_date || null, imports, budgets, goals },
  };
}

// Throttled sync after writes and app opens (fire-and-forget).
const lastSync = new Map();
function touch(userId) {
  if (!userId) return;
  const now = Date.now();
  if (now - (lastSync.get(userId) || 0) < 15000) return;
  lastSync.set(userId, now);
  if (lastSync.size > 5000) lastSync.clear();
  compute(userId, { record: true }).catch((e) => logger.warn({ err: e.message }, '[journey] sync failed'));
}

// Daily sweep: users active in the last 3 days get their milestones recomputed
// (week1/week4 also appear for users who came back without writing anything).
async function sweep({ now = new Date() } = {}) {
  const users = await query(
    `SELECT DISTINCT user_id AS id FROM analytics_events
      WHERE user_id IS NOT NULL AND created_at >= datetime('now', '-3 days') AND event NOT IN (${SYSTEM_SQL})`,
  ).catch(() => []);
  let n = 0;
  for (const { id } of users) {
    try { await compute(id, { record: true, now }); n += 1; } catch (e) { logger.warn({ err: e.message, id }, '[journey] sweep user failed'); }
  }
  return { users: n };
}

async function markReviewed(userId, week, source) {
  const u = await userRow(userId);
  if (!u) return false;
  const isNew = await mark(u, `weekly_review:${week}`, { source: source || 'app' });
  touch(userId);
  return isNew;
}

async function dismiss(userId) {
  const u = await userRow(userId);
  if (u) await mark(u, 'checklist_dismissed');
}

module.exports = {
  SYSTEM_EVENTS, STEPS, STREAK_BADGES, weekStart, streakFrom, torontoDate,
  compute, touch, sweep, markReviewed, dismiss, mark, userRow, trackable,
};
