// routes/billing.js — биллинг/подписки (F10). Заменяет Foundation-стуб.
//
// Маршруты:
//   GET  /api/billing/plans     — публичный каталог тарифов (+ _meta demo/configured)
//   POST /api/billing/checkout  — (auth) создать Stripe Checkout Session
//   POST /api/billing/webhook   — Stripe webhook (СЫРОЕ тело!)
//
// ВАЖНО про webhook: для проверки подписи Stripe нужно НЕ распарсенное тело.
// Глобальный express.json() в server.js уже распарсил бы body, поэтому здесь
// маршрут /webhook сам подключает express.raw() ПЕРЕД хендлером. Это работает
// даже без правок server.js (мы читаем req.body как Buffer). Подробности — в
// integration_notes feature-стрима.

'use strict';

const express = require('express');
const passport = require('passport');
const router = express.Router();

const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');
const { annotate, demoNotice, isDemo } = require('../lib/demoFlag');
const billing = require('../services/billingService');
const logger = require('../lib/logger');

const auth = passport.authenticate('jwt', { session: false });

// ---- GET /api/billing/plans (публично) -----------------------------------
router.get('/plans', (req, res, next) => {
  try {
    const plans = billing.getPlans();
    const configured = billing.isConfigured();
    const meta = {
      demo: isDemo() || !configured,
      billingConfigured: configured,
    };
    if (!configured) {
      Object.assign(meta, demoNotice('billing', 'Stripe not configured'));
    }
    return ok(res, annotate({ plans }, meta));
  } catch (err) {
    return next(err);
  }
});

// ---- POST /api/billing/checkout (auth) -----------------------------------
router.post('/checkout', auth, async (req, res, next) => {
  try {
    if (!req.user || req.user.id == null) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    const planId = (req.body && (req.body.plan || req.body.planId || req.body.tier)) || '';
    if (!planId) {
      throw new AppError(400, 'INVALID_PLAN', 'Missing "plan" in request body');
    }

    // Если Stripe не настроен — отдаём ЧЁТКИЙ disabled-ответ (503), не фейк.
    if (!billing.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'BILLING_DISABLED',
          message:
            'Billing is not configured on this server (Stripe disabled). Set STRIPE_SECRET_KEY to enable checkout.',
        },
        _meta: demoNotice('billing', 'Stripe not configured'),
      });
    }

    const session = await billing.createCheckoutSession(req.user.id, planId);
    return ok(res, annotate({ sessionId: session.id, url: session.url }, { billingConfigured: true }));
  } catch (err) {
    return next(err);
  }
});

// ---- POST /api/billing/webhook (raw body) --------------------------------
// express.raw гарантирует, что req.body — Buffer (нужно Stripe для подписи).
router.post(
  '/webhook',
  express.raw({ type: '*/*' }),
  async (req, res, next) => {
    try {
      if (!billing.isConfigured()) {
        return res.status(503).json({
          success: false,
          error: { code: 'BILLING_DISABLED', message: 'Billing is not configured' },
          _meta: demoNotice('billing', 'Stripe not configured'),
        });
      }
      const sig = req.headers['stripe-signature'];
      // req.body может быть Buffer (express.raw) либо уже объект/строка, если
      // глобальный парсер опередил — handleWebhook принимает оба варианта.
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body || {});
      const result = await billing.handleWebhook(rawBody, sig);
      logger.info({ type: result.type, userId: result.userId }, 'Stripe webhook processed');
      return ok(res, result);
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
