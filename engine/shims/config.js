// engine/shims/config.js — replaces config/config.js inside the engine: no dotenv, no
// server secrets, no node crypto. encryptToken / decryptToken are identity with a 'vault:'
// prefix: the whole vault is already AES-GCM encrypted with the user's key, so secrets kept
// in it (the user's own AI keys) need no second, server-held key. A value in the server's
// old format ('iv:tag:ct') cannot be read here and decryptToken throws, like a lost key.
'use strict';

const PREFIX = 'vault:';

function encryptToken(text) {
  if (!text) return null;
  return PREFIX + String(text);
}
function decryptToken(text) {
  if (!text) return null;
  const s = String(text);
  if (s.startsWith(PREFIX)) return s.slice(PREFIX.length);
  throw new Error('decryptToken: value was encrypted by the server and is not readable inside the vault');
}

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '')); }
function buildCorsOrigins() { return []; }

module.exports = {
  port: 0,
  jwtSecret: 'finman-vault-local',
  jwtExpiration: '24h',
  sessionSecret: 'finman-vault-local',
  dbPath: ':vault:',
  environment: 'production',
  defaultCurrency: 'CAD',
  adminEmails: [],
  sessionCookieName: 'finman.sid',
  cookieDomain: undefined,
  apiRateLimits: { windowMs: 15 * 60 * 1000, max: 1000 },
  authRateLimits: { windowMs: 15 * 60 * 1000, max: 5 },
  aiRateLimits: { windowMs: 60 * 1000, max: 10 },
  corsAllowedOrigins: [],
  corsOptions: { origin: [], credentials: true },
  buildCorsOrigins,
  bcryptRounds: 12,
  google: { clientId: '', clientSecret: '', callbackUrl: '', successRedirect: '/' },
  apple: { bundleId: 'money.finman.app', teamId: '', keyId: '', keyPath: '' },
  appScheme: 'money.finman.app',
  isValidEmail,
  encryptToken,
  decryptToken,
  VAULT_TOKEN_PREFIX: PREFIX,
};
