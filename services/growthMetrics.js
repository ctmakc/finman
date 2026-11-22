// services/growthMetrics.js — sign-ups, the path to the first report, activation and returns,
// from the event journal only (analytics_events + user_acquisition + users.created_at).
//
// Why events: Finman Vault users keep no readable rows on the server; their actions reach
// the journal through POST /api/t/me (event names only). Output is aggregates only: no
// emails, names or ids. Test accounts (*.test, +smoke) and the team (ADMIN_EMAILS) are
// kept apart.
//
// Used by scripts/growth-metrics.js (CLI), the Monday team email (runWeekly, lifecycle cron)
// and the team page /admin (GET /api/feedback/admin/metrics).
'use strict';

const VISIT = ['app_open', 'login'];
const ACTIVATE = ['activated', 'import_done', 'transaction_added', 'transfer_added', 'receipt_scanned', 'vault_import_done', 'vault_transaction_added', 'onboarding_import_done'];
// Events the server writes on its own (emails, badges, journey ticks): not a visit.
const SERVER_ONLY = new Set(['email_sent', 'weekly_email_sent', 'weekly_note_sent', 'monthly_email_sent', 'badge_earned', 'journey_step_done',
  'activated', 'sign_up', 'account_deleted', 'vault_purged', 'push_sent', 'email_unsubscribe']);
const FUNNEL = [
  ['signed_up', null],
  ['vault_ready', ['vault_setup', 'vault_key_saved']],
  ['first_screen', ['onboarding_firstrun_shown']],
  ['picked_a_path', ['onboarding_import_started', 'onboarding_demo_loaded', 'onboarding_scratch_started', 'onboarding_bank_picked', 'onboarding_example_opened', 'import_preview', 'import_failed', 'statement_read']],
  ['first_account', ['account_created', 'onboarding_quickstart', 'import_done', 'onboarding_import_done']],
  ['own_data_in', ACTIVATE],
  ['first_report', ['report_viewed', 'onboarding_insight_shown']],
];

