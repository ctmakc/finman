const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

// Путь к базе данных
const dbPath = path.resolve(config.dbPath);

// Создание директории для базы данных, если не существует
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)){
  fs.mkdirSync(dbDir, { recursive: true });
}

// Создание подключения к базе данных
const db = new sqlite3.Database(dbPath);

// Инициализация базы данных
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Таблица пользователей
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          full_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы users:', err);
          reject(err);
        }
      });
      
      // Таблица счетов
      db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          account_number TEXT,
          bank_name TEXT,
          currency TEXT DEFAULT 'RUB',
          balance REAL DEFAULT 0,
          account_type TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы accounts:', err);
          reject(err);
        }
      });
      
      // Таблица для транзакций
      db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          date TEXT NOT NULL,
          description TEXT,
          category TEXT,
          amount REAL NOT NULL,
          type TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (account_id) REFERENCES accounts (id),
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы transactions:', err);
          reject(err);
        }
      });
      
      // Таблица для категорий
      db.run(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          color TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          UNIQUE(user_id, name)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы categories:', err);
          reject(err);
        }
      });
      
      // Таблица подключений к API банков
      db.run(`
        CREATE TABLE IF NOT EXISTS bank_connections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          bank_id TEXT NOT NULL,
          access_token TEXT,
          refresh_token TEXT,
          expires_at DATETIME,
          account_ids TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы bank_connections:', err);
          reject(err);
        }
      });

      // Таблица кастомных банков пользователей
      db.run(`
        CREATE TABLE IF NOT EXISTS custom_banks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          bank_key TEXT NOT NULL,
          name TEXT NOT NULL,
          country TEXT NOT NULL,
          api_url TEXT NOT NULL,
          auth_type TEXT NOT NULL DEFAULT 'api_key',
          scopes TEXT,
          endpoints TEXT,
          token_instructions TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          UNIQUE(user_id, bank_key)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы custom_banks:', err);
          reject(err);
        }
      });

      // Таблица бюджетов
      db.run(`
        CREATE TABLE IF NOT EXISTS budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          category TEXT,
          amount REAL NOT NULL,
          spent REAL DEFAULT 0,
          period TEXT NOT NULL DEFAULT 'monthly',
          start_date TEXT NOT NULL,
          end_date TEXT,
          currency TEXT DEFAULT 'UAH',
          notify_at_percent INTEGER DEFAULT 80,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы budgets:', err);
          reject(err);
        }
      });

      // Таблица семей/групп
      db.run(`
        CREATE TABLE IF NOT EXISTS families (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          owner_id INTEGER NOT NULL,
          invite_code TEXT UNIQUE,
          description TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (owner_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы families:', err);
          reject(err);
        }
      });

      // Таблица участников семьи
      db.run(`
        CREATE TABLE IF NOT EXISTS family_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          family_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          nickname TEXT,
          joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users (id),
          UNIQUE(family_id, user_id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы family_members:', err);
          reject(err);
        }
      });

      // Таблица прав доступа к счетам
      db.run(`
        CREATE TABLE IF NOT EXISTS account_permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          can_view BOOLEAN DEFAULT 1,
          can_edit BOOLEAN DEFAULT 0,
          can_delete BOOLEAN DEFAULT 0,
          can_add_transactions BOOLEAN DEFAULT 0,
          granted_by INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (granted_by) REFERENCES users (id),
          UNIQUE(account_id, user_id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы account_permissions:', err);
          reject(err);
        }
      });

      // Таблица прав доступа к бюджетам
      db.run(`
        CREATE TABLE IF NOT EXISTS budget_permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          budget_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          can_view BOOLEAN DEFAULT 1,
          can_edit BOOLEAN DEFAULT 0,
          granted_by INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (budget_id) REFERENCES budgets (id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (granted_by) REFERENCES users (id),
          UNIQUE(budget_id, user_id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы budget_permissions:', err);
          reject(err);
        }
      });

      // Таблица приглашений в семью
      db.run(`
        CREATE TABLE IF NOT EXISTS family_invites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          family_id INTEGER NOT NULL,
          email TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          invite_token TEXT UNIQUE NOT NULL,
          expires_at DATETIME NOT NULL,
          used_at DATETIME,
          created_by INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы family_invites:', err);
          reject(err);
        } else {
          console.log('База данных инициализирована успешно');
          resolve();
        }
      });
    });
  });
}

// Вспомогательная функция для выполнения запросов
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error('Ошибка SQL:', err);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Вспомогательная функция для одной строки
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        console.error('Ошибка SQL:', err);
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

// Вспомогательная функция для выполнения INSERT/UPDATE/DELETE
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        console.error('Ошибка SQL:', err);
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
}

// Закрытие подключения к базе данных
function closeDatabase() {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        console.error('Ошибка при закрытии базы данных:', err);
        reject(err);
      } else {
        console.log('База данных закрыта');
        resolve();
      }
    });
  });
}

module.exports = {
  initDatabase,
  closeDatabase,
  query,
  get,
  run,
  db
};
