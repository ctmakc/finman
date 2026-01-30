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
