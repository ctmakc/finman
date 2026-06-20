// test/helpers/app.js — Foundation test harness (per CONTRACT).
//
// makeApp() -> Promise<{ app, request, token, userId, db, close }>
//   - app: express app bound to a FRESH temp sqlite DB (one seeded user)
//   - request: supertest(app)
//   - token: valid JWT for the seeded user (header: 'Authorization: Bearer '+token)
//   - userId: id of the seeded user
//   - db: the sqlite3 db handle for this temp DB
//   - close: async () => void  (closes db + removes the temp file)
//
// Каждый вызов makeApp() создаёт изолированную временную БД и свежий
// экземпляр модулей (config/database/server/routes) через сброс require-кэша.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Фиксированные тестовые секреты (до загрузки config!).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-fixed';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-fixed';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Список модулей с состоянием, которые нужно перезагружать на каждую БД.
const STATEFUL_MODULES = [
  'config/config.js',
  'db/database.js',
  'lib/migrate.js',
  'services/authService.js',
  'server.js',
];

function purgeModuleCache() {
  // Под jest модули раздаёт собственный реестр, а не require.cache —
  // ручная чистка require.cache в этом случае ни на что не влияет, и
  // повторный makeApp() получал бы УЖЕ ЗАКРЫТЫЙ db-хендл от первого вызова
  // (SQLITE_MISUSE: Database is closed). jest.resetModules() сбрасывает
  // реестр jest, чтобы следующий require отдал свежие config/db/server.
  if (typeof jest !== 'undefined' && typeof jest.resetModules === 'function') {
    jest.resetModules();
  }
  // Сбрасываем кэш для config/db/server и ВСЕХ роутов/моделей/middleware/lib,
  // чтобы новый app биндился к новой БД (для запуска вне jest).
  for (const id of Object.keys(require.cache)) {
    if (
      id.startsWith(path.join(PROJECT_ROOT, 'routes')) ||
      id.startsWith(path.join(PROJECT_ROOT, 'models')) ||
      id.startsWith(path.join(PROJECT_ROOT, 'middleware')) ||
      id.startsWith(path.join(PROJECT_ROOT, 'lib')) ||
      id.startsWith(path.join(PROJECT_ROOT, 'services')) ||
      id === path.join(PROJECT_ROOT, 'config', 'config.js') ||
      id === path.join(PROJECT_ROOT, 'db', 'database.js') ||
      id === path.join(PROJECT_ROOT, 'server.js')
    ) {
      delete require.cache[id];
    }
  }
  // ВАЖНО: passport — глобальный синглтон. НЕ сбрасываем passport._strategies:
  // повторный require authService просто перезапишет одноимённые стратегии
  // (jwt/local) с актуальным config.jwtSecret, а встроенная 'session'-стратегия
  // (нужна для passport.session()) останется зарегистрированной.
  void STATEFUL_MODULES; // документируем намерение
}

async function makeApp() {
  // Уникальный временный файл БД для этого экземпляра.
  const dbFile = path.join(
    os.tmpdir(),
    `finman-test-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`
  );
  process.env.DATABASE_PATH = dbFile;

  purgeModuleCache();

  // Загружаем свежие модули, привязанные к новой БД.
  const config = require(path.join(PROJECT_ROOT, 'config', 'config.js'));
  const database = require(path.join(PROJECT_ROOT, 'db', 'database.js'));
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcrypt');

  // Создаём схему + прогоняем миграции.
  await database.initDatabase();

  // Сеем одного пользователя.
  const passwordHash = await bcrypt.hash('password123', 10);
  const insert = await database.run(
    `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
    ['testuser', 'test@example.com', passwordHash, 'Test User']
  );
  const userId = insert.id;

  // Требуем app ПОСЛЕ инициализации БД (server.js делает initDatabase сам,
  // но идемпотентно; require.main !== module -> listen не вызывается).
  const app = require(path.join(PROJECT_ROOT, 'server.js'));

  // Подписываем JWT тем же секретом, что использует приложение.
  const token = jwt.sign({ id: userId }, config.jwtSecret, {
    expiresIn: config.jwtExpiration || '24h',
  });

  const supertest = require('supertest');
  const request = supertest(app);

  const close = async () => {
    try {
      await database.closeDatabase();
    } catch (e) {
      /* ignore */
    }
    try {
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    } catch (e) {
      /* ignore */
    }
  };

  return { app, request, token, userId, db: database.db, close };
}

module.exports = { makeApp };
