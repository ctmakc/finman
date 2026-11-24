// services/lifecycle.js — what new users did on day 1 and day 7, and the
// emails that follow from it.
//
// 1. Operator digest (always on when email is configured): once a day one
//    email to ACTIVITY_DIGEST_TO (default LEAD_NOTIFY_TO) with every user who
//    reached 1 day or 7 days since sign-up: source, method, key actions.
// 2. User nudges (LIFECYCLE_EMAILS=1 only): our registered users only, each
//    kind once, never test accounts, never accounts that opted out, never
//    accounts created before this feature (backfilled acquisition rows).
//      nudge_not_activated     24–72 h after sign-up, < 3 transactions, no import
//      nudge_import_abandoned  an import failed or stopped at preview, no import since
//    Finman Vault users (services/vault.isVaultUser) never get nudge_not_activated:
//    their transactions are encrypted. Their activity = events (vault_sync, app_open, login).
//    Tips for new users (services/tips.js): tip_invoice / tip_import / tip_next, ≤ 1 per 2 days.
//    Sender: LIFECYCLE_FROM (a verified Resend domain). Each email carries a
//    one-click unsubscribe link (routes/track.js).
'use strict';

const { query, get, run } = require('../db/database');
const emailService = require('./emailService');
const tracker = require('./tracker');
const logger = require('../lib/logger');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const APP_URL = () => (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, '');

async function markSent(userId, kind) {
  await run('INSERT OR IGNORE INTO lifecycle_emails (user_id, kind) VALUES (?, ?)', [userId, kind]);
}

// Users whose sign-up age is within [fromH, toH) hours and who have no `kind` row yet.
async function dueUsers(kind, fromH, toH) {
  return query(
    `SELECT u.id, u.username, u.email, u.full_name, u.created_at, u.lifecycle_opt_out,
            a.source, a.method, a.country, a.backfilled
       FROM users u
       LEFT JOIN user_acquisition a ON a.user_id = u.id
      WHERE u.created_at <= datetime('now', ?) AND u.created_at > datetime('now', ?)
        AND NOT EXISTS (SELECT 1 FROM lifecycle_emails l WHERE l.user_id = u.id AND l.kind = ?)
      ORDER BY u.id`,
    [`-${fromH} hours`, `-${toH} hours`, kind],
  );
}

async function activitySummary(userId) {
  // Demo data (accounts.is_demo, "Explore with demo data") is not the user's
  // own money: it must not count as activation.
  const tx = await get(
    `SELECT COUNT(*) AS n FROM transactions t
      WHERE t.user_id = ? AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.is_demo = 1)`, [userId],
  ).catch(() => ({ n: 0 }));
  const accounts = await get('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ? AND is_demo = 0', [userId]).catch(() => ({ n: 0 }));
  // Finman Vault: the server holds only ciphertext, so its transaction count says nothing.
  const vaultUser = await require('./vault').isVaultUser(userId);
  const events = await query(
    `SELECT event, COUNT(*) AS n, MAX(created_at) AS last FROM analytics_events
      WHERE user_id = ? GROUP BY event ORDER BY n DESC`, [userId],
  ).catch(() => []);
  const by = {};
  let lastSeen = null;
  for (const e of events) {
    by[e.event] = e.n;
    if (!lastSeen || e.last > lastSeen) lastSeen = e.last;
  }
  return { transactions: tx ? tx.n : 0, accounts: accounts ? accounts.n : 0, events: by, lastSeen, vault: vaultUser };
}

function describe(s) {
  const ev = s.events;
  // Vault users: data counts live in the encrypted vault; syncs and opens are what we see.
  const parts = s.vault
    ? [`encrypted vault · syncs ${ev.vault_sync || 0} days`]
    : [`${s.transactions} transactions`, `${s.accounts} accounts`];
  if (ev.import_done) parts.push(`imports ${ev.import_done}`);
  if (ev.import_failed) parts.push(`failed imports ${ev.import_failed}`);
  if (ev.ai_used) parts.push(`AI ${ev.ai_used}`);
  if (ev.budget_created) parts.push(`budgets ${ev.budget_created}`);
  if (ev.goal_created) parts.push(`goals ${ev.goal_created}`);
  if (ev.app_open) parts.push(`app opens ${ev.app_open}`);
  return parts.join(' · ');
}

