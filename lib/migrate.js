// lib/migrate.js — простой идемпотентный раннер миграций.
// Создаёт таблицу schema_migrations и применяет JS-миграции из ./migrations
// в порядке имён файлов. Каждая миграция: module.exports = { name, up(db helpers) }.
// up получает { query, get, run } и должна быть сама по себе идемпотентной
// (CREATE TABLE IF NOT EXISTS / ALTER TABLE с проверкой колонки).

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function ensureMigrationsTable(dbHelpers) {
  await dbHelpers.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Хелпер для миграций: проверить, существует ли колонка в таблице.
async function columnExists(dbHelpers, table, column) {
  const rows = await dbHelpers.query(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d.*\.js$/.test(f))
    .sort();
}

async function runMigrations(dbHelpers) {
  // dbHelpers по умолчанию — реальный модуль БД; в тестах можно подменить.
  const helpers = dbHelpers || require('../db/database');
  await ensureMigrationsTable(helpers);

  const appliedRows = await helpers.query('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.name));

  const files = loadMigrationFiles();
  const ranNow = [];

  for (const file of files) {
    const migration = require(path.join(MIGRATIONS_DIR, file));
    const name = migration.name || file;
    if (applied.has(name)) continue;

    // Each migration runs atomically together with its schema_migrations row:
    // a failure halfway (e.g. a table rebuild) rolls back, so the next boot
    // retries from a clean state instead of tripping over half-built objects.
    // NB: PRAGMA foreign_keys is a no-op inside a transaction — a migration
    // that needs FK relaxation must use PRAGMA defer_foreign_keys instead.
    // Real db module: its transaction() keeps writes from other callers
    // (scheduler, early requests) out of the migration's BEGIN..COMMIT.
    const apply = async () => {
      await migration.up(helpers, { columnExists });
      await helpers.run('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)', [name]);
    };
    try {
      if (typeof helpers.transaction === 'function') {
        await helpers.transaction(apply);
      } else {
        await helpers.run('BEGIN');
        try {
          await apply();
          await helpers.run('COMMIT');
        } catch (err) {
          try {
            await helpers.run('ROLLBACK');
          } catch (_) {
            /* already rolled back */
          }
          throw err;
        }
      }
    } catch (err) {
      err.message = `migration ${name} failed: ${err.message}`;
      throw err;
    }
    ranNow.push(name);
  }

  return ranNow;
}

module.exports = { runMigrations, columnExists, MIGRATIONS_DIR };
