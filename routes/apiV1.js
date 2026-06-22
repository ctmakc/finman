// routes/apiV1.js — публичный REST API v1 (Firefly-gap) + управление токенами.
//
// Монтируется в server.js как: app.use('/api/v1', apiV1Routes)
// (НЕ оборачивать снаружи в jwt/patAuth — авторизация настроена ВНУТРИ роутера).
//
// Две поверхности с РАЗНОЙ авторизацией:
//
//   1) Управление токенами — за обычным passport-jwt (как в UI-сессии):
//        GET    /api/v1/tokens         -> список токенов (без plaintext)
//        POST   /api/v1/tokens         { name } -> создаёт токен, ОДИН РАЗ
//                                        отдаёт plaintext { token }
//        DELETE /api/v1/tokens/:id     -> отзывает токен
//
//   2) Read-only данные — за Personal Access Token (Bearer finman_pat_…):
//        GET    /api/v1/accounts       -> счета пользователя
//        GET    /api/v1/transactions   -> транзакции (?limit&offset&accountId)
//        GET    /api/v1/budgets        -> бюджеты пользователя
//
// Всё отвечает в формате envelope: ok()/fail() -> { success, data } / { success,
// error:{ code, message } }. Ошибки бросаются как AppError и форматируются
// центральным errorHandler.

const express = require('express');
const passport = require('passport');
const router = express.Router();

const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');
const patService = require('../services/patService');
const patAuth = require('../middleware/patAuth');
const { query } = require('../db/database');

// passport-jwt — для управления токенами (та же сессия, что и в UI).
const jwtAuth = passport.authenticate('jwt', { session: false });

// Обёртка для async-хендлеров: пробрасывает ошибки в errorHandler.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Безопасный парсинг числовых query-параметров с границами.
function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ==================== УПРАВЛЕНИЕ ТОКЕНАМИ (jwt) ====================

// GET /api/v1/tokens — список токенов пользователя (без plaintext/хэшей).
router.get(
  '/tokens',
  jwtAuth,
  wrap(async (req, res) => {
    const tokens = await patService.list(req.user.id);
    return ok(res, { tokens });
  })
);

// POST /api/v1/tokens — создать токен. Plaintext возвращается ОДИН раз.
router.post(
  '/tokens',
  jwtAuth,
  wrap(async (req, res) => {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) {
      throw new AppError(400, 'INVALID_NAME', 'Field "name" is required');
    }
    const created = await patService.create(req.user.id, name);
    // created.token — plaintext, виден только здесь и больше нигде.
    return ok(res, { token: created }, 201);
  })
);

// DELETE /api/v1/tokens/:id — отозвать токен.
router.delete(
  '/tokens/:id',
  jwtAuth,
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      throw new AppError(400, 'INVALID_ID', 'Invalid token id');
    }
    const revoked = await patService.revoke(req.user.id, id);
    if (!revoked) {
      throw new AppError(404, 'NOT_FOUND', 'Token not found');
    }
    return ok(res, { revoked: true, id });
  })
);

// ==================== READ-ONLY ДАННЫЕ (Personal Access Token) ====================
// patAuth применяется ТОЛЬКО к маршрутам ниже этой строки. /tokens (выше) уже
// объявлены и не затрагиваются.
router.use(patAuth);

// GET /api/v1/accounts — счета пользователя.
router.get(
  '/accounts',
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT id, name, account_number, bank_name, currency, balance, account_type, is_active, created_at
         FROM accounts
        WHERE user_id = ? AND is_active = 1
        ORDER BY created_at DESC, id DESC`,
      [req.user.id]
    );
    return ok(res, { accounts: rows });
  })
);

// GET /api/v1/transactions — транзакции пользователя (пагинация + фильтр по счёту).
router.get(
  '/transactions',
  wrap(async (req, res) => {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const params = [req.user.id];
    let sql = `SELECT id, account_id, date, description, category, amount, type, created_at
                 FROM transactions
                WHERE user_id = ?`;
    if (req.query.accountId) {
      const accId = parseInt(req.query.accountId, 10);
      if (Number.isFinite(accId)) {
        sql += ' AND account_id = ?';
        params.push(accId);
      }
    }
    sql += ' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = await query(sql, params);
    return ok(res, { transactions: rows, limit, offset });
  })
);

// GET /api/v1/budgets — бюджеты пользователя.
router.get(
  '/budgets',
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT id, name, category, amount, spent, period, start_date, end_date, currency, is_active, created_at
         FROM budgets
        WHERE user_id = ? AND is_active = 1
        ORDER BY created_at DESC, id DESC`,
      [req.user.id]
    );
    return ok(res, { budgets: rows });
  })
);

module.exports = router;
