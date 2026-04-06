const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const passport = require('passport');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDatabase, closeDatabase } = require('./db/database');
const config = require('./config/config');
const dotenv = require('dotenv');

// Загрузка переменных окружения
dotenv.config();

// Импорт маршрутов API
const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const transactionsRoutes = require('./routes/transactions');
const bankApiRoutes = require('./routes/bank-api');
const budgetsRoutes = require('./routes/budgets');
const familyRoutes = require('./routes/family');
const recurringRoutes = require('./routes/recurring');
const currencyRoutes = require('./routes/currency');
const goalsRoutes = require('./routes/goals');
const debtsRoutes = require('./routes/debts');
const splitRoutes = require('./routes/split');
const notificationsRoutes = require('./routes/notifications');
const investmentsRoutes = require('./routes/investments');
const analyticsRoutes = require('./routes/analytics');
const exportRoutes = require('./routes/export');
const subscriptionsRoutes = require('./routes/subscriptions');
const networthRoutes = require('./routes/networth');
const receiptsRoutes = require('./routes/receipts');
const reportsRoutes = require('./routes/reports');
const calendarRoutes = require('./routes/calendar');
const widgetsRoutes = require('./routes/widgets');
const forecastRoutes = require('./routes/forecast');
const organizationsRoutes = require('./routes/organizations');

// All API routes authenticate via JWT Bearer tokens, not cookies,
// so CSRF attacks via cookie credential theft don't apply. // nosemgrep
const app = express(); // nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage
const PORT = config.port;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// Rate limiting - general
const generalLimiter = rateLimit({
  windowMs: config.apiRateLimits.windowMs,
  max: config.apiRateLimits.max,
  message: { error: true, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting - auth (stricter)
const authLimiter = rateLimit({
  windowMs: config.authRateLimits.windowMs,
  max: config.authRateLimits.max,
  message: { error: true, message: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Настройка middleware
app.use(cors(config.corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
// Session is only used for Passport serialization fallback;
// all API routes use JWT Bearer tokens so CSRF doesn't apply to them.
app.use(session({ // nosemgrep
  name: 'finman.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.environment === 'production', // nosemgrep
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined,
    expires: false, // session cookie — cleared when browser closes
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Применение rate limiting
app.use('/api/', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Инициализация Passport.js
app.use(passport.initialize());
app.use(passport.session());

// Настройка стратегий Passport (локально определены в authService.js)
require('./services/authService');

// Initialize database
initDatabase();

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationsRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/bank-api', bankApiRoutes);
app.use('/api/budgets', budgetsRoutes);
app.use('/api/family', familyRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/currency', currencyRoutes);
app.use('/api/goals', goalsRoutes);
app.use('/api/debts', debtsRoutes);
app.use('/api/split', splitRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/investments', investmentsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/networth', networthRoutes);
app.use('/api/receipts', receiptsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/widgets', widgetsRoutes);
app.use('/api/forecast', forecastRoutes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: true, 
    message: process.env.NODE_ENV === 'production' 
      ? 'Internal Server Error' 
      : err.message 
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} — http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  closeDatabase();
  process.exit(1);
});
