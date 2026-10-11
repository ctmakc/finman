// lib/validateEnv.js — проверка обязательных секретов окружения.
// В production отсутствие любого из них -> бросаем ошибку (fail-fast).
// В development/test -> печатаем предупреждение и продолжаем.

const logger = require('./logger');

const REQUIRED_SECRETS = ['JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY'];

// Всё остальное из .env.example — ОПЦИОНАЛЬНО и здесь не проверяется: фичи
// сами деградируют (AI -> 503, Google-вход -> enabled:false, письма -> no-op).
// Список для документации/тестов, чтобы никто случайно не сделал их обязательными.
const OPTIONAL_ENV = [
  'CORS_ORIGIN', 'COOKIE_DOMAIN', 'APP_URL', 'LOG_LEVEL',
  'AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'AI_MAX_TOKENS',
  'GOOGLE_API_KEY', 'GEMINI_CLIENT_ID', 'GEMINI_CLIENT_SECRET', 'GEMINI_REFRESH_TOKEN', 'GEMINI_OAUTH_CREDS',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL', 'GOOGLE_SUCCESS_REDIRECT',
  'LEAD_NOTIFY_TO', 'LEAD_NOTIFY_FROM', 'GA4_MEASUREMENT_ID', 'GA4_API_SECRET',
  'RESEND_API_KEY', 'MAIL_FROM', 'SYNC_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
];

// Значения-заглушки из .env.example: с ними JWT подделывается для любого id.
function isPlaceholder(value) {
  return /^change-me/i.test(String(value || '').trim());
}

function validateEnv(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const missing = REQUIRED_SECRETS.filter((key) => !env[key] || String(env[key]).trim() === '' || isPlaceholder(env[key]));
  if (isProd) {
    const short = REQUIRED_SECRETS.filter((key) => env[key] && !isPlaceholder(env[key]) && String(env[key]).trim().length < 32);
    if (short.length) {
      logger.warn(`Weak secrets (shorter than 32 characters): ${short.join(', ')}. Regenerate them with crypto.randomBytes(32).`);
    }
  }

  if (missing.length === 0) {
    return { ok: true, missing: [] };
  }

  if (isProd) {
    const msg = `Missing or placeholder environment variables in production: ${missing.join(', ')}`;
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
module.exports.OPTIONAL_ENV = OPTIONAL_ENV;
