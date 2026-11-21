// engine/routes.js — which /api requests the vault engine serves in the browser, and which
// still go to the server. Mount paths mirror server.js exactly (same order, same routers).
//
// REMOTE wins over LOCAL. Anything under /api that matches neither goes to the server.
'use strict';

// [mount path, require() of the router] — bundled; same modules server.js mounts.
const MOUNTS = [
  ['/api/accounts', () => require('../routes/accounts')],
  ['/api/transactions', () => require('../routes/transactions')],
  ['/api/bank-api', () => require('../routes/bank-api')],
  ['/api/budgets', () => require('../routes/budgets')],
  ['/api/family', () => require('../routes/family')],
  ['/api/recurring', () => require('../routes/recurring')],
  ['/api/currency', () => require('../routes/currency')],
  ['/api/goals', () => require('../routes/goals')],
  ['/api/debts', () => require('../routes/debts')],
  ['/api/split', () => require('../routes/split')],
  ['/api/notifications', () => require('../routes/notifications')],
  ['/api/investments', () => require('../routes/investments')],
  ['/api/analytics', () => require('../routes/analytics')],
  ['/api/export', () => require('../routes/export')],
  ['/api/subscriptions', () => require('../routes/subscriptions')],
  ['/api/networth', () => require('../routes/networth')],
  ['/api/receipts', () => require('../routes/receipts')],
  ['/api/reports', () => require('../routes/reports')],
  ['/api/calendar', () => require('../routes/calendar')],
  ['/api/widgets', () => require('../routes/widgets')],
  ['/api/forecast', () => require('../routes/forecast')],
  // «Свой ИИ» before the operator AI router, like server.js. No tier gate in the vault:
  // every AI call runs on the user's own key.
  ['/api/ai/my', () => require('../routes/userAi')],
  ['/api/ai', () => require('../routes/ai')],
  ['/api/sync', () => require('../routes/sync')],
  ['/api/anomalies', () => require('../routes/anomalies')],
  ['/api/onboarding', () => require('../routes/onboarding')],
  ['/api/engagement', () => require('../routes/engagement')],
  ['/api/rules', () => require('../routes/rules')],
  ['/api/reconcile', () => require('../routes/reconcile')],
];

const LOCAL_PREFIXES = MOUNTS.map(([p]) => p);

// [method or '*', regex on the path without query] — served by the server even though the
// prefix is local: global data (currency rates), the server's own state (push, referral,
// analytics events).
const REMOTE_RULES = [
  ['*', /^\/api\/currency\/(rates|rate\/[^/]+\/[^/]+|convert|history\/[^/]+\/[^/]+|fetch-nbu)\/?$/],
  ['POST', /^\/api\/currency\/rate\/?$/],
  ['*', /^\/api\/engagement\/(push|referral|event)(\/|$)/],
];

// Server-only prefixes (never local), listed for the record and for isLocal's fast path.
const REMOTE_PREFIXES = [
  '/api/auth', '/api/billing', '/api/t', '/api/health', '/api/ready', '/api/protected',
  '/api/vault', '/api/v1', '/api/invoices', '/oauth', '/mcp', '/.well-known', '/op',
];

// Requests answered by the engine itself without running a router: live bank API
// connections cannot work while the server cannot read the data.
const VAULT_UNAVAILABLE = [
  ['POST', /^\/api\/bank-api\/(connect|connect-custom)\/[^/]+(\/direct)?\/?$/],
  ['POST', /^\/api\/bank-api\/(sync-accounts|sync-transactions)\/[^/]+\/?$/],
];

function pathOf(url) {
  let p = String(url || '');
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  if (/^[a-z]+:\/\//i.test(p)) { try { p = new URL(p).pathname; } catch (_) { /* keep */ } }
  return p.replace(/\/{2,}/g, '/');
}

const under = (path, prefix) => path === prefix || path.startsWith(prefix + '/');

function isLocal(method, url) {
  const m = String(method || 'GET').toUpperCase();
  const path = pathOf(url);
  if (!path.startsWith('/api/')) return false;
  if (REMOTE_PREFIXES.some((p) => under(path, p))) return false;
  if (REMOTE_RULES.some(([rm, re]) => (rm === '*' || rm === m) && re.test(path))) return false;
  return LOCAL_PREFIXES.some((p) => under(path, p));
}

function vaultUnavailable(method, url) {
  const m = String(method || 'GET').toUpperCase();
  const path = pathOf(url);
  return VAULT_UNAVAILABLE.some(([rm, re]) => rm === m && re.test(path));
}

module.exports = { MOUNTS, LOCAL_PREFIXES, REMOTE_PREFIXES, REMOTE_RULES, VAULT_UNAVAILABLE, isLocal, vaultUnavailable, pathOf };
