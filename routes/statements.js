// routes/statements.js — Statement Agent (PDF / photo statement -> proven rows -> import).
//
//   POST   /api/statements              multipart file (PDF, JPG, PNG, WEBP) -> task view (AI reads it, Finman proves it)
//   GET    /api/statements              recent tasks
//   GET    /api/statements/:id          task view (?accountId= marks rows the account already holds)
//   POST   /api/statements/:id/balances { opening_balance?, closing_balance? } typed by the person -> proved again, no AI
//   POST   /api/statements/:id/commit   { accountId, categories? } -> only when the proof holds
//   DELETE /api/statements/:id
'use strict';

const express = require('express');
const passport = require('passport');
const multer = require('multer');
const svc = require('../services/statement/service');
const logger = require('../lib/logger');

const router = express.Router();
const authenticate = passport.authenticate('jwt', { session: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

function fail(res, e) {
  const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status >= 500 && !e.code) logger.error(`[statements] ${e && e.message}`);
  const message = status >= 500 && !e.code ? 'The statement could not be read; nothing was written' : e.message;
  return res.status(status).json({ error: true, code: e.code || 'STATEMENT_ERROR', message });
}

router.get('/', authenticate, async (req, res) => {
  try { res.json({ statements: await svc.list(req.user.id), ai: { shared: svc.platformReady() } }); } catch (e) { fail(res, e); }
});

router.post('/', authenticate, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: true, code: 'UPLOAD', message: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 15 MB' : (err.message || 'Upload failed') });
    if (!req.file) return res.status(400).json({ error: true, code: 'UPLOAD', message: 'No file uploaded' });
    try {
      const id = await svc.create(req.user.id, { buffer: req.file.buffer, mime: req.file.mimetype, fileName: req.file.originalname });
      res.status(201).json(await svc.view(req.user.id, id, { accountId: req.body && req.body.accountId ? req.body.accountId : undefined }));
    } catch (e) { fail(res, e); }
  });
});

router.get('/:id', authenticate, async (req, res) => {
  try { res.json(await svc.view(req.user.id, req.params.id, { accountId: req.query.accountId || undefined })); } catch (e) { fail(res, e); }
});

router.post('/:id/balances', authenticate, async (req, res) => {
  try {
    const id = await svc.setBalances(req.user.id, req.params.id, req.body || {});
    res.json(await svc.view(req.user.id, id, { accountId: (req.body && req.body.accountId) || undefined }));
  } catch (e) { fail(res, e); }
});

router.post('/:id/commit', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ success: true, ...(await svc.commit(req.user.id, req.params.id, { accountId: b.accountId, categories: b.categories, allowCurrencyMismatch: b.allowCurrencyMismatch === true })) });
  } catch (e) { fail(res, e); }
});

router.delete('/:id', authenticate, async (req, res) => {
  try { res.json(await svc.remove(req.user.id, req.params.id)); } catch (e) { fail(res, e); }
});

module.exports = router;