const isTest = (e) => /@[^@]+\.test$/i.test(e || '') || /\+smoke[^@]*@/i.test(e || '');
const day = (s) => String(s).slice(0, 10);
const days = (a, b) => (Date.parse(day(b)) - Date.parse(day(a))) / 86400000;
function weekOf(s) {
  const d = new Date(day(s) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function sourceClass(a) {
  const s = `${(a && a.utm_source) || ''} ${(a && a.source) || ''} ${(a && a.referrer) || ''} ${(a && a.site_referrer) || ''}`.toLowerCase();
  if (/chatgpt|openai/.test(s)) return 'chatgpt';
  if (/perplexity|claude\.ai|gemini|copilot/.test(s)) return 'other_ai';
  if (/google/.test(s)) return 'google';
  if (/bing|duckduckgo|yahoo/.test(s)) return 'other_search';
  if (/finman\.money/.test(s)) return 'site_no_referrer';
  return 'direct_app';
}

// Pure: users [{id,email,created_at,utm_source,source,referrer,site_referrer,country}],
// events [{user_id,event,created_at,props}], deletedCount, admins [emails], now (ISO).
function compute({ users, events, deletedCount = 0, admins = [], now = new Date().toISOString(), since }) {
  const byUser = new Map();
  for (const e of events) { if (!byUser.has(e.user_id)) byUser.set(e.user_id, []); byUser.get(e.user_id).push(e); }
  const adminSet = new Set(admins.map((a) => String(a).toLowerCase()));
  const out = {
    since, generated_at: now, users_alive: 0, excluded: { test: 0, team: 0 }, deleted_accounts: deletedCount,
    funnel: Object.fromEntries(FUNNEL.map(([k]) => [k, 0])), import_failed_codes: {}, statements_read: 0,
    by_source: {}, by_week: {}, by_country_ca: 0, activated: 0, activated_by: {},
    week1: { eligible: 0, returned: 0 }, week4: { eligible: 0, returned: 0 },
  };
  for (const u of users) {
    if (isTest(u.email)) { out.excluded.test++; continue; }
    if (adminSet.has(String(u.email || '').toLowerCase())) { out.excluded.team++; continue; }
    out.users_alive++;
    const src = sourceClass(u);
    out.by_source[src] = (out.by_source[src] || 0) + 1;
    if (u.country === 'CA') out.by_country_ca++;
    const wk = weekOf(u.created_at);
    const W = out.by_week[wk] = out.by_week[wk] || { signups: 0, activated: 0, week1_eligible: 0, week1_returned: 0, week4_eligible: 0, week4_returned: 0 };
    W.signups++;
    const list = byUser.get(u.id) || [];
    const names = new Set(list.map((e) => e.event));
    for (const [k, evs] of FUNNEL) if (!evs || evs.some((n) => names.has(n))) out.funnel[k]++;
    for (const e of list) {
      if (e.event === 'statement_read') out.statements_read++;
      if (e.event !== 'import_failed') continue;
      let code = 'unknown';
      try { code = (JSON.parse(e.props || '{}').code) || 'unknown'; } catch (_) { /* keep */ }
      out.import_failed_codes[code] = (out.import_failed_codes[code] || 0) + 1;
    }
    const act = list.filter((e) => ACTIVATE.includes(e.event)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    if (act.length) {
      out.activated++; W.activated++;
      out.activated_by[act[0].event] = (out.activated_by[act[0].event] || 0) + 1;
    }
    // A return = a visit or an own action on a later calendar day than sign-up.
    const activeDays = new Set(list.filter((e) => VISIT.includes(e.event) || !SERVER_ONLY.has(e.event)).map((e) => day(e.created_at)));
    const age = days(u.created_at, now);
    const back = (from, to) => [...activeDays].some((d) => { const k = days(u.created_at, d); return k >= from && k <= to; });
    if (age >= 7) { out.week1.eligible++; W.week1_eligible++; if (back(1, 7)) { out.week1.returned++; W.week1_returned++; } }
    if (age >= 28) { out.week4.eligible++; W.week4_eligible++; if (back(22, 28)) { out.week4.returned++; W.week4_returned++; } }
  }
  return out;
}

// From the app's own database helpers (db/database.js query).
async function load({ query, since = '2026-11-03', now = new Date() } = {}) {
  const users = await query(
    `SELECT u.id, u.email, u.created_at, a.utm_source, a.source, a.referrer, a.site_referrer, a.country
       FROM users u LEFT JOIN user_acquisition a ON a.user_id = u.id WHERE u.created_at >= ?`, [since]);
  const events = await query(
    `SELECT e.user_id, e.event, e.created_at, e.props FROM analytics_events e
       JOIN users u ON u.id = e.user_id WHERE u.created_at >= ?`, [since]);
  const del = await query(`SELECT COUNT(*) AS n FROM analytics_events WHERE event = 'account_deleted' AND created_at >= ?`, [since]);
  const admins = String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return compute({ users, events, deletedCount: Number(del[0] && del[0].n) || 0, admins, now: now.toISOString(), since });
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

// Plain-text and HTML lines of a snapshot (for the team email and logs).
function describe(m) {
  const f = m.funnel;
  const weeks = Object.keys(m.by_week).sort().slice(-6);
  const lines = [
    `Live accounts since ${m.since}: ${m.users_alive} (${m.deleted_accounts} deleted themselves; test ${m.excluded.test}, team ${m.excluded.team} left out)`,
    `Path: signed up ${f.signed_up} → vault ready ${f.vault_ready} → first screen ${f.first_screen} → picked a path ${f.picked_a_path} → first account ${f.first_account} → own data ${f.own_data_in} → first report ${f.first_report}`,
    `Activated: ${m.activated} of ${m.users_alive} (${pct(m.activated, m.users_alive)})`,
    `Came back in week 1: ${m.week1.returned} of ${m.week1.eligible} (${pct(m.week1.returned, m.week1.eligible)}) · week 4: ${m.week4.returned} of ${m.week4.eligible} (${pct(m.week4.returned, m.week4.eligible)})`,
    `Sources: ${Object.entries(m.by_source).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} · Canada ${m.by_country_ca}`,
    `PDF statements read: ${m.statements_read} · import failures: ${Object.entries(m.import_failed_codes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    'By sign-up week (sign-ups / activated / back in week 1 / back in week 4):',
    ...weeks.map((w) => {
      const x = m.by_week[w];
      return `  ${w}: ${x.signups} / ${x.activated} / ${x.week1_eligible ? `${x.week1_returned} of ${x.week1_eligible}` : 'too early'} / ${x.week4_eligible ? `${x.week4_returned} of ${x.week4_eligible}` : 'too early'}`;
    }),
  ];
  return lines;
}

// Monday team email (lifecycle cron, 13:00 UTC): once per week, aggregates only.
async function runWeekly({ now = new Date(), dryRun = false } = {}) {
  const { query, get, run } = require('../db/database');
  const dates = require('../lib/dates');
  const today = dates.todayISO('America/Toronto', now);
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return { skipped: 'not monday' };
  const kind = `metrics:${today}`;
  if (await get('SELECT 1 AS x FROM lifecycle_emails WHERE user_id = 0 AND kind = ?', [kind]).catch(() => null)) return { skipped: 'already sent' };
  const m = await load({ query, now });
  const lines = describe(m);
  if (dryRun) return { lines };
  const to = (process.env.ACTIVITY_DIGEST_TO || process.env.LEAD_NOTIFY_TO || 'ctmakc@gmail.com').split(',').map((s) => s.trim()).filter(Boolean);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const r = await require('./emailService').sendEmail({
    to,
    from: process.env.LEAD_NOTIFY_FROM || 'INNOVA Leads <leads@finman.money>',
    subject: `Finman week ${today}: ${m.funnel.signed_up} sign-ups, ${m.activated} activated, week-1 return ${pct(m.week1.returned, m.week1.eligible)}`,
    text: lines.join('\n') + '\n\nLive numbers any time: https://app.finman.money/admin',
    html: `<div style="font-family:sans-serif;line-height:1.5"><p>${lines.map(esc).join('<br>')}</p><p><a href="https://app.finman.money/admin">Live numbers on /admin</a></p></div>`,
  });
  if (r && (r.sent || r.skipped)) await run('INSERT OR IGNORE INTO lifecycle_emails (user_id, kind) VALUES (0, ?)', [kind]);
  return { sent: !!(r && r.sent), lines };
}

module.exports = { compute, load, describe, runWeekly, FUNNEL, ACTIVATE, VISIT, sourceClass, weekOf };
