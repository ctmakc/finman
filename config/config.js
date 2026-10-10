const dotenv = require('dotenv');
const crypto = require('crypto');
dotenv.config();

// Генерация безопасного случайного ключа для development
function generateDevSecret(name) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be set in production environment`);
  }
  console.warn(`WARNING: ${name} not set, using auto-generated key. Set it in .env for production!`);
  return crypto.randomBytes(32).toString('hex');
}

// Валидация email
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Шифрование токенов банков
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || (process.env.NODE_ENV !== 'production' ? crypto.randomBytes(32).toString('hex') : null);
const ENCRYPTION_IV_LENGTH = 16;

function encryptToken(text) {
  if (!text) return null;
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY must be set');
  const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptToken(text) {
  if (!text) return null;
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY must be set');
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

module.exports = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || 'https://app.finman.money/api/auth/google/callback',
    // Where the browser lands after the callback issues a token.
    successRedirect: process.env.GOOGLE_SUCCESS_REDIRECT || 'https://app.finman.money/',
  },
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || generateDevSecret('JWT_SECRET'),
  jwtExpiration: '24h',
  sessionSecret: process.env.SESSION_SECRET || generateDevSecret('SESSION_SECRET'),
  dbPath: process.env.DATABASE_PATH || './data/finance.db',
  environment: process.env.NODE_ENV || 'development',

  // Rate limiting
  apiRateLimits: {
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100 // макс. запросов за windowMs
  },
  authRateLimits: {
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 5 // макс. попыток входа
  },

  // CORS настройки
  corsOptions: {
    origin: process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:3000'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  },

  // Валидация
  isValidEmail,

  // Шифрование токенов
  encryptToken,
  decryptToken
};
