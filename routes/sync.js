// routes/sync.js — ручной запуск и статус фоновой банковской синхронизации (F6).
// Заменяет Foundation-стуб. Авторизация JWT выполняется внутри роутера, т.к.
// в server.js /api/sync смонтирован без внешнего auth-middleware.
//
// Эндпоинты:
//   POST /api/sync/run     -> синхронизировать транзакции текущего пользователя
//   GET  /api/sync/status  -> состояние планировщика (enabled/running/schedule)

const express = require('express');
const passport = require('passport');

const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');
const syncScheduler = require('../services/syncScheduler');

const router = express.Router();

// JWT-аутентификация для всех маршрутов sync.
router.use(passport.authenticate('jwt', { session: false }));

// Ручной запуск синхронизации для ТЕКУЩЕГО пользователя.
router.post('/run', async (req, res, next) => {
  try {
    const summary = await syncScheduler.runOnce(req.user.id);
    return ok(res, {
      summary: {
        connections: summary.connections,
        accounts: summary.accounts,
        fetched: summary.fetched,
        inserted: summary.inserted,
        skipped: summary.skipped,
        errors: summary.errors.length,
      },
    });
  } catch (err) {
    // Оборачиваем неизвестные ошибки в AppError, чтобы errorHandler отдал
    // единый формат {success:false,error:{code,message}}.
    if (err instanceof AppError) return next(err);
    return next(new AppError(500, 'SYNC_FAILED', err.message || 'Sync failed'));
  }
});

// Статус планировщика.
router.get('/status', (req, res) => {
  return ok(res, syncScheduler.status());
});

module.exports = router;
