// test/billing.test.js — F10 billing/gating stream.
//
// Покрытие:
//   1) GET /api/billing/plans -> возвращает тарифы (free/pro/family) + _meta.
//   2) POST /api/billing/checkout без настроенного Stripe -> 503 BILLING_DISABLED.
//   3) Вебхук обновляет users.subscription_tier (Stripe замокан).
//   4) lib/demoFlag — isDemo/annotate/demoNotice.
//   5) billingService.getPlans/getPlan — форма данных, иммутабельность.
//
// ВАЖНО про мок Stripe: модуль 'stripe' мокается через jest.mock ДО загрузки
// сервиса. STRIPE_SECRET_KEY выставляется только в тех тестах, где нужен
// «настроенный» режим, и сбрасывается после.

const { makeApp } = require('./helpers/app');

// --- Мок Stripe SDK -------------------------------------------------------
// Контролируемый мок: фабрика возвращает объект с нужными методами.
const stripeState = {
  checkoutUrl: 'https://checkout.stripe.test/session/cs_test_123',
  constructEventImpl: null, // если задан — используется для webhooks.constructEvent
};

jest.mock('stripe', () => {
  return jest.fn(() => ({
    customers: {
      create: jest.fn(async ({ email, metadata } = {}) => ({
        id: 'cus_test_' + (metadata && metadata.userId ? metadata.userId : 'x'),
        email,
      })),
    },
    checkout: {
      sessions: {
        create: jest.fn(async () => ({
          id: 'cs_test_123',
          url: stripeState.checkoutUrl,
        })),
      },
    },
    webhooks: {
      constructEvent: jest.fn((body) => {
        if (stripeState.constructEventImpl) return stripeState.constructEventImpl(body);
        return typeof body === 'string' ? JSON.parse(body) : JSON.parse(body.toString('utf8'));
      }),
    },
  }));
});

// ==========================================================================
describe('lib/demoFlag', () => {
  const demoFlag = require('../lib/demoFlag');
  const ORIG = process.env.DEMO_MODE;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = ORIG;
  });

  test('isDemo reflects DEMO_MODE env truthiness', () => {
    delete process.env.DEMO_MODE;
    expect(demoFlag.isDemo()).toBe(false);
    process.env.DEMO_MODE = 'true';
    expect(demoFlag.isDemo()).toBe(true);
    process.env.DEMO_MODE = '1';
    expect(demoFlag.isDemo()).toBe(true);
    process.env.DEMO_MODE = 'off';
    expect(demoFlag.isDemo()).toBe(false);
  });

  test('annotate merges _meta without mutating input', () => {
    delete process.env.DEMO_MODE;
    const input = { a: 1 };
    const out = demoFlag.annotate(input, { feature: 'x' });
    expect(out.a).toBe(1);
    expect(out._meta).toMatchObject({ demo: false, feature: 'x' });
    expect(input._meta).toBeUndefined(); // не мутировали
  });

  test('annotate wraps arrays under items', () => {
    const out = demoFlag.annotate([1, 2, 3], { feature: 'list' });
    expect(out.items).toEqual([1, 2, 3]);
    expect(out._meta.feature).toBe('list');
  });

  test('demoNotice labels a disabled feature clearly', () => {
    const n = demoFlag.demoNotice('billing', 'Stripe not configured');
    expect(n.demo).toBe(true);
    expect(n.mode).toBe('disabled');
    expect(n.feature).toBe('billing');
    expect(typeof n.message).toBe('string');
    expect(n.message).toMatch(/demo/i);
  });
});

// ==========================================================================
describe('billingService.getPlans / getPlan', () => {
  const billing = require('../services/billingService');

  test('getPlans returns free/pro/family tiers', () => {
    const plans = billing.getPlans();
    const tiers = plans.map((p) => p.tier).sort();
    expect(tiers).toEqual(['family', 'free', 'pro']);
    plans.forEach((p) => {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('price');
      expect(Array.isArray(p.features)).toBe(true);
    });
  });

  test('getPlans is immutable (returns copies)', () => {
    const a = billing.getPlans();
    a[0].features.push('HACKED');
    const b = billing.getPlans();
    expect(b[0].features).not.toContain('HACKED');
  });

  test('getPlan resolves by id and tier, null for unknown', () => {
    expect(billing.getPlan('pro').tier).toBe('pro');
    expect(billing.getPlan('family').id).toBe('family');
    expect(billing.getPlan('nope')).toBeNull();
  });

  test('isConfigured is false without STRIPE_SECRET_KEY', () => {
    const orig = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    expect(billing.isConfigured()).toBe(false);
    if (orig !== undefined) process.env.STRIPE_SECRET_KEY = orig;
  });
});

