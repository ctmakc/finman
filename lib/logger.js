// lib/logger.js — pino instance (logger.info / warn / error)
const pino = require('pino');

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// В тестах глушим вывод, чтобы не засорять отчёт jest.
const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : level,
  base: undefined, // не печатать pid/hostname в каждой строке
});

module.exports = logger;
