// services/weeklyNote.js — the Monday reminder for Finman Vault users: "Your week in money
// is ready". No numbers: the server cannot read an encrypted account. The numbers are on the
// Week page, worked out on the person's device.
//
// Who gets it (ENGAGEMENT_EMAILS=1 and LIFECYCLE_FROM for the email; push needs VAPID):
//   - Finman Vault users with an email, not test accounts;
//   - who put their own data in at least once (an activation event in the journal);
//   - who have not opened Finman in the last 6 days (whoever came back needs no reminder);
//   - not unsubscribed (users.lifecycle_opt_out) and weekly email not switched off
//     (users.weekly_note_opt_out, Settings -> Emails);
//   - never chased: after 3 reminders in a row with no visit after them, no more until the
//     person comes back on their own;
//   - once a week: lifecycle_emails kind `weeknote:<monday>`.
'use strict';

const { query, get, run } = require('../db/database');
const dates = require('../lib/dates');
const emailService = require('./emailService');
const tracker = require('./tracker');
const logger = require('../lib/logger');
const push = require('./push');
const lifecycle = require('./lifecycle');
const { VAULT_USER_SQL } = require('./vault');

const TZ = 'America/Toronto';
const ACTIVATE = ['import_done', 'transaction_added', 'transfer_added', 'receipt_scanned', 'activated', 'onboarding_import_done'];
const VISIT = ['app_open', 'login'];
const MAX_UNANSWERED = 3;
const APP_URL = () => (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inList = (a) => a.map((x) => `'${x}'`).join(',');

// Monday of the week that just ended, and its label ("Nov 16–22").
function lastWeek(today) {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = new Date(d); thisMonday.setUTCDate(d.getUTCDate() - dow);
  const start = new Date(thisMonday); start.setUTCDate(thisMonday.getUTCDate() - 7);
  const end = new Date(thisMonday); end.setUTCDate(thisMonday.getUTCDate() - 1);
  const mon = (x) => x.toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' });
  const label = mon(start) === mon(end)
    ? `${mon(start)} ${start.getUTCDate()}–${end.getUTCDate()}`
    : `${mon(start)} ${start.getUTCDate()} – ${mon(end)} ${end.getUTCDate()}`;
  return { key: thisMonday.toISOString().slice(0, 10), label };
}

async function candidates() {
  return query(
    `SELECT u.id, u.email, u.full_name
       FROM users u
      WHERE ${VAULT_USER_SQL('u')}
        AND COALESCE(u.lifecycle_opt_out, 0) = 0
        AND COALESCE(u.weekly_note_opt_out, 0) = 0
        AND u.email IS NOT NULL AND u.email <> ''
        AND EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id = u.id AND e.event IN (${inList(ACTIVATE)}))
        AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id = u.id AND e.event IN (${inList(VISIT)})
                         AND e.created_at >= datetime('now', '-6 days'))
      ORDER BY u.id`,
  );
}

// Reminders sent since the person last opened Finman.
async function unanswered(userId) {
  const last = await get(
    `SELECT MAX(created_at) AS at FROM analytics_events WHERE user_id = ? AND event IN (${inList(VISIT)})`, [userId],
  ).catch(() => null);
  const r = await get(
    `SELECT COUNT(*) AS n FROM lifecycle_emails WHERE user_id = ? AND kind LIKE 'weeknote:%' AND sent_at > COALESCE(?, '1970-01-01')`,
    [userId, last && last.at],
  ).catch(() => ({ n: 0 }));
  return Number(r && r.n) || 0;
}

function render(u, week, unsubUrl) {
  const first = String(u.full_name || '').trim().split(/\s+/)[0];
  const url = `${APP_URL()}/week?fm_src=email&fm_kind=week&utm_source=finman&utm_medium=email&utm_campaign=weeknote`;
  const settingsUrl = `${APP_URL()}/settings?fm_src=email#emails`;
  const subject = `Your week in money is ready (${week.label})`;
  const text = [
    `${first ? `Hi ${first},` : 'Hi,'}`,
    '',
    `Your Finman summary for ${week.label} is ready: what came in, where it went and what changed from the week before.`,
    'Your data is encrypted, so the numbers are only in the app, on your device. This email has none.',
    '',
    `Open my week: ${url}`,
    '',
    `You get this on Mondays when you have not opened Finman for a while. Switch it off in Settings, Emails: ${settingsUrl}`,
    `Unsubscribe from all Finman tips and reminders: ${unsubUrl}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5fb;font-family:Arial,Helvetica,sans-serif;color:#121a2e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px">
<tr><td style="padding:28px 28px 8px;font-size:13px;color:#2b4bf2;font-weight:bold">Finman · ${esc(week.label)}</td></tr>
<tr><td style="padding:0 28px;font-size:24px;line-height:1.25;font-weight:bold">Your week in money is ready</td></tr>
<tr><td style="padding:14px 28px 0;font-size:15px;line-height:1.55">${first ? `Hi ${esc(first)}, y` : 'Y'}our summary for ${esc(week.label)} is ready: what came in, where it went and what changed from the week before.</td></tr>
<tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.55;color:#4a5370">Your data is encrypted, so the numbers are only in the app, on your device. This email has none.</td></tr>
<tr><td style="padding:22px 28px 26px"><a href="${esc(url)}" style="display:inline-block;background:#2b4bf2;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:999px">Open my week</a></td></tr>
<tr><td style="padding:0 28px 26px;font-size:12px;line-height:1.5;color:#6b7390">You get this on Mondays when you have not opened Finman for a while.
<a href="${esc(settingsUrl)}" style="color:#6b7390">Switch it off in Settings</a> · <a href="${esc(unsubUrl)}" style="color:#6b7390">Unsubscribe from all tips and reminders</a></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function run_({ now = new Date(), dryRun = false } = {}) {
  const emailsOn = process.env.ENGAGEMENT_EMAILS === '1';
  const from = process.env.LIFECYCLE_FROM;
  const week = lastWeek(dates.todayISO(TZ, now));
  const kind = `weeknote:${week.key}`;
  const out = { kind, users: 0, emailed: 0, pushed: 0, skipped: 0, quiet: 0 };
  for (const u of await candidates()) {
    if (tracker.isTestEmail(u.email)) { out.skipped += 1; continue; }
    if (await get('SELECT 1 AS x FROM lifecycle_emails WHERE user_id = ? AND kind = ?', [u.id, kind]).catch(() => null)) { out.skipped += 1; continue; }
    if (await unanswered(u.id) >= MAX_UNANSWERED) { out.quiet += 1; continue; }
    out.users += 1;
    if (dryRun) continue;
    try {
      const unsub = lifecycle.unsubscribeUrl(u.id);
      const m = render(u, week, unsub);
      let emailed = false;
      if (emailsOn && from) {
        const r = await emailService.sendEmail({
          to: [u.email], from, subject: m.subject, text: m.text, html: m.html,
          replyTo: process.env.LIFECYCLE_REPLY_TO || undefined,
          headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        emailed = Boolean(r && r.sent);
      }
      const p = await push.sendToUser(u.id, {
        kind: 'week_note', title: 'Your week in money is ready',
        body: `${week.label}: what came in, where it went. Two minutes.`,
        url: '/week?fm_kind=week&fm_src=push&fm_push=week_note', tag: 'week-note',
      }, { email: u.email }).catch(() => ({ sent: false }));
      if (emailed || p.sent) await run('INSERT OR IGNORE INTO lifecycle_emails (user_id, kind) VALUES (?, ?)', [u.id, kind]);
      if (emailed) {
        out.emailed += 1;
        tracker.track('weekly_note_sent', { userId: u.id, props: { week: week.key } });
      }
      if (p.sent) out.pushed += 1;
    } catch (e) {
      logger.error({ err: e.message, userId: u.id }, '[weeklyNote] failed');
    }
  }
  return out;
}

module.exports = { run: run_, candidates, unanswered, render, lastWeek, MAX_UNANSWERED };
