// routes/invoicePublic.js — the client's side of a published invoice. Mounted at /i, no auth.
//   GET  /i/:token          the page (services/invoice/publicPage.js)
//   GET  /i/:token/pdf      the same PDF the issuer downloads (?download=1 = attachment)
//   GET  /i/:token/logo     the issuer's logo frozen in the invoice
//   POST /i/:token/seen     view beacon from /js/invoice-public.js (a browser that ran the page)
// Only what the issuer published is reachable: the token opens one invoice and nothing else.
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const svc = require('../services/invoice/service');
const page = require('../services/invoice/publicPage');
const tracker = require('../services/tracker');
const logger = require('../lib/logger');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
router.use(limiter);
router.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

const BOT_UA = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|linkedin|embedly|headless|curl|wget|python|axios|node-fetch|go-http/i;

function appUrl() { return (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, ''); }
function signupUrl(userId, code) {
  const ref = code ? `&fm_ref=invite-${code}` : '';
  return `${appUrl()}/?signup${ref}&utm_source=invoice&utm_medium=client_link&utm_campaign=invoice_page`;
}

router.get('/:token', async (req, res) => {
  const lang = page.langOf(req);
  try {
    const p = await svc.publicByToken(req.params.token);
    if (!p) return res.status(404).type('html').send(page.messagePage(lang, 'missing', signupUrl()));
    if (p.gone) return res.status(410).type('html').send(page.messagePage(lang, 'gone', signupUrl()));
    const code = await require('../services/referral').codeFor(p.user_id).catch(() => null);
    res.type('html').send(page.invoicePage(lang, p, { pdfUrl: `/i/${p.token}/pdf`, signupUrl: signupUrl(p.user_id, code) }));
  } catch (e) {
    logger.error({ err: e.message }, '[invoice-link] page failed');
    res.status(500).type('html').send(page.messagePage(lang, 'missing', signupUrl()));
  }
});

router.get('/:token/pdf', async (req, res) => {
  try {
    const pdf = await svc.publicPdf(req.params.token);
    if (!pdf) return res.status(404).json({ error: true, message: 'Not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${pdf.filename}"`);
    res.send(pdf.buffer);
  } catch (e) {
    logger.error({ err: e.message }, '[invoice-link] pdf failed');
    res.status(500).json({ error: true, message: 'PDF failed' });
  }
});

router.get('/:token/logo', async (req, res) => {
  try {
    const p = await svc.publicByToken(req.params.token);
    const m = p && !p.gone && /^data:(image\/(?:png|jpe?g));base64,(.+)$/.exec(String(p.view.logo || ''));
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m[1]);
    res.send(Buffer.from(m[2], 'base64'));
  } catch (e) {
    res.status(404).end();
  }
});

router.post('/:token/seen', async (req, res) => {
  if (BOT_UA.test(String(req.headers['user-agent'] || ''))) return res.status(204).end();
  try {
    const r = await svc.recordView(req.params.token);
    if (r.ok) {
      const p = await svc.publicByToken(req.params.token);
      if (p && !p.gone) tracker.track('invoice_link_viewed', { userId: p.user_id, props: {} });
    }
  } catch (e) {
    logger.warn({ err: e.message }, '[invoice-link] beacon failed');
  }
  res.status(204).end();
});

module.exports = router;
