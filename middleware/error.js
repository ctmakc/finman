// middleware/error.js — централизованная обработка ошибок
// AppError -> бросается в роутах; errorHandler форматирует ответ как
// { success:false, error:{ code, message } }.

const logger = require('../lib/logger');

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status || 500;
    this.code = code || 'INTERNAL_ERROR';
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// 404 для несуществующих маршрутов (вешается до errorHandler)
function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.originalUrl}`));
}

// Express 4-арный обработчик ошибок. Должен быть смонтирован ПОСЛЕДНИМ.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Если ответ уже начат — делегируем дефолтному обработчику express.
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, code: err.code }, err.message);
    } else {
      logger.warn({ code: err.code }, err.message);
    }
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
  }

  // Ошибки валидации тела (express.json) и прочие известные типы
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_JSON', message: 'Invalid JSON body' },
    });
  }

  // Неизвестная ошибка -> 500, без утечки стека в проде.
  logger.error({ err }, err && err.message ? err.message : 'Unknown error');
  const message =
    process.env.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : (err && err.message) || 'Internal Server Error';
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message },
  });
}

module.exports = { AppError, errorHandler, notFound };
