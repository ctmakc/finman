// routes/anomalies.js — детектор аномалий (F7).
// GET /api/anomalies — аномальные транзакции текущего пользователя.

const express = require('express');
const router = express.Router();
const passport = require('passport');
const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');
const anomalyService = require('../services/anomalyService');

router.use(passport.authenticate('jwt', { session: false }));

// GET /api/anomalies?notify=1&lookbackDays=180
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.id;

    const opts = {};
    if (req.query.lookbackDays !== undefined) {
      const n = parseInt(req.query.lookbackDays, 10);
      if (Number.isFinite(n) && n > 0) opts.lookbackDays = n;
    }
    // Запись уведомлений включаем только по явному запросу.
    if (req.query.notify === '1' || req.query.notify === 'true') {
      opts.notify = true;
    }

    const anomalies = await anomalyService.detectForUser(userId, opts);

    const summary = {
      total: anomalies.length,
      high: anomalies.filter((a) => a.severity === 'high').length,
      medium: anomalies.filter((a) => a.severity === 'medium').length,
      low: anomalies.filter((a) => a.severity === 'low').length,
      byType: anomalies.reduce((acc, a) => {
        acc[a.type] = (acc[a.type] || 0) + 1;
        return acc;
      }, {}),
    };

    return ok(res, { anomalies, summary });
  } catch (err) {
    // AppError пробрасываем как есть, остальное оборачиваем централизованно.
    if (err instanceof AppError) return next(err);
    return next(new AppError(500, 'ANOMALY_FAILED', err.message));
  }
});

module.exports = router;
