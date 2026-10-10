// test/hardening.test.js — production hardening of server.js / config.js:
// CSP (scriptSrcAttr, self-hosted fonts), trust proxy, CORS list + Capacitor
// shells, rate limiters (1000/15min skipping /api/health, AI 10/min), session
// cookie parity, optional env vars not required.
const { makeApp } = require('./helpers/app');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

describe('hardening: helmet CSP', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.close(); });

  test('script-src-attr allows inline handlers; font/style allow self + data:', async () => {
    const res = await ctx.request.get('/api/health');
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    const directives = Object.fromEntries(
      csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
        const [name, ...vals] = d.split(/\s+/);
        return [name, vals];
      })
    );
    expect(directives['script-src-attr']).toEqual(["'unsafe-inline'"]);
    expect(directives['font-src']).toEqual(expect.arrayContaining(["'self'", 'data:']));
    expect(directives['style-src']).toEqual(expect.arrayContaining(["'self'", 'data:', "'unsafe-inline'"]));
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['img-src']).toEqual(expect.arrayContaining(["'self'", 'data:', 'https:']));
    // no Google Fonts — fonts are self-hosted
    expect(csp).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  test('trust proxy = 1 (behind Caddy/Docker)', () => {
    expect(ctx.app.get('trust proxy')).toBe(1);
  });
});

