// routes/reconcile.js — сверка счёта с банковской выпиской (account reconciliation).
//
// GET  /api/reconcile/:accountId            — состояние сверки против выписки
//        ?statementBalance=<число> (или тело { statementBalance })
// POST /api/reconcile/:accountId/clear      — отметить транзакции проведёнными
//        body: { txIds: [..], cleared?: boolean }  (cleared=false снимает отметку)
// POST /api/reconcile/:accountId/adjust     — создать балансирующую корректировку
//        body: { delta?: <число>, statementBalance?: <число> }
//
// Стиль — конвертный (lib/respond + middleware/error), как у wave-2 роутов.
// Владение счётом проверяем через requireOwnership(loadResource).

const express = require('express');
const router = express.Router();
const passport = require('passport');
const { get } = require('../db/database');
const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');
const { requireOwnership } = require('../middleware/authorize');
const reconcileService = require('../services/reconcileService');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Загрузчик счёта для проверки владения. Кладёт { user_id } (и весь счёт)
// в req.resource. Все маршруты ниже работают с :accountId.
const loadAccount = (req) =>
  get(`SELECT * FROM accounts WHERE id = ?`, [Number(req.params.accountId)]);

const guardAccount = requireOwnership(loadAccount);

// Парсинг числа из строки/числа; undefined если невалидно.
function parseNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// GET /api/reconcile/:accountId — посчитать состояние сверки.
router.get('/:accountId', guardAccount, async (req, res, next) => {
  try {
    const statementBalance = parseNumber(
      req.query.statementBalance !== undefined
        ? req.query.statementBalance
        : (req.body && req.body.statementBalance)
    );
    if (statementBalance === undefined) {
      throw new AppError(
        400,
        'INVALID_STATEMENT_BALANCE',
        'statementBalance (number) is required'
      );
    }
    const state = await reconcileService.startReconcile(
      Number(req.params.accountId),
      req.user.id,
      statementBalance
    );
    return ok(res, state);
  } catch (err) {
    return next(err);
  }
});

// POST /api/reconcile/:accountId/clear — отметить/снять отметку «проведено».
router.post('/:accountId/clear', guardAccount, async (req, res, next) => {
  try {
    const txIds = (req.body && req.body.txIds) || [];
    if (!Array.isArray(txIds) || txIds.length === 0) {
      throw new AppError(400, 'INVALID_TX_IDS', 'txIds must be a non-empty array');
    }
    const setCleared = req.body.cleared === undefined ? true : !!req.body.cleared;
    const result = setCleared
      ? await reconcileService.markCleared(txIds, req.user.id)
      : await reconcileService.markUncleared(txIds, req.user.id);
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
});

// POST /api/reconcile/:accountId/adjust — создать балансирующую корректировку.
// Если передан delta — используем его; иначе вычисляем из statementBalance.
router.post('/:accountId/adjust', guardAccount, async (req, res, next) => {
  try {
    const accountId = Number(req.params.accountId);
    let delta = parseNumber(req.body && req.body.delta);

    if (delta === undefined) {
      const statementBalance = parseNumber(req.body && req.body.statementBalance);
      if (statementBalance === undefined) {
        throw new AppError(
          400,
          'INVALID_ADJUSTMENT',
          'Provide delta or statementBalance (number)'
        );
      }
      // Пересчитываем delta из текущего очищенного баланса.
      const state = await reconcileService.startReconcile(
        accountId,
        req.user.id,
        statementBalance
      );
      delta = state.delta;
    }

    const tx = await reconcileService.postAdjustment(accountId, req.user.id, delta);
    return ok(res, { adjustment: tx, delta }, tx ? 201 : 200);
  } catch (err) {
    if (err && err.code === 'ACCOUNT_NOT_FOUND') {
      return next(new AppError(404, 'NOT_FOUND', 'Account not found'));
    }
    return next(err);
  }
});

module.exports = router;
