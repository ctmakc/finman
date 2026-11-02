// test/regression-billing-tier.test.js — Stripe webhooks wrote whatever string
// was in metadata.tier into users.subscription_tier. Only paid plan tiers from
// PLANS may be applied now; a missing tier still defaults to 'pro'.

jest.mock('stripe', () =>
  jest.fn(() => ({
    webhooks: {
      constructEvent: jest.fn((body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body)),
    },
  }))
);

const { makeApp } = require('./helpers/app');

describe('billing webhook: tier from metadata is validated', () => {
  let ctx;
  let billing;
  let db;
  const event = (type, object) => Buffer.from(JSON.stringify({ type, data: { object } }));
  const tierOf = async (id) => (await db.get('SELECT subscription_tier FROM users WHERE id = ?', [id])).subscription_tier;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_regression_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_regression_dummy';
    ctx = await makeApp();
    billing = require('../services/billingService');
    db = require('../db/database');
  });
  afterAll(async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    if (ctx) await ctx.close();
  });
  beforeEach(async () => {
    await db.run("UPDATE users SET subscription_tier = 'free' WHERE id = ?", [ctx.userId]);
  });

  test.each([['enterprise'], ['free'], ['FAMILY'], ['<script>']])(
    'checkout.session.completed with tier %p leaves the tier unchanged',
    async (tier) => {
      const res = await billing.handleWebhook(
        event('checkout.session.completed', { customer: 'cus_r', subscription: 'sub_r', metadata: { userId: String(ctx.userId), tier } }),
        'sig'
      );
      expect(res).toMatchObject({ received: true, tier: null, ignored: 'unknown_tier' });
      expect(await tierOf(ctx.userId)).toBe('free');
    }
  );

  test('active subscription.updated with an unknown tier is ignored', async () => {
    const res = await billing.handleWebhook(
      event('customer.subscription.updated', { id: 'sub_r', status: 'active', metadata: { userId: String(ctx.userId), tier: 'gold' } }),
      'sig'
    );
    expect(res.ignored).toBe('unknown_tier');
    expect(await tierOf(ctx.userId)).toBe('free');
  });

  test('valid tiers and the missing-tier default still apply', async () => {
    await billing.handleWebhook(event('checkout.session.completed', { metadata: { userId: String(ctx.userId), tier: 'family' } }), 'sig');
    expect(await tierOf(ctx.userId)).toBe('family');
    await billing.handleWebhook(event('checkout.session.completed', { metadata: { userId: String(ctx.userId) } }), 'sig');
    expect(await tierOf(ctx.userId)).toBe('pro');
  });

  test('a non-active subscription still downgrades to free, whatever the tier says', async () => {
    await db.run("UPDATE users SET subscription_tier = 'pro' WHERE id = ?", [ctx.userId]);
    const res = await billing.handleWebhook(
      event('customer.subscription.updated', { id: 'sub_r', status: 'past_due', metadata: { userId: String(ctx.userId), tier: 'gold' } }),
      'sig'
    );
    expect(res.tier).toBe('free');
    expect(await tierOf(ctx.userId)).toBe('free');
  });
});
