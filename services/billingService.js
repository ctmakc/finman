// services/billingService.js — биллинг/подписки через Stripe, спрятанный за env.
//
// Поведение:
//   - Если STRIPE_SECRET_KEY задан -> работаем по-настоящему (require('stripe')).
//   - Если не задан -> ЧЁТКО помеченный disabled/mock-режим: ничего не падает,
//     checkout отдаёт 503 SERVICE_DISABLED, вебхук безопасно отвергается.
//
// Экспорт:
//   isConfigured()                       -> boolean
//   getPlans()                           -> [{ id, tier, name, price, currency, interval, features }]
//   getPlan(planId)                      -> plan | null
//   createCheckoutSession(userId, plan)  -> Promise<{ id, url, demo? }>
//   handleWebhook(rawBody, sig)          -> Promise<{ received, type, tier?, userId?, demo? }>
//
// БД: обновляем users.subscription_tier + stripe_customer_id + stripe_subscription_id
// (колонки гарантирует миграция Foundation 001).

'use strict';

const { run, get } = require('../db/database');
const { AppError } = require('../middleware/error');
const { isDemo } = require('../lib/demoFlag');
const logger = require('../lib/logger');

// ---- Каталог планов (статичный, без обращения к Stripe) -----------------
// price в минорных единицах (центах) для совместимости со Stripe-семантикой,
// но getPlans отдаёт человекочитаемые поля.
const PLANS = [
  {
    id: 'free',
    tier: 'free',
    name: 'Free',
    price: 0,
    currency: 'usd',
    interval: 'month',
    features: [
      'Учёт счетов и транзакций',
      'Бюджеты и цели',
      'Импорт CSV',
    ],
  },
  {
    id: 'pro',
    tier: 'pro',
    name: 'Pro',
    price: 9,
    currency: 'usd',
    interval: 'month',
    features: [
      'Всё из Free',
      'AI-ассистент по финансам',
      'Синхронизация с банками',
      'Детектор аномалий',
    ],
  },
  {
    id: 'family',
    tier: 'family',
    name: 'Family',
    price: 19,
    currency: 'usd',
    interval: 'month',
    features: [
      'Всё из Pro',
      'Семейный доступ и общий бюджет',
      'До 5 участников',
      'Приоритетная поддержка',
    ],
  },
];

// Соответствие plan.id -> Stripe Price ID (из env, опционально).
// Напр. STRIPE_PRICE_PRO / STRIPE_PRICE_FAMILY.
function stripePriceIdFor(planId) {
  const key = `STRIPE_PRICE_${String(planId).toUpperCase()}`;
  return process.env[key] || '';
}

// ---- Конфигурация Stripe -------------------------------------------------
let _stripe = null;
let _stripeLoadError = null;

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// Ленивая инициализация Stripe SDK. require('stripe') ТОЛЬКО если есть ключ,
// чтобы окружения без зависимости/ключа не падали на старте.
function getStripe() {
  if (!isConfigured()) return null;
  if (_stripe) return _stripe;
  if (_stripeLoadError) return null;
  try {
    // eslint-disable-next-line global-require
    const Stripe = require('stripe');
    _stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    return _stripe;
  } catch (err) {
    _stripeLoadError = err;
    logger.error({ err: err.message }, 'Stripe SDK недоступен, биллинг в disabled-режиме');
    return null;
  }
}

// ---- Публичные функции ---------------------------------------------------

function getPlans() {
  // Возвращаем копию, чтобы вызывающий код не мог мутировать каталог.
  return PLANS.map((p) => ({ ...p, features: [...p.features] }));
}

function getPlan(planId) {
  const p = PLANS.find((x) => x.id === planId || x.tier === planId);
  return p ? { ...p, features: [...p.features] } : null;
}

