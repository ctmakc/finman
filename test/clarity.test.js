// test/clarity.test.js — Microsoft Clarity wiring (owner's word 23.11).
//   - /api/t/config gives the Clarity id only when CLARITY_PROJECT_ID is a valid id;
//   - CSP lets the Clarity tag/script load and keeps connect-src https: (vault AI + Clarity + review kit);
//   - the app shell masks everything for Clarity (data-clarity-mask on <body>).
const { makeApp } = require('./helpers/app');

let ctx;
beforeAll(async () => { ctx = await makeApp(); });
afterAll(async () => { delete process.env.CLARITY_PROJECT_ID; await ctx.close(); });

test('config: clarity id only when set and well-formed', async () => {
  delete process.env.CLARITY_PROJECT_ID;
  let r = await ctx.request.get('/api/t/config');
  expect(r.body.clarity).toBeNull();
  process.env.CLARITY_PROJECT_ID = 'bad id"><script>';
  r = await ctx.request.get('/api/t/config');
  expect(r.body.clarity).toBeNull();
  process.env.CLARITY_PROJECT_ID = 'abc123xyz9';
  r = await ctx.request.get('/api/t/config');
  expect(r.body.clarity).toEqual({ id: 'abc123xyz9' });
});

test('CSP allows Clarity and keeps connect-src https:', async () => {
  const r = await ctx.request.get('/api/health');
  const csp = r.headers['content-security-policy'] || '';
  expect(csp).toMatch(/script-src[^;]*https:\/\/www\.clarity\.ms/);
  expect(csp).toMatch(/script-src[^;]*https:\/\/scripts\.clarity\.ms/);
  expect(csp).toMatch(/connect-src 'self' https:/);
});

test('app shell masks everything for Clarity', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  expect(html).toMatch(/<body data-clarity-mask="true">/);
});
