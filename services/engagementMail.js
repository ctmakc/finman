// services/engagementMail.js — "Your week in money" (Mondays) and "Your month
// in money" (1st–3rd of the month), plus the matching Web Push.
//
// Who gets them (ENGAGEMENT_EMAILS=1 turns the emails on; push needs VAPID):
//   - our registered users only, with at least one own transaction (activated);
//   - never test accounts (.test / +smoke), never users who unsubscribed
//     (users.lifecycle_opt_out, same one-click link as the lifecycle emails),
//     never users who switched weekly_summary off in notification settings;
//   - once per period: lifecycle_emails kind `week:<monday>` / `month:<YYYY-MM>`.
// Sender LIFECYCLE_FROM (Resend, finman.money). List-Unsubscribe headers are set.
'use strict';

const { query, get, run } = require('../db/database');
const dates = require('../lib/dates');
const emailService = require('./emailService');
const tracker = require('./tracker');
const logger = require('../lib/logger');
const moneyRecap = require('./moneyRecap');
const cfoTips = require('./cfoTips');
const journey = require('./journey');
const push = require('./push');
const lifecycle = require('./lifecycle');

const TZ = 'America/Toronto';
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const APP_URL = () => (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, '');

// CLEAR DAY palette for email clients (no CSS variables in mail).
const C = {
  ground: '#F1F4F9', plate: '#FFFFFF', ink: '#10131A', ink2: '#4A5262', ink3: '#7A8394',
  accent: '#2B50F0', tint: '#E6EBFE', pos: '#0A7752', neg: '#C2341E', line: '#E3E7EF',
};
const FONT = "Rubik,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const STEP_COPY = {
  first_insight: { label: 'Import your first statement', page: 'dashboard' },
  second_source: { label: 'Add a second statement or connect your bank', page: 'accounts' },
  budget: { label: 'Set your first budget', page: 'budgets' },
  goal: { label: 'Create a savings goal', page: 'goals' },
  weekly_review: { label: 'Open your weekly review', page: 'week' },
};

function link(page, campaign, extra = '') {
  return `${APP_URL()}/${encodeURIComponent(page)}?utm_source=email&utm_medium=lifecycle&utm_campaign=${campaign}&fm_src=email${extra}`;
}

function firstName(u) {
  return String(u.full_name || '').trim().split(/\s+/)[0] || '';
}

function deltaText(d, lowerIsGood = true) {
  if (d == null) return '';
  if (d === 0) return 'same as before';
  const good = lowerIsGood ? d < 0 : d > 0;
  return `<span style="color:${good ? C.pos : C.neg}">${d > 0 ? '+' : '−'}${Math.abs(d)}%</span>`;
}