// Создаёт Stripe Checkout Session. plan может быть id ('pro') или объектом плана.
async function createCheckoutSession(userId, plan) {
  const planObj = typeof plan === 'string' ? getPlan(plan) : plan;
  if (!planObj || !planObj.id) {
    throw new AppError(400, 'INVALID_PLAN', 'Unknown subscription plan');
  }
  if (planObj.tier === 'free' || planObj.id === 'free') {
    throw new AppError(400, 'INVALID_PLAN', 'Free plan does not require checkout');
  }

  const stripe = getStripe();
  if (!stripe) {
    // Честный disabled-ответ вместо фейковой оплаты.
    throw new AppError(
      503,
      'BILLING_DISABLED',
      'Billing is not configured on this server (Stripe disabled). Set STRIPE_SECRET_KEY to enable.'
    );
  }

  const priceId = stripePriceIdFor(planObj.id);
  const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3401';

  // Подгружаем/создаём stripe_customer_id для пользователя.
  let customerId = null;
  try {
    const row = await get('SELECT email, stripe_customer_id FROM users WHERE id = ?', [userId]);
    customerId = row && row.stripe_customer_id ? row.stripe_customer_id : null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: row && row.email ? row.email : undefined,
        metadata: { userId: String(userId) },
      });
      customerId = customer.id;
      await run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, userId]);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ err: err.message, userId }, 'Не удалось подготовить Stripe customer');
    throw new AppError(502, 'BILLING_PROVIDER_ERROR', 'Failed to prepare billing customer');
  }

  try {
    const lineItem = priceId
      ? { price: priceId, quantity: 1 }
      : {
          // Fallback: создаём price_data на лету, если STRIPE_PRICE_* не задан.
          price_data: {
            currency: planObj.currency || 'usd',
            unit_amount: Math.round((planObj.price || 0) * 100),
            recurring: { interval: planObj.interval || 'month' },
            product_data: { name: `FINMAN ${planObj.name}` },
          },
          quantity: 1,
        };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [lineItem],
      success_url: `${baseUrl}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?billing=cancel`,
      metadata: { userId: String(userId), tier: planObj.tier },
      subscription_data: {
        metadata: { userId: String(userId), tier: planObj.tier },
      },
    });

    return { id: session.id, url: session.url };
  } catch (err) {
    logger.error({ err: err.message, userId, plan: planObj.id }, 'Stripe checkout session failed');
    throw new AppError(502, 'BILLING_PROVIDER_ERROR', 'Failed to create checkout session');
  }
}

// Применяет изменение тира к пользователю по userId.
async function applyTier(userId, tier, { subscriptionId, customerId } = {}) {
  const sets = ['subscription_tier = ?'];
  const params = [tier];
  if (subscriptionId !== undefined) {
    sets.push('stripe_subscription_id = ?');
    params.push(subscriptionId);
  }
  if (customerId !== undefined) {
    sets.push('stripe_customer_id = ?');
    params.push(customerId);
  }
  params.push(userId);
  await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
}

// Находит userId из объекта Stripe (metadata, либо по stripe_customer_id в БД).
async function resolveUserId(obj) {
  if (obj && obj.metadata && obj.metadata.userId) {
    const n = parseInt(obj.metadata.userId, 10);
    if (!Number.isNaN(n)) return n;
  }
  const customerId = obj && (obj.customer || obj.customer_id);
  if (customerId) {
    const row = await get('SELECT id FROM users WHERE stripe_customer_id = ?', [customerId]);
    if (row && row.id != null) return row.id;
  }
  return null;
}

// Обрабатывает Stripe-вебхук. rawBody — Buffer/строка сырого тела, sig — заголовок.
// При наличии STRIPE_WEBHOOK_SECRET проверяем подпись; иначе (dev) парсим как есть.
async function handleWebhook(rawBody, sig) {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(
      503,
      'BILLING_DISABLED',
      'Billing is not configured on this server (Stripe disabled).'
    );
  }

  let event;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (webhookSecret) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      logger.warn({ err: err.message }, 'Stripe webhook signature verification failed');
      throw new AppError(400, 'WEBHOOK_INVALID_SIGNATURE', 'Invalid webhook signature');
    }
  } else {
    // Без секрета — только в dev: доверяем телу как есть.
    try {
      event = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      throw new AppError(400, 'WEBHOOK_INVALID_BODY', 'Invalid webhook body');
    }
  }

  const type = event && event.type;
  const obj = (event && event.data && event.data.object) || {};

  // Маппинг событий -> изменение тира.
  if (type === 'checkout.session.completed') {
    const userId = await resolveUserId(obj);
    const tier = (obj.metadata && obj.metadata.tier) || 'pro';
    if (userId != null) {
      await applyTier(userId, tier, {
        subscriptionId: obj.subscription || null,
        customerId: obj.customer || undefined,
      });
      return { received: true, type, tier, userId };
    }
    return { received: true, type, tier: null, userId: null };
  }

  if (type === 'customer.subscription.updated' || type === 'customer.subscription.created') {
    const userId = await resolveUserId(obj);
    const tier = (obj.metadata && obj.metadata.tier) || 'pro';
    const active = obj.status === 'active' || obj.status === 'trialing';
    if (userId != null) {
      await applyTier(userId, active ? tier : 'free', {
        subscriptionId: obj.id || null,
      });
      return { received: true, type, tier: active ? tier : 'free', userId };
    }
    return { received: true, type, tier: null, userId: null };
  }

  if (type === 'customer.subscription.deleted') {
    const userId = await resolveUserId(obj);
    if (userId != null) {
      await applyTier(userId, 'free', { subscriptionId: null });
      return { received: true, type, tier: 'free', userId };
    }
    return { received: true, type, tier: 'free', userId: null };
  }

  // Прочие события подтверждаем, но не трогаем БД.
  return { received: true, type: type || 'unknown' };
}

module.exports = {
  isConfigured,
  getPlans,
  getPlan,
  createCheckoutSession,
  handleWebhook,
  // экспортируем для тестов/повторного использования
  _internal: { applyTier, resolveUserId, stripePriceIdFor, isDemo },
};
