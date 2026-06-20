// routes/health.js — health & readiness probes.
// Смонтирован в server.js как app.use('/api', healthRoutes), даёт:
//   GET /api/health -> { status:'ok', uptime, version }
//   GET /api/ready  -> проверяет доступность БД
const express = require('express');
const router = express.Router();
const { ok, fail } = require('../lib/respond');
const { get } = require('../db/database');

let version = '1.0.0';
try {
  version = require('../package.json').version || version;
} catch (e) {
  /* ignore */
}

// Liveness
router.get('/health', (req, res) => {
  return ok(res, {
    status: 'ok',
    uptime: process.uptime(),
    version,
    timestamp: new Date().toISOString(),
  });
});

// Readiness — проверяем, что БД отвечает
router.get('/ready', async (req, res) => {
  try {
    await get('SELECT 1 AS ok');
    return ok(res, { status: 'ready', db: 'up' });
  } catch (err) {
    return fail(res, 503, 'NOT_READY', 'Database not reachable');
  }
});

module.exports = router;