// ---------- 1. operator digest ----------

// What one person did, from the event journal only (no ledger contents):
// funnel steps reached, days with own activity, back on day 2 / within week 1, where it stopped.
const STEP_TEXT = {
  vault_ready: 'saved the recovery key', first_screen: 'saw the first screen', picked_a_path: 'picked a way in',
  first_account: 'made an account', own_data_in: 'put own data in', first_report: 'opened a report',
};
function journey(events, createdAt, now = new Date()) {
  const gm = require('./growthMetrics');
  const day = (x) => String(x).slice(0, 10);
  const dd = (a, b) => Math.round((Date.parse(day(b)) - Date.parse(day(a))) / 864e5);
  const names = new Set(events.map((e) => e.event));
  const steps = gm.FUNNEL.filter(([k, evs]) => evs && evs.some((n) => names.has(n))).map(([k]) => k);
  const own = events.filter((e) => gm.VISIT.includes(e.event) || !gm.SERVER_ONLY.has(e.event));
  const activeDays = [...new Set(own.map((e) => day(e.created_at)))].sort();
  const later = activeDays.map((d) => dd(createdAt, d)).filter((k) => k >= 1);
  const age = dd(createdAt, now.toISOString());
  const last = own.length ? own.reduce((a, b) => (a.created_at > b.created_at ? a : b)) : null;
  return {
    steps,
    stoppedAt: steps.length ? steps[steps.length - 1] : 'signed_up',
    activeDays: activeDays.length,
    returned: later.length > 0,
    back2: age >= 1 ? later.includes(1) : null,
    back7: age >= 7 ? later.some((k) => k <= 7) : null,
    lastEvent: last ? last.event : null,
    lastAt: last ? last.created_at : null,
  };
}
const yesNo = (v) => (v == null ? 'too early' : v ? 'yes' : 'no');
function journeyText(j) {
  const did = j.steps.length ? j.steps.map((k) => STEP_TEXT[k]).join(' → ') : 'only signed up';
  return `did: ${did} · active days ${j.activeDays} · back day 2: ${yesNo(j.back2)} · back in week 1: ${yesNo(j.back7)}`
    + (j.lastEvent ? ` · last: ${j.lastEvent} ${String(j.lastAt).slice(0, 16)} UTC` : '');
}

