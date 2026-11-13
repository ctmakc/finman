// routes/invoices.js — invoices + invoice templates. Contract: see services/invoice/service.js.
// Mounted at /api/invoices. Write actions are journaled by middleware/activity.js; here only
// the PDF download (a GET) is tracked. Every route needs the JWT except GET /shared/:code (template
// preview for the sign-up page of a shared template link).
'use strict';

const express = require('express');
const passport = require('passport');
const svc = require('../services/invoice/service');
const tracker = require('../services/tracker');

const router = express.Router();
const auth = passport.authenticate('jwt', { session: false });

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof svc.InvoiceError) return res.status(e.status).json({ error: true, message: e.message });
    console.error('invoices:', e);
    return res.status(500).json({ error: true, message: 'Invoice request failed' });
  }
};
const id = (req) => parseInt(req.params.id, 10);
function track(req, event, props) {
  try {
    tracker.track(event, { userId: req.user.id, props, req, test: tracker.isTestEmail(req.user.email) });
  } catch (_) { /* analytics never breaks the request */ }
}
function sendPdf(res, { buffer, filename }, download) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}

// Public: what a shared template link holds (no requisites, only name/layout/currency/seller).
router.get('/shared/:code', wrap(async (req, res) => res.json(await svc.getShared(req.params.code))));

router.use(auth);

// ---- templates ----
router.get('/presets', wrap(async (req, res) => res.json({ presets: svc.listPresets() })));
router.get('/profiles', wrap(async (req, res) => res.json({ profiles: await svc.listProfiles(req.user.id) })));
router.post('/profiles', wrap(async (req, res) => {
  res.status(201).json({ profile: await svc.createProfile(req.user.id, req.body) });
}));
router.get('/profiles/:id', wrap(async (req, res) => res.json({ profile: await svc.getProfile(req.user.id, id(req)) })));
router.put('/profiles/:id', wrap(async (req, res) => res.json({ profile: await svc.updateProfile(req.user.id, id(req), req.body) })));
router.delete('/profiles/:id', wrap(async (req, res) => res.json(await svc.deleteProfile(req.user.id, id(req)))));
router.get('/profiles/:id/image/:kind', wrap(async (req, res) => {
  const img = await svc.profileImage(req.user.id, id(req), req.params.kind);
  res.setHeader('Content-Type', img.type);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(img.buffer);
}));
router.post('/profiles/:id/share', wrap(async (req, res) => {
  res.json(await svc.shareProfile(req.user.id, id(req)));
}));
router.post('/shared/:code/import', wrap(async (req, res) => {
  const { profile, created } = await svc.importShared(req.user.id, req.params.code);
  res.status(created ? 201 : 200).json({ profile });
}));

// ---- invoices ----
router.get('/', wrap(async (req, res) => res.json(await svc.listInvoices(req.user.id, { status: req.query.status, q: req.query.q }))));
router.get('/next-number', wrap(async (req, res) => {
  res.json({ number: await svc.nextNumber(req.user.id, parseInt(req.query.profile_id, 10), req.query.date) });
}));
router.post('/preview', wrap(async (req, res) => sendPdf(res, await svc.previewPdf(req.user.id, req.body), false)));
router.post('/', wrap(async (req, res) => {
  res.status(201).json({ invoice: await svc.createInvoice(req.user.id, req.body) });
}));
router.get('/:id', wrap(async (req, res) => res.json({ invoice: await svc.getInvoice(req.user.id, id(req)) })));
router.put('/:id', wrap(async (req, res) => res.json({ invoice: await svc.updateInvoice(req.user.id, id(req), req.body) })));
router.post('/:id/status', wrap(async (req, res) => {
  res.json({ invoice: await svc.setStatus(req.user.id, id(req), req.body && req.body.status) });
}));
router.post('/:id/duplicate', wrap(async (req, res) => res.status(201).json({ invoice: await svc.duplicateInvoice(req.user.id, id(req)) })));
router.delete('/:id', wrap(async (req, res) => res.json(await svc.deleteInvoice(req.user.id, id(req)))));
router.get('/:id/pdf', wrap(async (req, res) => {
  const pdf = await svc.invoicePdf(req.user.id, id(req));
  if (req.query.download) track(req, 'invoice_pdf_downloaded', {});
  sendPdf(res, pdf, !!req.query.download);
}));

module.exports = router;