describe('hardening: CORS', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.close(); });

  test('Capacitor shells are always allowed', async () => {
    for (const origin of ['capacitor://localhost', 'http://localhost']) {
      const res = await ctx.request.get('/api/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    }
  });

  test('unknown origin gets no Access-Control-Allow-Origin', async () => {
    const res = await ctx.request.get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('CORS_ORIGIN is parsed as a comma-separated list', () => {
    const { buildCorsOrigins } = require(path.join(PROJECT_ROOT, 'config', 'config.js'));
    const prod = buildCorsOrigins({
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.finman.money, https://finman.money ,',
    });
    expect(prod).toEqual(expect.arrayContaining([
      'capacitor://localhost', 'http://localhost', 'https://app.finman.money', 'https://finman.money',
    ]));
    expect(prod).not.toContain('http://localhost:3000');
    expect(prod).not.toContain('');
    // prod without CORS_ORIGIN: only the shells
    expect(buildCorsOrigins({ NODE_ENV: 'production' }).sort()).toEqual(['capacitor://localhost', 'http://localhost']);
    // dev without CORS_ORIGIN: + localhost:3000
    expect(buildCorsOrigins({ NODE_ENV: 'development' })).toContain('http://localhost:3000');
  });
});

describe('hardening: rate limits', () => {
  let ctx;
  let config;
  beforeAll(async () => {
    ctx = await makeApp();
    config = require(path.join(PROJECT_ROOT, 'config', 'config.js'));
  });
  afterAll(async () => { await ctx.close(); });

  test('limits: general 1000/15min, auth 5/15min, ai 10/min', () => {
    expect(config.apiRateLimits).toEqual({ windowMs: 15 * 60 * 1000, max: 1000 });
    expect(config.authRateLimits).toEqual({ windowMs: 15 * 60 * 1000, max: 5 });
    expect(config.aiRateLimits).toEqual({ windowMs: 60 * 1000, max: 10 });
  });

  test('GET /api/health is not rate-limited (no RateLimit headers); /api/ready is', async () => {
    const health = await ctx.request.get('/api/health');
    const rlHealth = Object.keys(health.headers).filter((h) => h.toLowerCase().startsWith('ratelimit'));
    expect(rlHealth).toEqual([]);

    const ready = await ctx.request.get('/api/ready');
    const rlReady = Object.keys(ready.headers).filter((h) => h.toLowerCase().startsWith('ratelimit'));
    expect(rlReady.length).toBeGreaterThan(0);
  });

  test('X-Forwarded-For is honoured for the bucket (trust proxy)', async () => {
    const res = await ctx.request.get('/api/ready').set('X-Forwarded-For', '203.0.113.7');
    expect(res.status).toBe(200);
    // a different proxied client has a fresh bucket: remaining = max-1
    const res2 = await ctx.request.get('/api/ready').set('X-Forwarded-For', '203.0.113.8');
    const remaining = res2.headers['ratelimit-remaining'] || (res2.headers['ratelimit'] || '').match(/r=(\d+)/)?.[1];
    expect(Number(remaining)).toBe(config.apiRateLimits.max - 1);
  });

  test('/api/ai gets 429 after 10 requests in a minute', async () => {
    let last = 0;
    for (let i = 0; i < config.aiRateLimits.max + 1; i++) {
      const res = await ctx.request
        .get('/api/ai/__limit_probe')
        .set('X-Forwarded-For', '198.51.100.9')
        .set('Authorization', `Bearer ${ctx.token}`);
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    // other API paths from the same IP are unaffected by the AI bucket
    const other = await ctx.request.get('/api/ready').set('X-Forwarded-For', '198.51.100.9');
    expect(other.status).toBe(200);
  });
});

describe('hardening: session cookie + env', () => {
  test('session cookie parity with prod: finman.sid, path /, domain from COOKIE_DOMAIN', () => {
    jest.resetModules();
    const prev = process.env.COOKIE_DOMAIN;
    process.env.COOKIE_DOMAIN = '.finman.money';
    const cfg = require(path.join(PROJECT_ROOT, 'config', 'config.js'));
    expect(cfg.sessionCookieName).toBe('finman.sid');
    expect(cfg.cookieDomain).toBe('.finman.money');
    if (prev === undefined) delete process.env.COOKIE_DOMAIN; else process.env.COOKIE_DOMAIN = prev;
    jest.resetModules();
    const cfg2 = require(path.join(PROJECT_ROOT, 'config', 'config.js'));
    expect(cfg2.cookieDomain).toBeUndefined();
  });

  test('server.js wires the session with name/path/expires:false', () => {
    const src = require('fs').readFileSync(path.join(PROJECT_ROOT, 'server.js'), 'utf8');
    const block = src.slice(src.indexOf('app.use(session('), src.indexOf('}));', src.indexOf('app.use(session(')));
    expect(block).toMatch(/name:\s*config\.sessionCookieName/);
    expect(block).toMatch(/path:\s*'\/'/);
    expect(block).toMatch(/domain:\s*config\.cookieDomain/);
    expect(block).toMatch(/expires:\s*false/);
    expect(block).toMatch(/httpOnly:\s*true/);
  });

  test('prod-only env vars are optional: validateEnv passes with just the 3 secrets', () => {
    const { validateEnv, REQUIRED_SECRETS, OPTIONAL_ENV } = require(path.join(PROJECT_ROOT, 'lib', 'validateEnv.js'));
    expect(REQUIRED_SECRETS).toEqual(['JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY']);
    for (const v of OPTIONAL_ENV) expect(REQUIRED_SECRETS).not.toContain(v);
    const res = validateEnv({ NODE_ENV: 'production', JWT_SECRET: 'a', SESSION_SECRET: 'b', ENCRYPTION_KEY: 'c' });
    expect(res.ok).toBe(true);
    // and every var documented in .env.example is either required or listed optional
    const example = require('fs').readFileSync(path.join(PROJECT_ROOT, '.env.example'), 'utf8');
    const documented = [...example.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
    for (const v of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL', 'GOOGLE_SUCCESS_REDIRECT',
      'GOOGLE_API_KEY', 'GEMINI_REFRESH_TOKEN', 'GEMINI_OAUTH_CREDS', 'GEMINI_CLIENT_ID', 'GEMINI_CLIENT_SECRET',
      'AI_MAX_TOKENS', 'LEAD_NOTIFY_TO', 'LEAD_NOTIFY_FROM', 'GA4_MEASUREMENT_ID', 'GA4_API_SECRET', 'COOKIE_DOMAIN']) {
      expect(documented).toContain(v);
      expect(OPTIONAL_ENV).toContain(v);
    }
  });
});
