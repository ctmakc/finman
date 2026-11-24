#!/usr/bin/env node
// scripts/behavior-report.js — what people did in Finman over the last N days, for the weekly
// improver agent and the monthly owner summary (finman-review on the station).
// Event journal only: no emails, names or record contents (the data is encrypted in the browser).
//
// Usage (prod): docker exec -e NODE_PATH=/app/node_modules -w /app finman node scripts/behavior-report.js [--days 7] [--json]
// Local: node scripts/behavior-report.js --db path/to/finance.db --days 7
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');
const gm = require('../services/growthMetrics');
const { journey } = require('../services/lifecycle');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Math.max(1, Math.min(120, Number(opt('--days', 7)) || 7));
const DB = opt('--db', process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'finance.db'));

async function build(query, now = new Date()) {
  const since = new Date(now.getTime() - DAYS * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const admins = String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const live = (u) => !gm.isTest(u.email) && !admins.includes(String(u.email || '').toLowerCase());
  const users = (await query(
    `SELECT u.id, u.email, u.created_at, a.utm_source, a.source, a.referrer, a.site_referrer, a.country, a.method
       FROM users u LEFT JOIN user_acquisition a ON a.user_id = u.id WHERE u.created_at >= ?`, [since])).filter(live);
  const ev = users.length ? await query(
    `SELECT user_id, event, created_at, props FROM analytics_events WHERE user_id IN (${users.map(() => '?').join(',')}) ORDER BY created_at`,
    users.map((u) => u.id)) : [];
  const people = users.map((u) => {
    const mine = ev.filter((e) => e.user_id === u.id);
    const j = journey(mine, u.created_at, now);
    const own = mine.filter((e) => !gm.SERVER_ONLY.has(e.event)).map((e) => e.event);
    const top = Object.entries(own.reduce((m, e) => { m[e] = (m[e] || 0) + 1; return m; }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e, n]) => `${e}×${n}`);
    return { id: u.id, signed_up: String(u.created_at).slice(0, 16), source: gm.sourceClass(u), country: u.country || '', method: u.method || '',
      steps: j.steps, stopped_at: j.stoppedAt, active_days: j.activeDays, back_day2: j.back2, back_week1: j.back7, top_events: top,
      failed_imports: mine.filter((e) => e.event === 'import_failed').map((e) => { try { return JSON.parse(e.props || '{}').code || 'unknown'; } catch (_) { return 'unknown'; } }) };
  });
  // Everyone active in the window (older accounts too): who keeps using Finman.
  const active = await query(
    `SELECT e.user_id, u.email, COUNT(DISTINCT date(e.created_at)) AS days, COUNT(*) AS n FROM analytics_events e JOIN users u ON u.id = e.user_id
      WHERE e.created_at >= ? AND e.event IN ('app_open','login') GROUP BY e.user_id ORDER BY days DESC`, [since]);
  const returning = active.filter(live).filter((a) => !users.some((u) => u.id === a.user_id))
    .map((a) => ({ id: a.user_id, days: a.days, opens: a.n }));
  const feedback = await query(
    `SELECT id, user_id, kind, trigger, rating, answer, comment, device, created_at FROM feedback
      WHERE created_at >= ? AND is_test = 0 ORDER BY id`, [since]).catch(() => []);
  const metrics = gm.compute({ users, events: ev, admins, now: now.toISOString(), since });
  return { days: DAYS, since, generated_at: now.toISOString(), metrics, people, returning, feedback };
}

function markdown(r) {
  const m = r.metrics; const f = m.funnel;
  const yn = (v) => (v == null ? '—' : v ? 'yes' : 'no');
  const L = [
    `# Finman: last ${r.days} days (since ${r.since} UTC)`, '',
    `New live accounts: ${m.users_alive} · sources: ${Object.entries(m.by_source).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`,
    `Path: signed up ${f.signed_up} → vault ${f.vault_ready} → first screen ${f.first_screen} → picked a way in ${f.picked_a_path} → first account ${f.first_account} → own data ${f.own_data_in} → report ${f.first_report}`,
    `Import failures: ${Object.entries(m.import_failed_codes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} · PDF read: ${m.statements_read}`,
    `Older accounts that came back in the window: ${r.returning.length}${r.returning.length ? ' (' + r.returning.map((x) => `#${x.id} ${x.days}d`).join(', ') + ')' : ''}`,
    '', '## People', '',
    '| # | signed up | source | country | did | active days | back d2 | back w1 | stopped at | top events | failed imports |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...r.people.map((p) => `| ${p.id} | ${p.signed_up} | ${p.source} | ${p.country} | ${p.steps.join(' → ') || 'only signed up'} | ${p.active_days} | ${yn(p.back_day2)} | ${yn(p.back_week1)} | ${p.stopped_at} | ${p.top_events.join(', ')} | ${p.failed_imports.join(', ')} |`),
    '', `## Feedback (${r.feedback.length})`, '',
    ...(r.feedback.length ? r.feedback.map((x) => `- #${x.user_id || 'deleted'} ${x.kind}/${x.trigger}${x.rating ? ' ' + x.rating + '/5' : ''}${x.answer ? ' · ' + x.answer : ''}${x.comment ? ' — "' + String(x.comment).replace(/\s+/g, ' ').slice(0, 500) + '"' : ''} (${x.device || ''}, ${String(x.created_at).slice(0, 16)})`) : ['- none']),
  ];
  return L.join('\n');
}

if (require.main === module) {
  (async () => {
    const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    const query = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
    const r = await build(query);
    db.close();
    console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { build, markdown };
