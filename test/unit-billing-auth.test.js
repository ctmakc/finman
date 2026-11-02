// test/unit-billing-auth.test.js — plan catalog and limits (billingService
// PLANS), the tier gate, the ownership gate, JWT rejection paths and Stripe
// checkout amounts. Stripe is mocked; no network, no real keys.

jest.mock('stripe', () => {
  const state = { lastCheckout: null };
  const factory = jest.fn(() => ({
    customers: {
      create: jest.fn(async ({ metadata } = {}) => ({ id: `cus_unit_${metadata && metadata.userId}` })),
    },
    checkout: {
      sessions: {
        create: jest.fn(async (args) => {
          state.lastCheckout = args;
          return { id: 'cs_unit', url: 'https://checkout.stripe.test/cs_unit' };
        }),
      },
    },
    webhooks: {
      constructEvent: jest.fn((body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body)),
    },
  }));
  factory.__state = state;
  return factory;
});

const { makeApp } = require('./helpers/app');

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

// Runs an Express-style middleware and resolves with what it passed to next().
function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    mw(req, {}, (err) => resolve(err || null));
  });
}

describe('billingService PLANS — catalog is stable', () => {
  const billing = require('../services/billingService');

  test('exactly free / pro / family, with their current prices and limits', () => {
    const plans = billing.getPlans();
    expect(plans.map((p) => [p.id, p.tier, p.price, p.currency, p.interval])).toEqual([
      ['free', 'free', 0, 'usd', 'month'],
      ['pro', 'pro', 9, 'usd', 'month'],
      ['family', 'family', 19, 'usd', 'month'],
    ]);
    const family = plans.find((p) => p.id === 'family');
    expect(family.features).toContain('Up to 5 members');
    for (const p of plans) {
      expect(Array.isArray(p.features)).toBe(true);
      expect(p.features.length).toBeGreaterThan(0);
    }
  });

  test('prices are whole currency units that convert to integer cents', () => {
    for (const p of billing.getPlans()) {
      expect(Number.isInteger(Math.round(p.price * 100))).toBe(true);
      expect(p.price).toBeGreaterThanOrEqual(0);
    }
  });

  test('getPlan resolves by id or tier and hands out copies', () => {
    expect(billing.getPlan('pro').price).toBe(9);
    expect(billing.getPlan('nope')).toBeNull();
    expect(billing.getPlan(undefined)).toBeNull();
    const p = billing.getPlan('family');
    p.price = 0;
    p.features.push('free lunch');
    expect(billing.getPlan('family').price).toBe(19);
    expect(billing.getPlan('family').features).not.toContain('free lunch');
  });

  test('tier order in requireTier matches the plan catalog', () => {
    const { TIER_ORDER } = require('../middleware/requireTier');
    const tiers = billing.getPlans().map((p) => p.tier);
    expect(Object.keys(TIER_ORDER).sort()).toEqual([...tiers].sort());
    expect(TIER_ORDER.free).toBeLessThan(TIER_ORDER.pro);
    expect(TIER_ORDER.pro).toBeLessThan(TIER_ORDER.family);
  });
});

describe('requireTier middleware', () => {
  const { requireTier } = require('../middleware/requireTier');

  test('unknown minimum tier is a programming error', () => {
    expect(() => requireTier('platinum')).toThrow(/unknown tier/);
  });

  test.each([
    ['free', 'pro', 402],
    ['pro', 'pro', null],
    ['family', 'pro', null],
    ['pro', 'family', 402],
    ['family', 'family', null],
    ['free', 'free', null],
    ['enterprise', 'pro', 402], // unknown tier ranks as free
  ])('user tier %s vs required %s -> %p', async (userTier, minTier, expected) => {
    const err = await runMiddleware(requireTier(minTier), { user: { id: 1, subscription_tier: userTier } });
    if (expected === null) expect(err).toBeNull();
    else expect(err).toMatchObject({ status: expected, code: 'PAYMENT_REQUIRED' });
  });

  test('no user -> 401', async () => {
    expect(await runMiddleware(requireTier('pro'), {})).toMatchObject({ status: 401 });
    expect(await runMiddleware(requireTier('pro'), { user: {} })).toMatchObject({ status: 401 });
  });
});

