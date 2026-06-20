// test/foundation.test.js — проверка shared-инфраструктуры Foundation.
const { makeApp } = require('./helpers/app');
const money = require('../lib/money');

describe('lib/money', () => {
  test('round устойчив к float-дрейфу (0.1 + 0.2 === 0.3)', () => {
    expect(money.add(0.1, 0.2)).toBe(0.3);
    expect(money.round(0.1 + 0.2)).toBe(0.3);
  });

  test('add / sub / mul / div / sum округляют до 2 знаков', () => {
    expect(money.add(1.005, 2.005)).toBe(3.01);
    expect(money.sub(0.3, 0.1)).toBe(0.2);
    expect(money.mul(1.1, 1.1)).toBe(1.21);
    expect(money.div(1, 3)).toBe(0.33);
    expect(money.div(1, 0)).toBe(0);
    expect(money.sum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(money.sum('not-array')).toBe(0);
  });
});

describe('foundation HTTP', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await makeApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /api/health -> 200 + status ok', async () => {
    const res = await ctx.request.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(typeof res.body.data.uptime).toBe('number');
    expect(res.body.data.version).toBeDefined();
  });

  test('GET /api/ready -> 200 (db reachable)', async () => {
    const res = await ctx.request.get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ready');
  });

  test('requireTier блокирует free-пользователя на pro-роуте (/api/ai) -> 402', async () => {
    const res = await ctx.request
      .get('/api/ai/anything')
      .set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
  });

  test('pro-роут без токена -> 401', async () => {
    const res = await ctx.request.get('/api/ai/anything');
    expect(res.status).toBe(401);
  });

  test('неизвестный /api роут -> notFound + errorHandler формат', async () => {
    const res = await ctx.request.get('/api/this-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(typeof res.body.error.message).toBe('string');
  });

  test('не-/api путь отдаёт SPA (index.html), не 404 JSON', async () => {
    const res = await ctx.request.get('/some/spa/route');
    // index.html отдаётся как html-страница
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});

describe('middleware/error AppError formatting (unit)', () => {
  const express = require('express');
  const request = require('supertest');
  const { AppError, errorHandler, notFound } = require('../middleware/error');

  function buildApp(routeFn) {
    const app = express();
    app.get('/boom', routeFn);
    app.use(notFound);
    app.use(errorHandler);
    return app;
  }

  test('AppError форматируется как {success:false,error:{code,message}}', async () => {
    const app = buildApp((req, res, next) => {
      next(new AppError(403, 'FORBIDDEN', 'nope'));
    });
    const res = await request(app).get('/boom');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'nope' },
    });
  });

  test('неизвестная ошибка -> 500 INTERNAL_ERROR', async () => {
    const app = buildApp(() => {
      throw new Error('kaboom');
    });
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  test('notFound отдаёт 404 NOT_FOUND', async () => {
    const app = buildApp((req, res) => res.json({ ok: true }));
    const res = await request(app).get('/missing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
