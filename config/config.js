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

// GCM использует 12-байтовый IV (рекомендация NIST) и 16-байтовый auth-tag.
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

// Шифрование ВСЕГДА через AES-256-GCM (authenticated encryption).
// Формат: 'iv:tag:ciphertext' (3 hex-части).
function encryptToken(text) {
  if (!text) return null;
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY must be set');
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(String(text), 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

// Дешифрование с обратной совместимостью:
//   - 3 части ('iv:tag:ciphertext') -> AES-256-GCM (новый формат);
//   - 2 части ('iv:ciphertext')     -> AES-256-CBC (старые сохранённые токены).
function decryptToken(text) {
  if (!text) return null;
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY must be set');
  const parts = String(text).split(':');

  if (parts.length === 2) {
    // Legacy CBC: 'iv:ciphertext'.
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  }

  if (parts.length === 3) {
    // GCM: 'iv:tag:ciphertext'.
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encryptedText = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  }

  throw new Error('decryptToken: unrecognized ciphertext format');
}

module.exports = {
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
