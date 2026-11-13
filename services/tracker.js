// services/tracker.js — where a user came from and what they do.
//
// Two sinks, the first always on:
//   1. our own SQLite tables (user_acquisition, analytics_events), so the
//      signup email, the digests and the lifecycle emails work without
//      anything external;
//   2. the self-hosted OpenPanel (stats.finman.money, our server) for
//      profiles, funnels, cohorts and retention. It is enabled when
//      OPENPANEL_API_URL + OPENPANEL_SERVER_CLIENT_ID + _SECRET are set.
//
// Test sign-ups (.test / +smoke, see signupNotify.isTestSignup) are kept in
// our tables for verification but never reach OpenPanel.
'use strict';

const { get, run } = require('../db/database');
const geo = require('./geo');
const logger = require('../lib/logger');

const ATT_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'msclkid', 'referrer', 'landing',
  'site_referrer', 'site_landing', 'anon_id', 'tz', 'lang', 'first_seen_at',
];
const MAX = 500;

const clip = (v, n = MAX) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, n) : null;
};

function parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (_) { return null; }
}

// Client payload -> { first: {...}, last: {...}, form_ms, anon_id, ... }.
// Accepts an object or a JSON string; anything unexpected is dropped.
function normalizeAttribution(raw) {
  const src = parseJson(raw) || {};
  const pick = (o) => {
    const out = {};
    if (!o || typeof o !== 'object') return out;
    for (const k of ATT_FIELDS) {
      const v = clip(o[k]);
      if (v) out[k] = v;
    }
    return out;
  };
  const first = pick(src.first || src);
  const last = pick(src.last);
  const formMs = Number(src.form_ms);
  return {
    first,
    last,
    anon_id: clip(src.anon_id || first.anon_id, 64),
    tz: clip(src.tz || first.tz, 64),
    lang: clip(src.lang || first.lang, 32),
    form_ms: Number.isFinite(formMs) && formMs >= 0 ? Math.round(formMs) : null,
  };
}

function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|ecosia|baidu|naver|brave|startpage|qwant)\./;
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com)$/;
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|instagram\.com|t\.co|x\.com|twitter\.com|linkedin\.com|reddit\.com|youtube\.com|tiktok\.com|t\.me|telegram\.org|pinterest\.com|threads\.net)$/;
const OWN = /(^|\.)finman\.money$/;

function refLabel(host) {
  if (!host) return '';
  if (SEARCH.test(host)) return `${host.split('.').slice(-2, -1)[0] || host} organic`;
  if (AI.test(host)) return `${host} (AI)`;
  if (SOCIAL.test(host)) return `${host} (social)`;
  return host;
}

// Human label for the email and the dashboards, e.g.
//   "Google Ads", "utm: newsletter / email", "google organic",
//   "finman.money ← chatgpt.com (AI)", "direct".
function sourceLabel(att) {
  const f = (att && att.first) || {};
  if (f.gclid) return 'Google Ads';
  if (f.msclkid) return 'Bing Ads';
  if (f.fbclid && !f.utm_source) return 'Facebook/Instagram';
  // Site CTAs tag themselves utm_source=finman.money&utm_medium=site; the real
  // origin of such a visitor is the site's own referrer (fm_ref).
  if (f.utm_source && OWN.test(String(f.utm_source).toLowerCase())) {
    const siteRef = hostOf(f.site_referrer);
    const cta = f.utm_campaign ? ` · cta ${f.utm_campaign}` : '';
    return (siteRef && !OWN.test(siteRef) ? `finman.money ← ${refLabel(siteRef)}` : 'finman.money (direct)') + cta;
  }
  if (f.utm_source) return `utm: ${f.utm_source}${f.utm_medium ? ' / ' + f.utm_medium : ''}${f.utm_campaign ? ' / ' + f.utm_campaign : ''}`;
  const refHost = hostOf(f.referrer);
  if (refHost && OWN.test(refHost) && refHost !== 'app.finman.money') {
    const siteRef = hostOf(f.site_referrer);
    return siteRef && !OWN.test(siteRef) ? `finman.money ← ${refLabel(siteRef)}` : 'finman.money (direct)';
  }
  if (f.site_landing && !refHost) {
    const siteRef = hostOf(f.site_referrer);
    return siteRef && !OWN.test(siteRef) ? `finman.money ← ${refLabel(siteRef)}` : 'finman.money (direct)';
  }
  if (refHost && refHost !== 'app.finman.money' && refHost !== 'accounts.google.com') return refLabel(refHost);
  return 'direct';
}