// Build { subject, text, html } from the recap, tips and journey.
function render(u, r, tips, j, unsubUrl) {
  const fmt = (n) => cfoTips.fmt(n, r.currency);
  const isMonth = r.kind === 'month';
  const campaign = isMonth ? 'monthly_recap' : 'weekly_recap';
  const name = firstName(u);
  const title = isMonth ? `Your ${r.period.label} in money` : 'Your week in money';
  const empty = !r.transactions;
  const subject = empty
    ? `${title}: bring ${isMonth ? 'the month' : 'last week'} in`
    : `${title}: ${fmt(r.expense)} spent${r.income ? `, ${fmt(r.income)} in` : ''}`;
  const reviewUrl = link('week', campaign, `&fm_kind=${r.kind}`);
  const importUrl = link('dashboard', campaign, '&fm_import=1');

  // ---- text ----
  const t = [];
  t.push(`${name ? `Hi ${name},` : 'Hi,'}`, '');
  t.push(`${title} · ${r.period.label}`);
  if (empty) {
    t.push(`No transactions for ${r.period.label} yet. ${r.lastDataDate ? `Your data ends on ${r.lastDataDate}.` : ''} Import the newer statement and the recap fills in: ${importUrl}`);
  } else {
    t.push(`Spent ${fmt(r.expense)}${r.expenseDelta != null ? ` (${r.expenseDelta > 0 ? '+' : ''}${r.expenseDelta}% vs the ${isMonth ? 'month' : 'week'} before)` : ''}`);
    t.push(`Income ${fmt(r.income)} · Net ${r.net >= 0 ? '+' : '−'}${fmt(Math.abs(r.net))}`);
    if (r.topCategories.length) t.push('', 'Top categories:', ...r.topCategories.slice(0, 3).map((c) => `  ${c.category}: ${fmt(c.amount)}`));
  }
  if (tips.length) t.push('', 'AI CFO:', ...tips.slice(0, 2).map((x) => `  ${x.title}. ${x.body}`));
  if (j && j.streak.current >= 2) t.push('', `Streak: ${j.streak.current} weeks in a row.`);
  if (j && j.next) t.push('', `Next step: ${STEP_COPY[j.next].label} — ${link(STEP_COPY[j.next].page, campaign)}`);
  t.push('', `Full review: ${reviewUrl}`, '', 'Finman', '', `Stop these emails: ${unsubUrl}`);
  const text = t.join('\n');

  // ---- html ----
  const row = (label, value) => `<tr><td style="padding:10px 0;border-top:1px solid ${C.line};color:${C.ink2}">${esc(label)}</td><td align="right" style="padding:10px 0;border-top:1px solid ${C.line};color:${C.ink};font-weight:600;font-variant-numeric:tabular-nums">${value}</td></tr>`;
  const plate = (inner, extra = '') => `<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.plate};border-radius:20px;${extra}"><tr><td style="padding:22px 24px">${inner}</td></tr></table></td></tr>`;
  const btn = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:${C.accent};color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${esc(label)}</a>`;

  let hero;
  if (empty) {
    hero = `<div style="font-size:15px;color:${C.ink2};margin:0 0 6px">${esc(r.period.label)}</div>
      <div style="font-size:22px;font-weight:600;color:${C.ink};line-height:1.3;margin:0 0 10px">No transactions for this ${isMonth ? 'month' : 'week'} yet</div>
      <div style="font-size:15px;color:${C.ink2};line-height:1.5;margin:0 0 18px">${r.lastDataDate ? `Your data ends on ${esc(r.lastDataDate)}. ` : ''}Download the newer statement from online banking and drop it into Finman: the recap and the tips update in a minute.</div>
      ${btn(importUrl, 'Import the new statement')}`;
  } else {
    hero = `<div style="font-size:15px;color:${C.ink2};margin:0 0 6px">${esc(r.period.label)} · spent</div>
      <div style="font-size:40px;font-weight:600;color:${C.ink};letter-spacing:-0.02em;font-variant-numeric:tabular-nums;margin:0 0 4px">${esc(fmt(r.expense))}</div>
      <div style="font-size:14px;color:${C.ink2};margin:0 0 16px">${r.expenseDelta != null ? `${deltaText(r.expenseDelta)} vs the ${isMonth ? 'month' : 'week'} before` : '&nbsp;'}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
        ${row('Income', esc(fmt(r.income)))}
        ${row('Net', `<span style="color:${r.net >= 0 ? C.pos : C.neg}">${r.net >= 0 ? '+' : '−'}${esc(fmt(Math.abs(r.net)))}</span>`)}
        ${r.savingsRate != null && isMonth ? row('Kept of income', `${r.savingsRate}%`) : ''}
      </table>`;
  }

  const cats = !empty && r.topCategories.length ? plate(`<div style="font-size:16px;font-weight:600;color:${C.ink};margin:0 0 6px">Where it went</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
    ${r.topCategories.slice(0, 4).map((c) => row(c.category, `${esc(fmt(c.amount))}${c.delta != null && c.prev ? ` <span style="font-weight:400;font-size:13px">${deltaText(c.delta)}</span>` : ''}`)).join('')}
    </table>`) : '';

  const tipHtml = tips.length ? `<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.accent};border-radius:20px"><tr><td style="padding:22px 24px;color:#FFFFFF">
    <div style="font-size:13px;opacity:.85;margin:0 0 8px">AI CFO</div>
    ${tips.slice(0, 2).map((x, i) => `<div style="${i ? `border-top:1px solid rgba(255,255,255,.25);padding-top:12px;margin-top:12px` : ''}"><div style="font-size:17px;font-weight:600;line-height:1.35">${esc(x.title)}</div><div style="font-size:14px;line-height:1.5;opacity:.92;margin-top:4px">${esc(x.body)}</div></div>`).join('')}
    </td></tr></table></td></tr>` : '';

  const goals = isMonth && r.goals.length ? plate(`<div style="font-size:16px;font-weight:600;color:${C.ink};margin:0 0 6px">Goals</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
    ${r.goals.slice(0, 3).map((g) => row(g.name, `${g.percent}% <span style="font-weight:400;color:${C.ink3}">of ${esc(fmt(g.target))}</span>`)).join('')}
    </table>`) : '';

  const habit = j ? plate(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:15px;color:${C.ink2};line-height:1.5">${j.streak.current >= 1 ? `<b style="color:${C.ink}">${j.streak.current} ${j.streak.current === 1 ? 'week' : 'weeks'} in a row.</b> ` : ''}${j.next ? `Next: <a href="${esc(link(STEP_COPY[j.next].page, campaign))}" style="color:${C.accent};font-weight:600;text-decoration:none">${esc(STEP_COPY[j.next].label)}</a> (${j.doneCount} of ${j.total} done)` : 'Every setup step is done.'}</td>
    </tr></table>`) : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.ground};font-family:${FONT};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden">${esc(empty ? 'Import the newer statement to see the recap.' : `${fmt(r.expense)} spent, ${fmt(r.income)} in. ${tips[0] ? tips[0].title : ''}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ground}"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
  <tr><td style="padding:0 6px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:18px;font-weight:650;color:${C.ink};letter-spacing:-0.01em"><span style="display:inline-block;width:26px;height:26px;border-radius:9px;background:${C.accent};vertical-align:middle;margin-right:8px"></span>Finman</td>
    <td align="right" style="font-size:14px;color:${C.ink3}">${esc(title)}</td></tr></table></td></tr>
  ${name ? `<tr><td style="padding:0 6px 12px;font-size:16px;color:${C.ink}">Hi ${esc(name)},</td></tr>` : ''}
  ${plate(hero)}
  ${tipHtml}
  ${cats}
  ${goals}
  ${habit}
  ${empty ? '' : `<tr><td align="center" style="padding:6px 0 18px">${btn(reviewUrl, isMonth ? 'Open the month review' : 'Open your weekly review')}</td></tr>`}
  <tr><td style="padding:8px 10px 0;font-size:12px;line-height:1.6;color:${C.ink3};text-align:center">
    You get this because you use Finman with ${esc(u.email)}. Numbers come from your own imported data; demo data is left out.<br>
    <a href="${esc(unsubUrl)}" style="color:${C.ink3}">Unsubscribe</a> · <a href="${esc(link('settings', campaign))}" style="color:${C.ink3}">Notification settings</a>
  </td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function build(userId, kind, { now = new Date() } = {}) {
  const u = await get('SELECT id, email, full_name FROM users WHERE id = ?', [userId]);
  if (!u) return null;
  const [r, tips, j] = await Promise.all([
    moneyRecap.recap(userId, { kind, now }),
    cfoTips.tips(userId, { now, limit: 3 }).catch(() => []),
    journey.compute(userId, { record: false, now }).catch(() => null),
  ]);
  return { user: u, recap: r, tips, journey: j, ...render(u, r, tips, j, lifecycle.unsubscribeUrl(userId)) };
}