// "What new users did": everyone who signed up in the last `days` days, aggregates only.
async function newUsersLine({ days = 7, now = new Date() } = {}) {
  const gm = require('./growthMetrics');
  const since = new Date(now.getTime() - days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const users = await query(
    `SELECT u.id, u.email, u.created_at FROM users u WHERE u.created_at >= ?`, [since]).catch(() => []);
  const admins = String(process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const live = users.filter((u) => !gm.isTest(u.email) && !admins.includes(String(u.email || '').toLowerCase()));
  if (!live.length) return `No new users in the last ${days} days.`;
  const ev = await query(
    `SELECT user_id, event, created_at FROM analytics_events WHERE user_id IN (${live.map(() => '?').join(',')})`,
    live.map((u) => u.id)).catch(() => []);
  const count = Object.fromEntries(Object.keys(STEP_TEXT).map((k) => [k, 0]));
  const stops = {};
  let back = 0;
  for (const u of live) {
    const j = journey(ev.filter((e) => e.user_id === u.id), u.created_at, now);
    for (const k of j.steps) count[k]++;
    stops[j.stoppedAt] = (stops[j.stoppedAt] || 0) + 1;
    if (j.returned) back++;
  }
  const top = Object.entries(stops).sort((a, b) => b[1] - a[1])[0];
  const stopText = top[0] === 'signed_up' ? 'right after signing up' : `after "${STEP_TEXT[top[0]]}"`;
  return `What new users did (last ${days} days, ${live.length} people): saw the first screen ${count.first_screen}, `
    + `picked a way in ${count.picked_a_path}, put own data in ${count.own_data_in}, opened a report ${count.first_report}, `
    + `came back on another day ${back}. Most stop ${stopText} (${top[1]}).`;
}

// New feedback since the last digest that carried feedback (cursor = lifecycle_emails user 0 'digest_fb:<id>').
async function newFeedback() {
  const cur = await query(`SELECT kind FROM lifecycle_emails WHERE user_id = 0 AND kind LIKE 'digest_fb:%'`).catch(() => []);
  const after = cur.reduce((m, r) => Math.max(m, Number(String(r.kind).split(':')[1]) || 0), 0);
  return query(
    `SELECT id, user_id, kind, trigger, rating, answer, comment, device, created_at FROM feedback
      WHERE id > ? AND is_test = 0 ORDER BY id`, [after]).catch(() => []);
}
const fbText = (f) => `#${f.user_id || 'deleted'} · ${f.kind}/${f.trigger}${f.rating ? ' · ' + f.rating + '/5' : ''}`
  + `${f.answer ? ' · ' + f.answer : ''}${f.comment ? ' · "' + String(f.comment).slice(0, 400) + '"' : ''}`;

async function runDigest({ now = new Date() } = {}) {
  const to = (process.env.ACTIVITY_DIGEST_TO || process.env.LEAD_NOTIFY_TO || 'ctmakc@gmail.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const groups = [
    ['digest_1d', 'Day 1', await dueUsers('digest_1d', 24, 72)],
    ['digest_7d', 'Day 7', await dueUsers('digest_7d', 24 * 7, 24 * 10)],
  ];
  const rows = [];
  for (const [kind, label, users] of groups) {
    for (const u of users) {
      if (tracker.isTestEmail(u.email)) { await markSent(u.id, kind); continue; }
      const s = await activitySummary(u.id);
      const ev = await query('SELECT event, created_at FROM analytics_events WHERE user_id = ? ORDER BY created_at', [u.id]).catch(() => []);
      const j = journey(ev, u.created_at, now);
      rows.push({ kind, label, u, s, j });
    }
  }
  const fb = await newFeedback();
  if (!rows.length && !fb.length) return { sent: false, users: 0 };
  const did = await newUsersLine({ days: 7, now }).catch(() => '');

  const text = (did ? did + '\n\n' : '') + rows.map(({ label, u, s, j }) =>
    `${label} · #${u.id} ${u.email} · ${u.method || '?'} · ${u.source || 'source unknown'}${u.country ? ' · ' + u.country : ''}\n  ${journeyText(j)}\n  ${describe(s)}${s.lastSeen ? ' · last activity ' + s.lastSeen + ' UTC' : ''}`).join('\n\n')
    + (fb.length ? `\n\nFeedback from users (${fb.length}):\n` + fb.map((f) => '  ' + fbText(f)).join('\n') : '')
    + '\n\nAll feedback: https://app.finman.money/admin';
  const html = '<div style="font-family:sans-serif">'
    + (did ? `<p style="background:#f3f6f4;padding:10px 12px;border-radius:8px"><b>${esc(did)}</b></p>` : '')
    + (rows.length ? '<p>New Finman users at day 1 and day 7: where they came from and what they did.</p>' : '')
    + '<table style="border-collapse:collapse">'
    + '<tr style="color:#666;text-align:left"><th style="padding:4px 10px 4px 0">Mark</th><th style="padding:4px 10px 4px 0">User</th><th style="padding:4px 10px 4px 0">Source</th><th style="padding:4px 0">Activity</th></tr>'
    + rows.map(({ label, u, s, j }) => `<tr><td style="padding:6px 10px 6px 0;vertical-align:top">${esc(label)}</td>`
      + `<td style="padding:6px 10px 6px 0;vertical-align:top">#${esc(u.id)} ${esc(u.email)}<br><span style="color:#666">${esc(u.method || '')}</span></td>`
      + `<td style="padding:6px 10px 6px 0;vertical-align:top">${esc(u.source || 'unknown')}${u.country ? '<br><span style="color:#666">' + esc(u.country) + '</span>' : ''}</td>`
      + `<td style="padding:6px 0;vertical-align:top">${esc(journeyText(j))}<br><span style="color:#666">${esc(describe(s))}</span>${s.lastSeen ? '<br><span style="color:#666">last activity ' + esc(s.lastSeen) + ' UTC</span>' : ''}</td></tr>`).join('')
    + '</table>'
    + (fb.length ? `<p style="margin-top:16px"><b>Feedback from users (${fb.length})</b></p><ul>`
      + fb.map((f) => `<li>${esc(fbText(f))}</li>`).join('') + '</ul>' : '')
    + '<p><a href="https://app.finman.money/admin">All feedback and numbers on /admin</a></p></div>';

  const r = await emailService.sendEmail({
    to,
    from: process.env.LEAD_NOTIFY_FROM || 'INNOVA Leads <leads@finman.money>',
    subject: `Finman users · day 1 / day 7 · ${rows.length}${fb.length ? ` · feedback ${fb.length}` : ''}`,
    text,
    html,
  });
  if (r && (r.sent || r.skipped)) {
    for (const { kind, u } of rows) await markSent(u.id, kind);
    if (fb.length) await markSent(0, `digest_fb:${fb[fb.length - 1].id}`);
  }
  logger.info({ users: rows.length, sent: r && r.sent }, '[lifecycle] digest');
  return { sent: !!(r && r.sent), users: rows.length, feedback: fb.length, did };
}

// ---------- 2. user nudges ----------

function unsubscribeUrl(userId) {
  const { unsubToken } = require('../routes/track');
  return `${APP_URL()}/api/t/unsubscribe?u=${userId}&t=${unsubToken(userId)}`;
}

function nudgeMessage(kind, u) {
  const name = String(u.full_name || '').trim().split(/\s+/)[0] || 'there';
  const app = APP_URL();
  const unsub = unsubscribeUrl(u.id);
  if (kind === 'nudge_import_abandoned') {
    return {
      subject: 'Your bank file import in Finman',
      text: `Hi ${name},\n\nYour bank statement import in Finman did not finish. Finman reads CSV and OFX files from Canadian banks; most exports work as they are, straight from online banking.\n\nTry again: ${app}/transactions\nIf the file still fails, reply to this email with the bank name and we will look at it.\n\nFinman\n\nStop these emails: ${unsub}`,
    };
  }
  return {
    subject: 'Your first week with Finman',
    text: `Hi ${name},\n\nYou created a Finman account. The quickest way to see your money clearly is to import a bank statement: download a CSV from online banking and drop it into Finman. It takes about a minute, and the categories fill in automatically.\n\nOpen Finman: ${app}\n\nQuestions or a bank that does not import? Reply to this email.\n\nFinman\n\nStop these emails: ${unsub}`,
  };
}

async function eligible(u) {
  if (!u || u.lifecycle_opt_out) return false;
  if (u.backfilled == null || Number(u.backfilled) !== 0) return false; // only accounts tracked from sign-up
  if (tracker.isTestEmail(u.email)) return false;
  return true;
}

async function sendNudge(kind, u) {
  const from = process.env.LIFECYCLE_FROM;
  if (!from) return { skipped: true, reason: 'NO_LIFECYCLE_FROM' };
  const msg = nudgeMessage(kind, u);
  const html = '<div style="font-family:sans-serif;max-width:560px;line-height:1.5">'
    + msg.text.split('\n\n').map((p) => `<p>${esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</p>`).join('')
    + '</div>';
  const r = await emailService.sendEmail({
    to: [u.email], from, subject: msg.subject, text: msg.text, html,
    replyTo: process.env.LIFECYCLE_REPLY_TO || undefined,
  });
  if (r && r.sent) {
    await markSent(u.id, kind);
    tracker.track('email_sent', { userId: u.id, props: { kind } });
  }
  return r;
}

async function runNudges() {
  if (process.env.LIFECYCLE_EMAILS !== '1') return { skipped: true };
  let sent = 0;
  for (const u of await dueUsers('nudge_not_activated', 24, 72)) {
    if (!(await eligible(u))) continue;
    const s = await activitySummary(u.id);
    // Vault users: no transaction count on the server — the nudge would be a guess.
    if (s.vault) continue;
    // Encrypted (vault) users keep no transaction rows on the server, so the
    // event journal decides too: an import, an activation or 3 own entries.
    if (s.transactions >= 3 || s.events.import_done || s.events.activated || s.events.vault_import_done ||
        (s.events.transaction_added || 0) + (s.events.vault_transaction_added || 0) >= 3) continue;
    const r = await sendNudge('nudge_not_activated', u);
    if (r && r.sent) sent++;
  }
  const abandoned = await query(
    `SELECT u.id, u.username, u.email, u.full_name, u.lifecycle_opt_out, a.backfilled
       FROM users u JOIN user_acquisition a ON a.user_id = u.id
      WHERE EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id = u.id
                     AND e.event IN ('import_failed', 'import_preview')
                     AND e.created_at <= datetime('now', '-2 hours')
                     AND e.created_at > datetime('now', '-3 days'))
        AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id = u.id AND e.event = 'import_done')
        AND NOT EXISTS (SELECT 1 FROM lifecycle_emails l WHERE l.user_id = u.id AND l.kind = 'nudge_import_abandoned')`,
  ).catch(() => []);
  for (const u of abandoned) {
    if (!(await eligible(u))) continue;
    const r = await sendNudge('nudge_import_abandoned', u);
    if (r && r.sent) sent++;
  }
  logger.info({ sent }, '[lifecycle] nudges');
  return { sent };
}

let task = null;
function start() {
  if (task) return task;
  const cron = require('node-cron');
  // 13:00 UTC ≈ 08:00/09:00 Toronto.
  task = cron.schedule(process.env.LIFECYCLE_CRON || '0 13 * * *', async () => {
    try { await runDigest(); } catch (e) { logger.error({ err: e.message }, '[lifecycle] digest failed'); }
    try { await runNudges(); } catch (e) { logger.error({ err: e.message }, '[lifecycle] nudges failed'); }
    // Repeating invoices: today's drafts (services/invoice/service.js runRepeats).
    try { await require('./invoice/service').runRepeats(); } catch (e) { logger.error({ err: e.message }, '[lifecycle] invoice repeats failed'); }
    // New users' tips: first invoice, statement import, what next (services/tips.js).
    try { await require('./tips').runTips(); } catch (e) { logger.error({ err: e.message }, '[lifecycle] tips failed'); }
    // Journey sweep + "Your week/month in money" (ENGAGEMENT_EMAILS=1) + push.
    try { await require('./engagementMail').runDaily(); } catch (e) { logger.error({ err: e.message }, '[lifecycle] engagement failed'); }
    // Mondays: the team's week in numbers (aggregates only, services/growthMetrics.js).
    try { await require('./growthMetrics').runWeekly(); } catch (e) { logger.error({ err: e.message }, '[lifecycle] weekly metrics failed'); }
  }, { timezone: 'UTC' });
  return task;
}

module.exports = { runDigest, runNudges, start, activitySummary, nudgeMessage, unsubscribeUrl, journey, journeyText, newUsersLine };
