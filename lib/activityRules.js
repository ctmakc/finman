// lib/activityRules.js — which journal event a write request means.
// Shared by middleware/activity.js (server, open-data users) and the vault
// engine (browser, encrypted users: public/js/vault/vault.js reports the same
// event names through POST /api/t/me). Only the route and the outcome count;
// request bodies (amounts, names, notes) never do.
'use strict';

const VERB = { POST: 'created', PUT: 'updated', PATCH: 'updated', DELETE: 'deleted' };
const SKIP = /^\/api\/(auth|t|billing\/webhook|health|sync\/run|engagement|vault)(\/|$)/;
// /api/vault: PUT /blob fires after every write (debounced 1.5 s) — routes/vault.js
// records one vault_sync per user per day instead.

// [regex on path (no query), method or '*', event name or fn(match, ok)]
const RULES = [
  [/^\/api\/transactions\/?$/, 'POST', 'transaction_added'],
  [/^\/api\/transactions\/transfer$/, 'POST', 'transfer_added'],
  [/^\/api\/transactions\/import$/, 'POST', (ok) => (ok ? 'import_done' : 'import_failed')],
  [/^\/api\/bank-api\/import\/preview$/, 'POST', (ok) => (ok ? 'import_preview' : 'import_failed')],
  [/^\/api\/bank-api\/import\/commit$/, 'POST', (ok) => (ok ? 'import_done' : 'import_failed')],
  [/^\/api\/bank-api\/connect/, 'POST', 'bank_connect'],
  [/^\/api\/ai\//, 'POST', 'ai_used'],
  [/^\/api\/onboarding\/quickstart$/, 'POST', 'onboarding_quickstart'],
  [/^\/api\/onboarding\/complete-step$/, 'POST', 'onboarding_step'],
  [/^\/api\/onboarding\/demo$/, 'POST', 'demo_loaded'],
  [/^\/api\/onboarding\/demo$/, 'DELETE', 'demo_removed'],
  [/^\/api\/billing\/checkout$/, 'POST', 'checkout_started'],
  [/^\/api\/receipts/, 'POST', 'receipt_scanned'],
  [/^\/api\/invoices\/preview$/, 'POST', () => null],
  [/^\/api\/feedback(\/|$)/, '*', () => null], // routes/feedback.js tracks feedback_sent itself
  [/^\/api\/invoices\/profiles\/\d+\/share$/, 'POST', 'invoice_template_shared'],
  [/^\/api\/invoices\/profiles\/?$/, 'POST', 'invoice_template_created'],
  [/^\/api\/invoices\/profiles\/\d+$/, 'PUT', 'invoice_template_updated'],
  [/^\/api\/invoices\/profiles\/\d+$/, 'DELETE', 'invoice_template_deleted'],
  [/^\/api\/invoices\/shared\/[^/]+\/import$/, 'POST', 'invoice_template_imported'],
  [/^\/api\/invoices\/\d+\/status$/, 'POST', 'invoice_status_changed'],
  [/^\/api\/invoices\/\d+\/duplicate$/, 'POST', 'invoice_duplicated'],
];

function eventFor(method, path, ok) {
  if (!VERB[method]) return null;
  for (const [re, m, ev] of RULES) {
    if ((m === '*' || m === method) && re.test(path)) return typeof ev === 'function' ? ev(ok) : (ok ? ev : null);
  }
  if (!ok) return null;
  const area = (path.split('/')[2] || '').replace(/[^a-z0-9]+/gi, '_').replace(/s$/, '');
  if (!area) return null;
  return `${area}_${VERB[method] || 'action'}`;
}

// Every event name eventFor() can return for a write (literal rules + the
// generic <area>_<verb>). POST /api/t/me accepts only these from the browser.
const LITERAL_EVENTS = new Set(['import_failed', 'import_done', 'import_preview']);
for (const [, , ev] of RULES) if (typeof ev === 'string') LITERAL_EVENTS.add(ev);
const GENERIC_EVENT = /^[a-z][a-z0-9_]{1,30}_(created|updated|deleted|action)$/;
function isActivityEvent(name) { return LITERAL_EVENTS.has(name) || GENERIC_EVENT.test(String(name || '')); }

module.exports = { VERB, SKIP, RULES, eventFor, isActivityEvent };
