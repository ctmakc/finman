#!/usr/bin/env node
// scripts/growth-metrics.js — sign-ups, activation and retention from the
// event journal only (analytics_events + user_acquisition + users.created_at).
//
// Why events: once a user moves to the encrypted vault, their accounts and
// transactions rows are wiped from the server, so counting rows would show
// every encrypted user as "not activated". Events never carry amounts or
// transaction text (see middleware/activity.js), so they survive encryption.
//
// Output: aggregates only (no emails, names or ids). Test accounts
// (*.test, +smoke), team accounts (ADMIN_EMAILS) and backfilled rows are kept
// apart. Usage (prod): docker exec -e NODE_PATH=/app/node_modules -w /app finman node scripts/growth-metrics.js [--since 2026-11-03] [--json]
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SINCE = opt('--since', '2026-11-03');
const DB = opt('--db', process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'finance.db'));
const AS_JSON = args.includes('--json');

// Events a person causes by acting in the app (server jobs at 13:00 UTC — emails,
// badges, journey ticks — are excluded: they say nothing about a visit).
const VISIT = ['app_open', 'login'];
const ACTIVATE = ['activated', 'import_done', 'transaction_added', 'transfer_added', 'receipt_scanned', 'vault_import_done', 'vault_transaction_added'];
const SERVER_ONLY = new Set(['email_sent', 'weekly_email_sent', 'badge_earned', 'journey_step_done', 'activated', 'sign_up', 'account_deleted']);

const isTest = (e) => /@[^@]+\.test$/i.test(e || '') || /\+smoke[^@]*@/i.test(e || '');
const admins = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

function all(db, sql, p = []) { return new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r)))); }
const day = (s) => String(s).slice(0, 10);
const days = (a, b) => (Date.parse(day(b)) - Date.parse(day(a))) / 86400000;
function weekOf(s) { const d = new Date(day(s) + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); }

function sourceClass(a) {
  const s = `${(a && a.utm_source) || ''} ${(a && a.source) || ''} ${(a && a.referrer) || ''} ${(a && a.site_referrer) || ''}`.toLowerCase();
  if (/chatgpt|openai/.test(s)) return 'chatgpt';
  if (/perplexity|claude\.ai|gemini|copilot/.test(s)) return 'other_ai';
  if (/google/.test(s)) return 'google';
  if (/bing|duckduckgo|yahoo/.test(s)) return 'other_search';
  if (/finman\.money/.test(s)) return 'site_no_referrer';
  return 'direct_app';
}

(async () => {
  const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
  const users = await all(db, `SELECT u.id, u.email, u.created_at, a.utm_source, a.source, a.referrer, a.site_referrer, a.country, a.backfilled
                                 FROM users u LEFT JOIN user_acquisition a ON a.user_id = u.id WHERE u.created_at >= ?`, [SINCE]);
  const ev = await all(db, `SELECT user_id, event, created_at FROM analytics_events WHERE user_id IS NOT NULL AND created_at >= ?`, [SINCE]);
  const deleted = await all(db, `SELECT created_at FROM analytics_events WHERE event = 'account_deleted' AND created_at >= ?`, [SINCE]);
  db.close();

  const byUser = new Map();
  for (const e of ev) { if (!byUser.has(e.user_id)) byUser.set(e.user_id, []); byUser.get(e.user_id).push(e); }
  const now = new Date().toISOString();
  const out = { since: SINCE, generated_at: now, users_alive: 0, excluded: { test: 0, team: 0 }, deleted_accounts: deleted.length,
    by_source: {}, by_week: {}, by_country_ca: 0, activated: 0, activated_by: {}, week1: { eligible: 0, returned: 0 }, week4: { eligible: 0, returned: 0 },
    note: 'Activation and returns come from events; accounts imported before the journal (backfilled=1) may show no events.' };

  for (const u of users) {
    if (isTest(u.email)) { out.excluded.test++; continue; }
    if (admins.includes(String(u.email).toLowerCase())) { out.excluded.team++; continue; }
    out.users_alive++;
    const src = sourceClass(u);
    out.by_source[src] = (out.by_source[src] || 0) + 1;
    const wk = weekOf(u.created_at);
    out.by_week[wk] = out.by_week[wk] || { signups: 0, activated: 0 };
    out.by_week[wk].signups++;
    if (u.country === 'CA') out.by_country_ca++;
    const list = byUser.get(u.id) || [];
    const act = list.filter((e) => ACTIVATE.includes(e.event));
    if (act.length) {
      out.activated++; out.by_week[wk].activated++;
      const first = act.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0].event;
      out.activated_by[first] = (out.activated_by[first] || 0) + 1;
    }
    // A return = a visit or a user action on a later calendar day than sign-up.
    const activeDays = new Set(list.filter((e) => VISIT.includes(e.event) || !SERVER_ONLY.has(e.event)).map((e) => day(e.created_at)));
    const age = days(u.created_at, now);
    const back = (from, to) => [...activeDays].some((d) => { const k = days(u.created_at, d); return k >= from && k <= to; });
    if (age >= 7) { out.week1.eligible++; if (back(1, 7)) out.week1.returned++; }
    if (age >= 28) { out.week4.eligible++; if (back(22, 28)) out.week4.returned++; }
  }
  if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`Since ${SINCE}: ${out.users_alive} live accounts (+${out.deleted_accounts} deleted themselves); excluded test ${out.excluded.test}, team ${out.excluded.team}`);
  console.log('By source:', out.by_source, '· Canada:', out.by_country_ca);
  console.log(`Activated (events): ${out.activated}`, out.activated_by);
  console.log(`Week 1 returned: ${out.week1.returned}/${out.week1.eligible} · Week 4 returned: ${out.week4.returned}/${out.week4.eligible}`);
  console.log('By week:', out.by_week);
})().catch((e) => { console.error(e.message); process.exit(1); });