describe('requireOwnership middleware', () => {
  const { requireOwnership } = require('../middleware/authorize');

  test('requires a loader function', () => {
    expect(() => requireOwnership()).toThrow();
  });

  test('401 without user, 404 when missing, 403 for someone else, pass for the owner', async () => {
    const mw = requireOwnership(async (req) => (req.params.id === '1' ? { id: 1, user_id: 7 } : null));
    expect(await runMiddleware(mw, { params: { id: '1' } })).toMatchObject({ status: 401 });
    expect(await runMiddleware(mw, { user: { id: 7 }, params: { id: '2' } })).toMatchObject({ status: 404 });
    expect(await runMiddleware(mw, { user: { id: 8 }, params: { id: '1' } })).toMatchObject({ status: 403 });
    const req = { user: { id: '7' }, params: { id: '1' } }; // id type differs: still the owner
    expect(await runMiddleware(mw, req)).toBeNull();
    expect(req.resource).toEqual({ id: 1, user_id: 7 });
  });

  test('a loader failure is forwarded, not swallowed', async () => {
    const boom = new Error('db down');
    const mw = requireOwnership(async () => {
      throw boom;
    });
    expect(await runMiddleware(mw, { user: { id: 1 }, params: {} })).toBe(boom);
  });
});

describe('JWT authentication — rejection paths', () => {
  let ctx;
  let jwt;
  let config;
  beforeAll(async () => {
    ctx = await makeApp();
    jwt = require('jsonwebtoken');
    config = require('../config/config');
  });
  afterAll(async () => ctx && ctx.close());

  const probe = (headers = {}) => ctx.request.get('/api/accounts').set(headers);

  test('valid token works', async () => {
    expect((await probe(AUTH(ctx.token))).status).toBe(200);
  });

  test('missing, malformed, foreign-secret, expired, alg=none and deleted-user tokens are 401', async () => {
    expect((await probe()).status).toBe(401);
    expect((await probe({ Authorization: 'Bearer not.a.jwt' })).status).toBe(401);
    expect((await probe({ Authorization: ctx.token })).status).toBe(401); // no Bearer prefix
    expect((await probe(AUTH(jwt.sign({ id: ctx.userId }, 'some-other-secret')))).status).toBe(401);
    expect((await probe(AUTH(jwt.sign({ id: ctx.userId }, config.jwtSecret, { expiresIn: -10 })))).status).toBe(401);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: ctx.userId })).toString('base64url');
    expect((await probe(AUTH(`${header}.${payload}.`))).status).toBe(401);
    expect((await probe(AUTH(jwt.sign({ id: 999999 }, config.jwtSecret)))).status).toBe(401);
  });

  test('a token issued before a token_version bump is revoked', async () => {
    const db = require('../db/database');
    const old = jwt.sign({ id: ctx.userId, tv: 0 }, config.jwtSecret);
    expect((await probe(AUTH(old))).status).toBe(200);
    await db.run('UPDATE users SET token_version = 1 WHERE id = ?', [ctx.userId]);
    expect((await probe(AUTH(old))).status).toBe(401);
    expect((await probe(AUTH(jwt.sign({ id: ctx.userId, tv: 1 }, config.jwtSecret)))).status).toBe(200);
    await db.run('UPDATE users SET token_version = 0 WHERE id = ?', [ctx.userId]);
  });
});

describe('Stripe checkout amounts (Stripe mocked)', () => {
  let ctx;
  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit_dummy';
    ctx = await makeApp();
  });
  afterAll(async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_PRO;
    if (ctx) await ctx.close();
  });

  test.each([
    ['pro', 900],
    ['family', 1900],
  ])('%s checkout charges %p cents per month in usd', async (plan, cents) => {
    delete process.env.STRIPE_PRICE_PRO;
    const res = await ctx.request.post('/api/billing/checkout').set(AUTH(ctx.token)).send({ plan });
    expect(res.status).toBeLessThan(300);
    const args = require('stripe').__state.lastCheckout;
    expect(args.mode).toBe('subscription');
    expect(args.line_items).toEqual([
      expect.objectContaining({
        quantity: 1,
        price_data: expect.objectContaining({ currency: 'usd', unit_amount: cents, recurring: { interval: 'month' } }),
      }),
    ]);
    expect(args.metadata).toEqual({ userId: String(ctx.userId), tier: plan });
  });

  test('a configured Stripe Price ID wins over inline price data', async () => {
    process.env.STRIPE_PRICE_PRO = 'price_unit_pro';
    const res = await ctx.request.post('/api/billing/checkout').set(AUTH(ctx.token)).send({ plan: 'pro' });
    expect(res.status).toBeLessThan(300);
    expect(require('stripe').__state.lastCheckout.line_items).toEqual([{ price: 'price_unit_pro', quantity: 1 }]);
  });

  test('free and unknown plans cannot be checked out', async () => {
    const billing = require('../services/billingService');
    await expect(billing.createCheckoutSession(ctx.userId, 'free')).rejects.toMatchObject({ status: 400, code: 'INVALID_PLAN' });
    await expect(billing.createCheckoutSession(ctx.userId, 'platinum')).rejects.toMatchObject({ status: 400, code: 'INVALID_PLAN' });
  });
});
