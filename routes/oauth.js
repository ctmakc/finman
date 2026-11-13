// routes/oauth.js — OAuth 2.1 endpoints and discovery documents for the MCP connector.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server[/mcp] RFC 8414
//   POST /oauth/register                               RFC 7591 dynamic client registration
//   GET  /oauth/authorize                              consent page (public/oauth-authorize.html)
//   GET  /api/oauth/authorize/check                      what the consent page shows
//   POST /api/oauth/authorize/decision                  Allow / Deny (signed-in Finman user, JWT)
//   POST /oauth/token                                  authorization_code (+PKCE) and refresh_token
//   POST /oauth/revoke                                 RFC 7009
'use strict';

const path = require('path');
const express = require('express');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const oauth = require('../services/mcp/oauth');
const tracker = require('../services/tracker');

const router = express.Router();
const limiter = (max) => rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'temporarily_unavailable', error_description: 'Too many requests, try later' } });

const meta = (fn) => (req, res) => { res.set('Cache-Control', 'public, max-age=300'); res.json(fn()); };
router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], meta(oauth.protectedResourceMetadata));
router.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp',
  '/.well-known/openid-configuration', '/.well-known/openid-configuration/mcp'], meta(oauth.authorizationServerMetadata));
// Anything else under /.well-known is a real 404, never the app's HTML.
router.all('/.well-known/*', (req, res) => res.status(404).json({ error: 'not_found' }));

function sendOAuthError(res, e) {
  if (e instanceof oauth.OAuthError) {
    if (e.status === 401) res.set('WWW-Authenticate', 'Basic realm="finman"');
    return res.status(e.status).json({ error: e.error, error_description: e.message });
  }
  console.error('OAuth error:', e);
  return res.status(500).json({ error: 'server_error', error_description: 'Internal error' });
}

const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next(); };

router.post('/oauth/register', limiter(30), noStore, async (req, res) => {
  try {
    const client = await oauth.registerClient(req.body);
    return res.status(201).json(client);
  } catch (e) { return sendOAuthError(res, e); }
});

router.get('/oauth/authorize', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // The page must never be framed: the consent click is the whole security of this step.
  res.set('X-Frame-Options', 'DENY');
  res.sendFile(path.join(__dirname, '..', 'public', 'oauth-authorize.html'));
});

router.get('/api/oauth/authorize/check', limiter(300), noStore, async (req, res) => {
  try {
    const c = await oauth.checkAuthorizeRequest(req.query);
    if (c.fatal) return res.status(400).json({ ok: false, fatal: c.fatal });
    const app = oauth.clientLabel(c.client);
    let host = '';
    try { host = new URL(c.redirect_uri).host; } catch (_) { host = ''; }
    if (!c.ok) {
      return res.json({ ok: false, app, redirect: oauth.withParams(c.redirect_uri, { error: c.error, error_description: c.error_description, state: c.state, iss: oauth.baseUrl() }) });
    }
    return res.json({ ok: true, app, return_host: host });
  } catch (e) { return sendOAuthError(res, e); }
});

const jwtAuth = (req, res, next) => passport.authenticate('jwt', { session: false }, (err, user) => {
  if (err) return next(err);
  if (!user) return res.status(401).json({ error: 'login_required', error_description: 'Sign in to Finman first' });
  req.user = user;
  return next();
})(req, res, next);

router.post('/api/oauth/authorize/decision', limiter(60), noStore, jwtAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const c = await oauth.checkAuthorizeRequest(b.params || {});
    if (c.fatal) return res.status(400).json({ error: 'invalid_request', error_description: c.fatal });
    const iss = oauth.baseUrl();
    if (!c.ok) return res.json({ redirect: oauth.withParams(c.redirect_uri, { error: c.error, error_description: c.error_description, state: c.state, iss }) });
    if (b.approve !== true) return res.json({ redirect: oauth.withParams(c.redirect_uri, { error: 'access_denied', state: c.state, iss }) });
    const code = await oauth.issueCode(req.user.id, c);
    tracker.track('mcp_connect', { userId: req.user.id, props: { app: oauth.clientLabel(c.client) }, req, test: tracker.isTestEmail(req.user.email) });
    return res.json({ redirect: oauth.withParams(c.redirect_uri, { code, state: c.state, iss }) });
  } catch (e) { return sendOAuthError(res, e); }
});

router.post('/oauth/token', limiter(120), noStore, async (req, res) => {
  try {
    return res.json(await oauth.exchange(req));
  } catch (e) { return sendOAuthError(res, e); }
});

router.post('/oauth/revoke', limiter(60), noStore, async (req, res) => {
  try { await oauth.revoke(req); } catch (e) { console.error('OAuth revoke error:', e.message); }
  return res.status(200).json({});
});

// Settings page: apps connected to my account, and "Disconnect".
router.get('/api/mcp/connections', jwtAuth, noStore, async (req, res, next) => {
  try { res.json({ connections: await oauth.listGrants(req.user.id) }); } catch (e) { next(e); }
});
router.delete('/api/mcp/connections/:id', jwtAuth, async (req, res, next) => {
  try {
    const ok = await oauth.revokeGrant(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: true, message: 'Not found' });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
});

module.exports = router;
