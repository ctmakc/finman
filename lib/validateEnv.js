// lib/validateEnv.js — проверка обязательных секретов окружения.
// В production отсутствие любого из них -> бросаем ошибку (fail-fast).
// В development/test -> печатаем предупреждение и продолжаем.

const logger = require('./logger');

const REQUIRED_SECRETS = ['JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY'];

function validateEnv(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const missing = REQUIRED_SECRETS.filter((key) => !env[key] || String(env[key]).trim() === '');

  if (missing.length === 0) {
    return { ok: true, missing: [] };
  }

  if (isProd) {
    const msg = `Missing required environment variables in production: ${missing.join(', ')}`;
    logger.error(msg);
    throw new Error(msg);
  }

  logger.warn(
    `Missing environment variables (using auto-generated/dev defaults): ${missing.join(', ')}. ` +
      'Set them in .env before deploying to production.'
  );
  return { ok: false, missing };
}

module.exports = validateEnv;
module.exports.validateEnv = validateEnv;
module.exports.REQUIRED_SECRETS = REQUIRED_SECRETS;
