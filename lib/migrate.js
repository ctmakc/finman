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

    await migration.up(helpers, { columnExists });
    await helpers.run('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)', [name]);
    ranNow.push(name);
  }

  return ranNow;
}

module.exports = { runMigrations, columnExists, MIGRATIONS_DIR };
