// Unit tests for middleware/authorize, requireTier, patAuth and error handling.
// No DB, no network: db/database and patService are mocked.
'use strict';

jest.mock('../db/database', () => ({ get: jest.fn() }));
jest.mock('../services/patService', () => ({ verify: jest.fn() }));

const db = require('../db/database');
const patService = require('../services/patService');
const { requireOwnership } = require('../middleware/authorize');
const { requireTier, TIER_ORDER } = require('../middleware/requireTier');
const patAuth = require('../middleware/patAuth');
const { AppError, errorHandler, notFound } = require('../middleware/error');

function fakeRes() {
  return {
    statusCode: null,
    body: undefined,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}

// Runs a middleware and resolves with whatever it passed to next() (or undefined).
async function run(mw, req, res = fakeRes()) {
  let nextArg = 'NOT_CALLED';
  await mw(req, res, (arg) => { nextArg = arg; });
  return { nextArg, res };
}

beforeEach(() => {
  db.get.mockReset();
  patService.verify.mockReset();
});

describe('requireOwnership', () => {
  test('throws at construction without a loader', () => {
    expect(() => requireOwnership()).toThrow(/loadResource/);
  });

  test('401 without an authenticated user, loader not called', async () => {
    const loader = jest.fn();
    const { nextArg } = await run(requireOwnership(loader), {});
    expect(nextArg).toBeInstanceOf(AppError);
    expect(nextArg.status).toBe(401);
    expect(loader).not.toHaveBeenCalled();
  });

  test('404 when the resource does not exist', async () => {
    const { nextArg } = await run(requireOwnership(async () => null), { user: { id: 1 } });
    expect(nextArg.status).toBe(404);
    expect(nextArg.code).toBe('NOT_FOUND');
  });

  test('403 for another user\'s resource', async () => {
    const { nextArg } = await run(requireOwnership(async () => ({ user_id: 2 })), { user: { id: 1 } });
    expect(nextArg.status).toBe(403);
    expect(nextArg.code).toBe('FORBIDDEN');
  });

  test('owner passes (string vs number id) and resource is attached to req', async () => {
    const resource = { id: 9, user_id: '7' };
    const req = { user: { id: 7 } };
    const { nextArg } = await run(requireOwnership(async () => resource), req);
    expect(nextArg).toBeUndefined();
    expect(req.resource).toBe(resource);
  });

  test('loader errors are forwarded to next', async () => {
    const boom = new Error('db down');
    const { nextArg } = await run(requireOwnership(async () => { throw boom; }), { user: { id: 1 } });
    expect(nextArg).toBe(boom);
  });
});

describe('requireTier', () => {
  test('tier order is free < pro < family', () => {
    expect(TIER_ORDER.free).toBeLessThan(TIER_ORDER.pro);
    expect(TIER_ORDER.pro).toBeLessThan(TIER_ORDER.family);
  });

  test('unknown tier name is rejected at construction', () => {
    expect(() => requireTier('gold')).toThrow(/unknown tier/);
  });

  test('401 without user', async () => {
    const { nextArg } = await run(requireTier('pro'), {});
    expect(nextArg.status).toBe(401);
  });

  test.each([
    ['free', 'free', true],
    ['free', 'pro', false],
    ['pro', 'pro', true],
    ['family', 'pro', true],
    ['pro', 'family', false],
    ['platinum', 'pro', false], // unknown tier on the user ranks as free
  ])('user tier %s vs required %s -> allowed=%s', async (userTier, minTier, allowed) => {
    const { nextArg } = await run(requireTier(minTier), { user: { id: 1, subscription_tier: userTier } });
    if (allowed) {
      expect(nextArg).toBeUndefined();
    } else {
      expect(nextArg.status).toBe(402);
      expect(nextArg.code).toBe('PAYMENT_REQUIRED');
    }
    expect(db.get).not.toHaveBeenCalled();
  });

  test('missing tier on req.user is loaded from DB once and cached on req.user', async () => {
    db.get.mockResolvedValue({ subscription_tier: 'family' });
    const req = { user: { id: 5 } };
    const { nextArg } = await run(requireTier('family'), req);
    expect(nextArg).toBeUndefined();
    expect(db.get).toHaveBeenCalledWith(expect.stringMatching(/subscription_tier/), [5]);
    expect(req.user.subscription_tier).toBe('family');
  });

  test('DB failure degrades to free (402 for pro, pass for free)', async () => {
    db.get.mockRejectedValue(new Error('no such column'));
    expect((await run(requireTier('pro'), { user: { id: 5 } })).nextArg.status).toBe(402);
    expect((await run(requireTier('free'), { user: { id: 5 } })).nextArg).toBeUndefined();
  });
});

describe('patAuth', () => {
  test('no Authorization header -> 401 NO_TOKEN, verify not called', async () => {
    const { nextArg, res } = await run(patAuth, { headers: {} });
    expect(nextArg).toBe('NOT_CALLED');
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('NO_TOKEN');
    expect(patService.verify).not.toHaveBeenCalled();
  });

  test('non-Bearer scheme -> 401 NO_TOKEN', async () => {
    const { res } = await run(patAuth, { headers: { authorization: 'Basic abc' } });
    expect(res.body.error.code).toBe('NO_TOKEN');
  });

  test('invalid token -> 401 INVALID_TOKEN', async () => {
    patService.verify.mockResolvedValue(null);
    const { res } = await run(patAuth, { headers: { authorization: 'Bearer finman_pat_x' } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: { code: 'INVALID_TOKEN', message: expect.any(String) } });
  });

  test('valid token (case-insensitive scheme, extra spaces) sets req.user', async () => {
    patService.verify.mockResolvedValue(42);
    const req = { headers: { authorization: 'bearer   finman_pat_abc  ' } };
    const { nextArg } = await run(patAuth, req);
    expect(patService.verify).toHaveBeenCalledWith('finman_pat_abc');
    expect(nextArg).toBeUndefined();
    expect(req.user).toEqual({ id: 42 });
  });

  test('userId 0 is still a valid user (only null/undefined rejects)', async () => {
    patService.verify.mockResolvedValue(0);
    const req = { headers: { authorization: 'Bearer t' } };
    const { nextArg } = await run(patAuth, req);
    expect(nextArg).toBeUndefined();
    expect(req.user).toEqual({ id: 0 });
  });

  test('verify errors go to next()', async () => {
    const boom = new Error('x');
    patService.verify.mockRejectedValue(boom);
    const { nextArg } = await run(patAuth, { headers: { authorization: 'Bearer t' } });
    expect(nextArg).toBe(boom);
  });
});

describe('error middleware', () => {
  const origEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = origEnv; });

  test('AppError defaults', () => {
    const e = new AppError();
    expect(e.status).toBe(500);
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e.isOperational).toBe(true);
    expect(e).toBeInstanceOf(Error);
  });

  test('notFound produces a 404 AppError naming the route', () => {
    let err;
    notFound({ method: 'GET', originalUrl: '/api/nope' }, {}, (e) => { err = e; });
    expect(err.status).toBe(404);
    expect(err.message).toBe('Route not found: GET /api/nope');
  });

  test('AppError is rendered with its status/code', () => {
    const res = fakeRes();
    errorHandler(new AppError(409, 'CONFLICT', 'dup'), {}, res, () => {});
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: { code: 'CONFLICT', message: 'dup' } });
  });

  test('JSON body parse failure -> 400 INVALID_JSON', () => {
    const res = fakeRes();
    errorHandler({ type: 'entity.parse.failed', message: 'Unexpected token' }, {}, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  test('unknown error hides its message in production only', () => {
    process.env.NODE_ENV = 'production';
    let res = fakeRes();
    errorHandler(new Error('secret sql detail'), {}, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body.error.message).toBe('Internal Server Error');

    process.env.NODE_ENV = 'test';
    res = fakeRes();
    errorHandler(new Error('secret sql detail'), {}, res, () => {});
    expect(res.body.error.message).toBe('secret sql detail');
  });

  test('delegates to next when headers were already sent', () => {
    const res = fakeRes();
    res.headersSent = true;
    const err = new Error('late');
    let passed;
    errorHandler(err, {}, res, (e) => { passed = e; });
    expect(passed).toBe(err);
    expect(res.statusCode).toBeNull();
  });
});