function deviceFromUa(ua) {
  const s = String(ua || '');
  if (!s) return null;
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'ChromeOS'
      : /Linux/.test(s) ? 'Linux' : 'other';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung'
    : /Firefox\//.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'other';
  const mobile = /Mobi|iPhone|Android.+Mobile/.test(s) ? 'mobile' : /iPad|Tablet|Android/.test(s) ? 'tablet' : 'desktop';
  return `${os} · ${br} · ${mobile}`;
}

function clientIp(req) {
  if (!req) return '';
  return geo.cleanIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
}

function isTestEmail(email) {
  const e = String(email || '').toLowerCase();
  return /@[^@]+\.test$/.test(e) || /\+smoke[^@]*@/.test(e);
}

// ---------- OpenPanel (self-hosted) ----------

function opConfig() {
  const url = process.env.OPENPANEL_API_URL;
  const id = process.env.OPENPANEL_SERVER_CLIENT_ID;
  const secret = process.env.OPENPANEL_SERVER_CLIENT_SECRET;
  if (!url || !id || !secret) return null;
  return { url: url.replace(/\/+$/, ''), id, secret };
}

const inflight = new Set();

function opSend(type, payload, ctx = {}) {
  const cfg = opConfig();
  if (!cfg || ctx.test) return Promise.resolve({ skipped: true });
  const headers = {
    'content-type': 'application/json',
    'openpanel-client-id': cfg.id,
    'openpanel-client-secret': cfg.secret,
    'openpanel-sdk-name': 'finman-server',
    'openpanel-sdk-version': '1',
  };
  if (ctx.ip) headers['openpanel-client-ip'] = ctx.ip;
  if (ctx.ua) headers['user-agent'] = String(ctx.ua).slice(0, 400);
  const p = fetch(`${cfg.url}/track`, {
    method: 'POST', headers, body: JSON.stringify({ type, payload }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => {
    if (!r.ok) logger.warn({ status: r.status, type }, '[tracker] openpanel rejected');
    return { ok: r.ok, status: r.status };
  }).catch((e) => {
    logger.warn({ err: e.message, type }, '[tracker] openpanel unreachable');
    return { ok: false };
  });
  inflight.add(p);
  p.finally(() => inflight.delete(p));
  return p;
}

async function flush() {
  // track() may start new sends while earlier ones finish; drain until quiet.
  for (let i = 0; i < 5 && inflight.size; i++) await Promise.all(Array.from(inflight));
}

// ---------- public API ----------

// track('transaction_added', { userId, anonId, props, path, req, test })
function track(event, opts = {}) {
  const p = trackNow(event, opts).catch(() => {});
  inflight.add(p);
  p.finally(() => inflight.delete(p));
  return p;
}

async function trackNow(event, opts = {}) {
  const name = clip(event, 64);
  if (!name) return;
  const ip = opts.ip || clientIp(opts.req);
  const ua = opts.ua || (opts.req && opts.req.get && opts.req.get('user-agent'));
  const props = opts.props && typeof opts.props === 'object' ? opts.props : null;
  try {
    await run(
      'INSERT INTO analytics_events (user_id, anon_id, event, props, path, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [opts.userId || null, clip(opts.anonId, 64), name, props ? JSON.stringify(props).slice(0, 2000) : null,
        clip(opts.path, 300), ip || null],
    );
  } catch (e) {
    logger.warn({ err: e.message, event: name }, '[tracker] insert failed');
  }
  const payload = { name, properties: { ...(props || {}) } };
  if (opts.userId) payload.profileId = String(opts.userId);
  if (opts.path) payload.properties.__path = opts.path;
  await opSend('track', payload, { ip, ua, test: opts.test });
}

// Profile in OpenPanel: id = our user id; first-touch source on the profile
// so cohorts and breakdowns can use it.
function identify(user, acq, ctx = {}) {
  if (!user || !user.id) return Promise.resolve({ skipped: true });
  const name = String(user.fullName || user.full_name || '').trim();
  const [firstName, ...rest] = name ? name.split(/\s+/) : [];
  const properties = { username: user.username, signup_method: acq && acq.method };
  if (acq) {
    for (const k of ['source', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer', 'landing',
      'site_referrer', 'site_landing', 'country', 'device']) {
      if (acq[k]) properties[k === 'source' ? 'acquisition_source' : k] = acq[k];
    }
  }
  return opSend('identify', {
    profileId: String(user.id),
    email: user.email || undefined,
    firstName: firstName || undefined,
    lastName: rest.join(' ') || undefined,
    properties,
  }, { ip: ctx.ip, ua: ctx.ua, test: isTestEmail(user.email) });
}

// Store the acquisition row (once per user) and return it for the email.
async function recordAcquisition(user, method, rawAtt, req, extra = {}) {
  const att = normalizeAttribution(rawAtt);
  const f = att.first;
  const ip = clientIp(req);
  const ua = req && req.get ? req.get('user-agent') : null;
  const g = geo.lookup(ip);
  const row = {
    user_id: user.id,
    method,
    source: sourceLabel(att),
    utm_source: f.utm_source || null,
    utm_medium: f.utm_medium || null,
    utm_campaign: f.utm_campaign || null,
    utm_term: f.utm_term || null,
    utm_content: f.utm_content || null,
    gclid: f.gclid || null,
    fbclid: f.fbclid || null,
    msclkid: f.msclkid || null,
    referrer: f.referrer || null,
    landing: f.landing || null,
    site_referrer: f.site_referrer || null,
    site_landing: f.site_landing || null,
    first_touch: Object.keys(f).length ? JSON.stringify(f) : null,
    last_touch: Object.keys(att.last).length ? JSON.stringify(att.last) : null,
    anon_id: att.anon_id,
    ip: ip || null,
    country: g.country || null,
    city: g.city || null,
    user_agent: clip(ua, 400),
    device: deviceFromUa(ua),
    tz: att.tz,
    lang: att.lang || clip(req && req.get && req.get('accept-language'), 32),
    first_seen_at: f.first_seen_at || null,
    form_ms: extra.form_ms != null ? extra.form_ms : att.form_ms,
  };
  try {
    const cols = Object.keys(row);
    await run(
      `INSERT OR IGNORE INTO user_acquisition (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => row[c]),
    );
    if (att.anon_id) {
      await run('UPDATE analytics_events SET user_id = ? WHERE anon_id = ? AND user_id IS NULL', [user.id, att.anon_id]);
    }
  } catch (e) {
    logger.warn({ err: e.message }, '[tracker] acquisition insert failed');
  }
  row.countryName = g.countryName || null;
  row.region = g.region || null;
  const test = isTestEmail(user.email);
  identify(user, row, { ip, ua });
  track('sign_up', { userId: user.id, anonId: att.anon_id, props: { method, source: row.source }, req, test });
  return row;
}

// app_open: the SPA calls /api/auth/me on every start; count it at most
// once per 30 min per user so it reads as a session.
const lastOpen = new Map();
function appOpen(user, req) {
  const now = Date.now();
  const prev = lastOpen.get(user.id) || 0;
  if (now - prev < 30 * 60 * 1000) return;
  lastOpen.set(user.id, now);
  if (lastOpen.size > 5000) lastOpen.clear();
  track('app_open', { userId: user.id, req, test: isTestEmail(user.email) });
}

async function getAcquisition(userId) {
  try {
    return await get('SELECT * FROM user_acquisition WHERE user_id = ?', [userId]);
  } catch (_) { return null; }
}

module.exports = {
  normalizeAttribution, sourceLabel, deviceFromUa, clientIp, isTestEmail,
  track, identify, recordAcquisition, appOpen, getAcquisition, opConfig, flush,
};