// Users who can get the recap: own data, not unsubscribed, weekly summary on.
async function candidates() {
  return query(
    `SELECT u.id, u.email, u.full_name
       FROM users u
      WHERE COALESCE(u.lifecycle_opt_out, 0) = 0
        AND u.email IS NOT NULL AND u.email <> ''
        AND NOT EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = u.id AND ns.weekly_summary = 0)
        AND EXISTS (SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id
                     WHERE t.user_id = u.id AND COALESCE(a.is_demo, 0) = 0)
      ORDER BY u.id`,
  );
}

async function alreadySent(userId, kind) {
  const r = await get('SELECT 1 AS x FROM lifecycle_emails WHERE user_id = ? AND kind = ?', [userId, kind]).catch(() => null);
  return Boolean(r);
}

// One period run. kind 'week' | 'month'. Returns counts.
async function runRecap(kind, { now = new Date(), dryRun = false } = {}) {
  const emailsOn = process.env.ENGAGEMENT_EMAILS === '1';
  const from = process.env.LIFECYCLE_FROM;
  const today = dates.todayISO(TZ, now);
  const period = moneyRecap.periodFor(kind, today);
  const markKind = `${kind}:${period.key}`;
  const out = { kind: markKind, users: 0, emailed: 0, pushed: 0, skipped: 0 };
  const users = await candidates();
  for (const u of users) {
    if (tracker.isTestEmail(u.email)) { out.skipped += 1; continue; }
    if (await alreadySent(u.id, markKind)) { out.skipped += 1; continue; }
    out.users += 1;
    if (dryRun) continue;
    try {
      const m = await build(u.id, kind, { now });
      let emailed = false;
      if (emailsOn && from) {
        const unsub = lifecycle.unsubscribeUrl(u.id);
        const r = await emailService.sendEmail({
          to: [u.email], from, subject: m.subject, text: m.text, html: m.html,
          replyTo: process.env.LIFECYCLE_REPLY_TO || undefined,
          headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        emailed = Boolean(r && r.sent);
      }
      const p = await push.sendToUser(u.id, {
        kind: `${kind}_recap`,
        title: kind === 'month' ? `Your ${m.recap.period.label} in money` : 'Your week in money is ready',
        body: m.recap.transactions
          ? `${cfoTips.fmt(m.recap.expense, m.recap.currency)} spent. ${m.tips[0] ? m.tips[0].title : 'Two minutes to review it.'}`
          : 'Import the newer statement to see the recap.',
        url: `/week?fm_kind=${kind}&fm_src=push&fm_push=${kind}_recap`,
        tag: `${kind}-recap`,
      }, { email: u.email });
      if (emailed || p.sent) {
        await run('INSERT OR IGNORE INTO lifecycle_emails (user_id, kind) VALUES (?, ?)', [u.id, markKind]);
      }
      if (emailed) {
        out.emailed += 1;
        tracker.track(kind === 'month' ? 'monthly_email_sent' : 'weekly_email_sent', {
          userId: u.id, props: { period: period.key, tx: m.recap.transactions, tips: m.tips.length }, test: tracker.isTestEmail(u.email),
        });
      }
      if (p.sent) out.pushed += 1;
    } catch (e) {
      logger.error({ err: e.message, userId: u.id }, '[engagement] recap failed');
    }
  }
  return out;
}

// Sunday: a streak of 2+ weeks with no activity this week gets one push.
async function runStreakSaver({ now = new Date() } = {}) {
  const subs = await query('SELECT DISTINCT p.user_id AS id, u.email FROM push_subscriptions p JOIN users u ON u.id = p.user_id').catch(() => []);
  let pushed = 0;
  for (const s of subs) {
    if (tracker.isTestEmail(s.email)) continue;
    const j = await journey.compute(s.id, { record: false, now }).catch(() => null);
    if (!j || j.streak.activeThisWeek || j.streak.current < 2) continue;
    const r = await push.sendToUser(s.id, {
      kind: 'streak_saver', title: `Keep your ${j.streak.current}-week streak`,
      body: 'Two minutes: open this week in Finman before Sunday ends.', url: '/week?fm_src=push&fm_push=streak_saver', tag: 'streak',
    }, { email: s.email });
    if (r.sent) pushed += 1;
  }
  return { pushed };
}

// Daily entry point (lifecycle cron, 13:00 UTC).
async function runDaily({ now = new Date() } = {}) {
  const today = dates.todayISO(TZ, now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const dom = Number(today.slice(8));
  const res = { sweep: await journey.sweep({ now }) };
  if (dow === 1) res.week = await runRecap('week', { now });
  if (dom <= 3) res.month = await runRecap('month', { now }); // catch-up if the 1st was missed
  if (dow === 0) res.streak = await runStreakSaver({ now });
  logger.info(res, '[engagement] daily run');
  return res;
}

module.exports = { render, build, runRecap, runDaily, runStreakSaver, candidates, STEP_COPY };
