// middleware/authorize.js — проверка владения ресурсом.
// requireOwnership(loadResource): loadResource(req) -> Promise<{user_id}|null>
//   404 если ресурс не найден (null), 403 если user_id !== req.user.id.

const { AppError } = require('./error');

function requireOwnership(loadResource) {
  if (typeof loadResource !== 'function') {
    throw new Error('requireOwnership requires a loadResource(req) function');
  }
  return async function (req, res, next) {
    try {
      if (!req.user || req.user.id == null) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
      }
      const resource = await loadResource(req);
      if (!resource) {
        return next(new AppError(404, 'NOT_FOUND', 'Resource not found'));
      }
      // Сравниваем без учёта типа (id из БД может быть number, из токена тоже)
      if (Number(resource.user_id) !== Number(req.user.id)) {
        return next(new AppError(403, 'FORBIDDEN', 'You do not have access to this resource'));
      }
      // Прокидываем загруженный ресурс дальше, чтобы хендлер не грузил повторно.
      req.resource = resource;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireOwnership };
