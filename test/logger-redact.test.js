// test/logger-redact.test.js — pino redaction: Authorization / Cookie / Set-Cookie
// and password/token fields never reach the log stream.
const express = require('express');
const pinoHttp = require('pino-http');
const supertest = require('supertest');
const { createLogger, REDACT_PATHS } = require('../lib/logger');

function captureLogger() {
  const chunks = [];
  const logger = createLogger({ level: 'info', stream: { write: (s) => chunks.push(String(s)) } });
  return { logger, text: () => chunks.join('') };
}

describe('logger redaction', () => {
  test('REDACT_PATHS covers the sensitive headers and body fields', () => {
    expect(REDACT_PATHS).toEqual(expect.arrayContaining([
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'req.body.password',
      'req.body.token',
    ]));
  });

  test('a request with a Bearer token and cookie is logged without them', async () => {
    const { logger, text } = captureLogger();
    const app = express();
    app.use(pinoHttp({ logger }));
    app.get('/x', (req, res) => {
      res.cookie('finman.sid', 'SESSION_SECRET_VALUE', { httpOnly: true });
      res.json({ ok: true });
    });

    const res = await supertest(app)
      .get('/x')
      .set('Authorization', 'Bearer SUPER_SECRET_JWT_abc123')
      .set('Cookie', 'finman.sid=COOKIE_SECRET_VALUE');
    expect(res.status).toBe(200);

    const out = text();
    expect(out).toContain('"url":"/x"');
    expect(out).not.toContain('SUPER_SECRET_JWT_abc123');
    expect(out).not.toContain('COOKIE_SECRET_VALUE');
    expect(out).not.toContain('SESSION_SECRET_VALUE');
    expect(out).toContain('"authorization":"[Redacted]"');
    expect(out).toContain('"cookie":"[Redacted]"');
    expect(out).toContain('"set-cookie":"[Redacted]"');
  });

  test('password/token fields in logged objects are redacted', () => {
    const { logger, text } = captureLogger();
    logger.info({ body: { email: 'a@b.c', password: 'hunter2', token: 'tok_123' } }, 'login');
    logger.info({ req: { body: { password: 'hunter3' } } }, 'req');
    logger.info({ password: 'hunter4', token: 'tok_456', user: { token: 'tok_789' } }, 'flat');
    const out = text();
    for (const secret of ['hunter2', 'hunter3', 'hunter4', 'tok_123', 'tok_456', 'tok_789']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('a@b.c');
  });
});
