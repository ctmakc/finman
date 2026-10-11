// routes/health.js — health & readiness probes.
// Смонтирован в server.js как app.use('/api', healthRoutes), даёт:
//   GET /api/health      -> { status:'ok', uptime, version, demo, seeded_at }
//   GET /api/health/demo -> { demo, seed_on_empty, seeded_at, demo_user, message }
//   GET /api/ready       -> проверяет доступность БД
const express = require('express');
const router = express.Router();
const { ok, fail } = require('../lib/respond');
const { get } = require('../db/database');
const demoSeed = require('../lib/demoSeed');

let version = '1.0.0';
try {
  version = require('../package.json').version || version;
} catch (e) {
  /* ignore */
}

// Liveness. `demo` mirrors DEMO_MODE; `seeded_at` is when the demo household was
// created (null on a real instance). Liveness never fails on the demo lookup.
router.get('/health', async (req, res) => {
  let demo = { demo: false, seeded_at: null };
  try {
    demo = await demoSeed.seedInfo();
  } catch (e) {
    /* ignore */
  }
  return ok(res, {
    status: 'ok',
    uptime: process.uptime(),
    version,
    timestamp: new Date().toISOString(),
    demo: demo.demo,
    seeded_at: demo.seeded_at,
  });
});

// Demo banner hook for the frontend: "Demo instance — data resets on every deploy".
// Public (no auth): the login screen needs it too. No secrets here — the demo
// password is documented, the username alone is harmless.
router.get('/health/demo', async (req, res) => {
  const info = await demoSeed.seedInfo();
  return ok(res, {
    ...info,
    message: info.demo || info.seed_on_empty ? 'Demo instance — data resets on every deploy' : null,
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