// ==========================================================================
describe('GET /api/billing/plans (public)', () => {
  let ctx;
  beforeAll(async () => {
    delete process.env.STRIPE_SECRET_KEY; // disabled mode
    ctx = await makeApp();
  });
  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('returns plans and a demo/_meta marker when Stripe is not configured', async () => {
    const res = await ctx.request.get('/api/billing/plans');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(Array.isArray(data.plans)).toBe(true);
    const tiers = data.plans.map((p) => p.tier).sort();
    expect(tiers).toEqual(['family', 'free', 'pro']);
    expect(data._meta).toBeDefined();
    expect(data._meta.billingConfigured).toBe(false);
    expect(data._meta.demo).toBe(true);
  });

  test('plans endpoint requires no auth', async () => {
    const res = await ctx.request.get('/api/billing/plans'); // no Authorization header
    expect(res.status).toBe(200);
  });
});

// ==========================================================================
describe('POST /api/billing/checkout', () => {
  let ctx;
  beforeAll(async () => {
    delete process.env.STRIPE_SECRET_KEY; // disabled
    ctx = await makeApp();
  });
  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('401 without auth', async () => {
    const res = await ctx.request.post('/api/billing/checkout').send({ plan: 'pro' });
    expect(res.status).toBe(401);
  });

  test('503 BILLING_DISABLED when Stripe is not configured', async () => {
    const res = await ctx.request
      .post('/api/billing/checkout')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ plan: 'pro' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BILLING_DISABLED');
    expect(res.body._meta).toBeDefined();
    expect(res.body._meta.mode).toBe('disabled');
  });

  test('400 INVALID_PLAN when plan missing (auth present, stripe configured)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    const local = await makeApp();
    try {
      const res = await local.request
        .post('/api/billing/checkout')
        .set('Authorization', 'Bearer ' + local.token)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PLAN');
    } finally {
      await local.close();
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  test('creates a checkout session URL when Stripe is configured (mocked)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    const local = await makeApp();
    try {
      const res = await local.request
        .post('/api/billing/checkout')
        .set('Authorization', 'Bearer ' + local.token)
        .send({ plan: 'pro' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBe(stripeState.checkoutUrl);
      expect(res.body.data.sessionId).toBe('cs_test_123');
    } finally {
      await local.close();
      delete process.env.STRIPE_SECRET_KEY;
    }
  });
});

// ==========================================================================
describe('billingService.handleWebhook (Stripe mocked)', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    delete process.env.STRIPE_WEBHOOK_SECRET; // dev path: parse body as-is
    stripeState.constructEventImpl = null;
  });
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  test('checkout.session.completed updates users.subscription_tier', async () => {
    const ctx = await makeApp();
    try {
      // Сервис привязан к временной БД этого app (harness выставил DATABASE_PATH).
      const billing = require('../services/billingService');

      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_abc',
            subscription: 'sub_abc',
            metadata: { userId: String(ctx.userId), tier: 'pro' },
          },
        },
      };
      const result = await billing.handleWebhook(Buffer.from(JSON.stringify(event)), 'sig_test');
      expect(result.received).toBe(true);
      expect(result.tier).toBe('pro');
      expect(result.userId).toBe(ctx.userId);

      // Читаем тир через тот же db-хелпер, что использует сервис.
      const dbHelpers = require('../db/database');
      const user = await dbHelpers.get('SELECT subscription_tier, stripe_subscription_id FROM users WHERE id = ?', [ctx.userId]);
      expect(user.subscription_tier).toBe('pro');
      expect(user.stripe_subscription_id).toBe('sub_abc');
    } finally {
      await ctx.close();
    }
  });

  test('customer.subscription.deleted downgrades tier to free', async () => {
    const ctx = await makeApp();
    try {
      const dbHelpers = require('../db/database');
      // сперва поднимем до pro
      await dbHelpers.run('UPDATE users SET subscription_tier = ?, stripe_customer_id = ? WHERE id = ?', ['pro', 'cus_del', ctx.userId]);

      const billing = require('../services/billingService');
      const event = {
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_del', customer: 'cus_del', status: 'canceled' } },
      };
      const result = await billing.handleWebhook(Buffer.from(JSON.stringify(event)), 'sig_test');
      expect(result.tier).toBe('free');
      expect(result.userId).toBe(ctx.userId);

      const user = await dbHelpers.get('SELECT subscription_tier FROM users WHERE id = ?', [ctx.userId]);
      expect(user.subscription_tier).toBe('free');
    } finally {
      await ctx.close();
    }
  });

  test('unknown event type is acknowledged without DB change', async () => {
    const ctx = await makeApp();
    try {
      const billing = require('../services/billingService');
      const event = { type: 'invoice.paid', data: { object: {} } };
      const result = await billing.handleWebhook(Buffer.from(JSON.stringify(event)), 'sig_test');
      expect(result.received).toBe(true);
      expect(result.type).toBe('invoice.paid');
    } finally {
      await ctx.close();
    }
  });

  test('handleWebhook throws BILLING_DISABLED when Stripe not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const ctx = await makeApp();
    try {
      const billing = require('../services/billingService');
      await expect(
        billing.handleWebhook(Buffer.from('{}'), 'sig')
      ).rejects.toMatchObject({ code: 'BILLING_DISABLED', status: 503 });
    } finally {
      await ctx.close();
    }
  });
});
