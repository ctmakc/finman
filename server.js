const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDatabase, closeDatabase } = require('./db/database');
const config = require('./config/config');
const dotenv = require('dotenv');

// Загрузка переменных окружения
dotenv.config();

// Foundation: shared infra
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const validateEnv = require('./lib/validateEnv');
const { requireTier } = require('./middleware/requireTier');
const { notFound, errorHandler } = require('./middleware/error');

// Fail-fast в проде, предупреждение в dev по обязательным секретам.
validateEnv();

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

// Foundation: новые роутеры (часть — стабы, заменяются feature-стримами)
const healthRoutes = require('./routes/health');
const aiRoutes = require('./routes/ai');
const billingRoutes = require('./routes/billing');
const syncRoutes = require('./routes/sync');
const anomaliesRoutes = require('./routes/anomalies');
const onboardingRoutes = require('./routes/onboarding');

// Настройка Express
const app = express();
const PORT = config.port;

// Request logging (pino-http). В тестах logger в silent-режиме.
app.use(pinoHttp({ logger }));

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

// Rate limiting - общий
const generalLimiter = rateLimit({
  windowMs: config.apiRateLimits.windowMs,
  max: config.apiRateLimits.max,
  message: { error: true, message: 'Слишком много запросов, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting - для аутентификации (более строгий)
const authLimiter = rateLimit({
  windowMs: config.authRateLimits.windowMs,
  max: config.authRateLimits.max,
  message: { error: true, message: 'Слишком много попыток входа, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Настройка middleware
app.use(cors(config.corsOptions));
// Stripe webhook требует СЫРОЕ тело для проверки подписи — монтируем raw ДО json-парсера.
app.use('/api/billing/webhook', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.environment === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 часа
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

// Инициализация базы данных.
// При прямом запуске (node server.js) инициализируем здесь.
// При require из тестов харнес сам вызывает initDatabase() до запросов,
// чтобы полностью контролировать жизненный цикл временной БД.
if (require.main === module) {
  initDatabase();
}

// Статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// Маршруты API
app.use('/api/auth', authRoutes);
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

// Middleware для проверки аутентификации API
function apiAuthMiddleware(req, res, next) {
  passport.authenticate('jwt', { session: false }, (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    req.user = user;
    next();
  })(req, res, next);
}

// Защищенные маршруты API
app.get('/api/protected', apiAuthMiddleware, (req, res) => {
  res.json({ message: 'This is protected data', user: req.user });
});

// ==================== FOUNDATION: новые роутеры ====================
// Health/Ready смонтированы на /api -> /api/health, /api/ready
app.use('/api', healthRoutes);
// AI: сначала аутентификация (заполняет req.user), затем гейт по тиру 'pro'.
app.use('/api/ai', apiAuthMiddleware, requireTier('pro'), aiRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/anomalies', anomaliesRoutes);
app.use('/api/onboarding', apiAuthMiddleware, onboardingRoutes);

// Маршрут для всех остальных запросов (SPA) — НЕ перехватываем /api/*,
// чтобы неизвестные API-роуты дошли до notFound + errorHandler.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 для неизвестных API-маршрутов (форматируется errorHandler-ом).
app.use(notFound);

// Централизованный обработчик ошибок (AppError + unknown) — должен быть ПОСЛЕДНИМ.
app.use(errorHandler);

// Legacy fallback (на случай, если errorHandler делегирует дальше).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: true,
    message: process.env.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : err.message
  });
});

// Запуск сервера только при прямом запуске (node server.js).
// При require (тест-харнес) экспортируем app без побочного listen.
let server = null;
if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Откройте http://localhost:${PORT} в вашем браузере`);
  });

  // Опциональный фоновый планировщик банковской синхронизации (gated SYNC_ENABLED).
  try {
    const syncScheduler = require('./services/syncScheduler');
    if (syncScheduler.isEnabled()) {
      syncScheduler.start();
      logger.info('Bank sync scheduler started');
    }
  } catch (e) {
    logger.warn({ err: e }, 'Sync scheduler not started');
  }

  // Graceful shutdown - закрытие БД при завершении процесса
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
}

// Экспорт для тестов (supertest монтируется на app напрямую).
module.exports = app;
module.exports.app = app;
module.exports.getServer = () => server;
