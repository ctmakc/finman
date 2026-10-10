// New-account notice for the operator (finman.money, added 2026-09-28).
// A registration on app.finman.money is the product's only "lead": the operator
// gets an email with the username, email and sign-up method, and nothing about
// the person's finances. Fire-and-forget: a mail failure never blocks sign-up.
//
// Env (all optional; without RESEND_API_KEY the notice is only logged):
//   RESEND_API_KEY        sending-scoped Resend key
//   LEAD_NOTIFY_TO        comma-separated recipients (default ctmakc@gmail.com)
//   LEAD_NOTIFY_FROM      verified sender (default "INNOVA Leads <leads@remolda.com>")
//   GA4_MEASUREMENT_ID + GA4_API_SECRET  also send an anonymous sign_up event
//                         to GA4 via Measurement Protocol (no user data in it)
const crypto = require('crypto');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function sendMail({ subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log('[signup-notify] RESEND_API_KEY not set, skipped:', subject); return { skipped: true }; }
  const to = (process.env.LEAD_NOTIFY_TO || 'ctmakc@gmail.com').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.LEAD_NOTIFY_FROM || 'INNOVA Leads <leads@remolda.com>';
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ from, to, subject, text, html }, replyTo ? { reply_to: replyTo } : {})),
        signal: AbortSignal.timeout(15000),
      });
      const body = await r.text();
      if (r.ok) { console.log('[signup-notify] sent', subject, body.slice(0, 80)); return { ok: true, body }; }
      lastErr = new Error('HTTP ' + r.status + ' ' + body.slice(0, 200));
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) { lastErr = e; }
    await new Promise(res => setTimeout(res, attempt * 2000));
  }
  console.error('[signup-notify] FAILED', subject, lastErr && lastErr.message);
  return { ok: false, error: lastErr && lastErr.message };
}

async function sendGa4SignUp(method, userId) {
  const mid = process.env.GA4_MEASUREMENT_ID, secret = process.env.GA4_API_SECRET;
  if (!mid || !secret) return { skipped: true };
  // Anonymous client id: a hash of the internal user id, never the email.
  const h = crypto.createHash('sha256').update('finman:' + userId).digest('hex');
  const clientId = parseInt(h.slice(0, 8), 16) + '.' + parseInt(h.slice(8, 16), 16);
  try {
    const r = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(mid)}&api_secret=${encodeURIComponent(secret)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, events: [{ name: 'sign_up', params: { method, engagement_time_msec: 1 } }] }),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: r.status < 300, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

function notifySignup(user, method, opts = {}) {
  const u = user || {};
  const when = new Date().toISOString();
  const tag = opts.subjectPrefix ? opts.subjectPrefix + ' ' : '';
  const subject = `${tag}Регистрация · finman.money · ${method === 'google' ? 'Google' : 'email'} · ${u.fullName || u.full_name || u.username || u.email || 'unknown'}`;
  const rows = [
    ['Username', u.username], ['Email', u.email], ['Name', u.fullName || u.full_name],
    ['Method', method], ['User id', u.id], ['Time (UTC)', when], ['Site', 'finman.money'],
  ];
  const text = rows.map(([k, v]) => `${k}: ${v == null || v === '' ? '-' : v}`).join('\n')
    + '\n\nНовая регистрация в приложении Finman (app.finman.money).';
  const html = '<p style="font-family:sans-serif">Новая регистрация в приложении Finman (app.finman.money).</p><table style="font-family:sans-serif;border-collapse:collapse">'
    + rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v == null || v === '' ? '-' : v)}</b></td></tr>`).join('')
    + '</table>';
  const work = Promise.all([
    sendMail({ subject, text, html, replyTo: u.email || undefined }),
    opts.skipGa4 ? Promise.resolve({ skipped: true }) : sendGa4SignUp(method, u.id),
  ]).catch(e => { console.error('[signup-notify] error', e && e.message); return [{ ok: false }]; });
  return work;
}

module.exports = { notifySignup };
