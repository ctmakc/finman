// middleware/patAuth.js — авторизация публичного REST API по Personal Access Token.
//
// Ожидает заголовок `Authorization: Bearer <finman_pat_…>`. При валидном токене
// ставит req.user = { id } и пропускает дальше. Иначе — 401 в формате envelope
// ({ success:false, error:{ code, message } }), как и весь /api/v1.
//
// ВАЖНО: это НЕ passport-jwt. PAT и JWT — разные механизмы; этот middleware
// применяется только к публичным /api/v1-роутам (управление токенами при этом
// сидит за обычным jwt-authenticate внутри роутера).

const patService = require('../services/patService');
const { fail } = require('../lib/respond');

function extractBearer(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function patAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) {
      return fail(res, 401, 'NO_TOKEN', 'Personal access token required');
    }
    const userId = await patService.verify(token);
    if (userId == null) {
      return fail(res, 401, 'INVALID_TOKEN', 'Invalid or revoked access token');
    }
    req.user = { id: userId };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = patAuth;
module.exports.patAuth = patAuth;
