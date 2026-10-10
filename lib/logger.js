// lib/logger.js — pino instance (logger.info / warn / error) + фабрика для тестов.
//
// Редакция секретов: pino-http кладёт req/res в каждую строку запроса, и без
// redact в логи уезжали Authorization: Bearer <jwt> и Cookie целиком. Все пути
// ниже заменяются на '[Redacted]' ДО сериализации, поэтому ни в stdout, ни в
// docker logs токенов нет. body.* на случай, если кто-то залогирует тело запроса.
const pino = require('pino');

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.token',
  'body.password',
  'body.currentPassword',
  'body.token',
  'password',
  'token',
  '*.password',
  '*.token',
  '*.authorization',
  '*.cookie',
];

const defaultLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// createLogger({ level, stream }) — тот же конфиг, но с явным назначением
// (stream), чтобы тесты могли перехватить вывод и проверить редакцию.
function createLogger({ level = defaultLevel, stream } = {}) {
  const options = {
    level,
    base: undefined, // не печатать pid/hostname в каждой строке
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  };
  return stream ? pino(options, stream) : pino(options);
}

// В тестах глушим вывод, чтобы не засорять отчёт jest.
const logger = createLogger({
  level: process.env.NODE_ENV === 'test' ? 'silent' : defaultLevel,
});

module.exports = logger;
module.exports.createLogger = createLogger;
module.exports.REDACT_PATHS = REDACT_PATHS;
