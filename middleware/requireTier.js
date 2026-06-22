// middleware/requireTier.js — гейт по уровню подписки.
// Порядок тиров: free < pro < family.
// Читает req.user.subscription_tier; 402 PAYMENT_REQUIRED если уровень ниже требуемого.
//
// PERF: models/user.js findById теперь выбирает subscription_tier (+ stripe ids),
// поэтому req.user.subscription_tier обычно уже присутствует и мы НЕ делаем
// лишний per-request запрос в БД. Если поле всё же отсутствует (старый токен/
// нестандартный req.user) — догружаем тир из БД по req.user.id как fallback.

const { AppError } = require('./error');

const TIER_ORDER = { free: 0, pro: 1, family: 2 };

function rank(tier) {
  return TIER_ORDER[tier] != null ? TIER_ORDER[tier] : 0; // неизвестный -> free
}

// Ленивая загрузка db-хелпера (избегаем циклов require на старте).
function getDb() {
  return require('../db/database');
}

async function resolveTier(req) {
  // 1) Уже есть на пользователе
  if (req.user && req.user.subscription_tier) {
    return req.user.subscription_tier;
  }
  // 2) Догрузить из БД (колонку гарантирует миграция Foundation)
  if (req.user && req.user.id != null) {
    try {
      const { get } = getDb();
      const row = await get('SELECT subscription_tier FROM users WHERE id = ?', [req.user.id]);
      if (row && row.subscription_tier) {
        // Кэшируем на req.user для последующих middleware/хендлеров
        req.user.subscription_tier = row.subscription_tier;
        return row.subscription_tier;
      }
    } catch (e) {
      // Колонки может не быть, если миграции не прогнаны — деградируем до free.
    }
  }
  return 'free';
}

function requireTier(minTier) {
  if (!(minTier in TIER_ORDER)) {
    throw new Error(`requireTier: unknown tier "${minTier}"`);
  }
  return async function (req, res, next) {
    try {
      if (!req.user || req.user.id == null) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
      }
      const tier = await resolveTier(req);
      if (rank(tier) < rank(minTier)) {
        return next(
          new AppError(
            402,
            'PAYMENT_REQUIRED',
            `This feature requires the "${minTier}" plan or higher`
          )
        );
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireTier, TIER_ORDER };
