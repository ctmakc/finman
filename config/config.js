const dotenv = require('dotenv');
dotenv.config();

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'your-jwt-secret-key',
  jwtExpiration: '24h',
  sessionSecret: process.env.SESSION_SECRET || 'your-session-secret-key',
  dbPath: process.env.DATABASE_PATH || './data/finance.db',
  environment: process.env.NODE_ENV || 'development',
  apiRateLimits: {
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100 // макс. запросов за windowMs
  }
};
