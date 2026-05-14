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
        }
      });

      // Таблица регулярных платежей
      db.run(`
        CREATE TABLE IF NOT EXISTS recurring_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          account_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          amount REAL NOT NULL,
          type TEXT NOT NULL DEFAULT 'expense',
          category TEXT,
          frequency TEXT NOT NULL DEFAULT 'monthly',
          day_of_month INTEGER,
          day_of_week INTEGER,
          start_date TEXT NOT NULL,
          end_date TEXT,
          next_payment_date TEXT NOT NULL,
          last_payment_date TEXT,
          auto_create BOOLEAN DEFAULT 0,
          notify_before INTEGER DEFAULT 3,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (account_id) REFERENCES accounts (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы recurring_payments:', err);
          reject(err);
        }
      });

      // Таблица курсов валют
      db.run(`
        CREATE TABLE IF NOT EXISTS currency_rates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_currency TEXT NOT NULL,
          to_currency TEXT NOT NULL,
          rate REAL NOT NULL,
          source TEXT DEFAULT 'manual',
          date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(from_currency, to_currency, date)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы currency_rates:', err);
          reject(err);
        }
      });

      // Таблица пользовательских настроек валют
      db.run(`
        CREATE TABLE IF NOT EXISTS user_currency_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE,
          base_currency TEXT NOT NULL DEFAULT 'UAH',
          display_currencies TEXT DEFAULT '["UAH","USD","EUR"]',
          auto_convert BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы user_currency_settings:', err);
          reject(err);
        }
      });

      // Таблица тегов
      db.run(`
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          color TEXT DEFAULT '#5D5CDE',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          UNIQUE(user_id, name)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы tags:', err);
          reject(err);
        }
      });

      // Связь транзакций и тегов
      db.run(`
        CREATE TABLE IF NOT EXISTS transaction_tags (
          transaction_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          PRIMARY KEY (transaction_id, tag_id),
          FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы transaction_tags:', err);
          reject(err);
        }
      });

      // ==================== ЦЕЛИ НАКОПЛЕНИЯ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS savings_goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          target_amount REAL NOT NULL,
          current_amount REAL DEFAULT 0,
          currency TEXT DEFAULT 'UAH',
          target_date TEXT,
          category TEXT,
          icon TEXT DEFAULT 'piggy-bank',
          color TEXT DEFAULT '#5D5CDE',
          is_completed BOOLEAN DEFAULT 0,
          completed_at DATETIME,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы savings_goals:', err);
          reject(err);
        }
      });

      // Таблица пополнений целей
      db.run(`
        CREATE TABLE IF NOT EXISTS goal_contributions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          note TEXT,
          transaction_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (goal_id) REFERENCES savings_goals (id) ON DELETE CASCADE,
          FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE SET NULL
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы goal_contributions:', err);
          reject(err);
        }
      });

      // ==================== ДОЛГИ И КРЕДИТЫ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS debts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          paid_amount REAL DEFAULT 0,
          interest_rate REAL DEFAULT 0,
          currency TEXT DEFAULT 'UAH',
          counterparty TEXT,
          start_date TEXT NOT NULL,
          due_date TEXT,
          is_paid BOOLEAN DEFAULT 0,
          paid_at DATETIME,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы debts:', err);
          reject(err);
        }
      });

      // Таблица платежей по долгам
      db.run(`
        CREATE TABLE IF NOT EXISTS debt_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          debt_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          payment_type TEXT DEFAULT 'principal',
          note TEXT,
          transaction_id INTEGER,
          payment_date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (debt_id) REFERENCES debts (id) ON DELETE CASCADE,
          FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE SET NULL
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы debt_payments:', err);
          reject(err);
        }
      });

      // ==================== СПЛИТ РАСХОДОВ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS split_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          currency TEXT DEFAULT 'UAH',
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы split_groups:', err);
          reject(err);
        }
      });

      // Участники группы сплита
      db.run(`
        CREATE TABLE IF NOT EXISTS split_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL,
          user_id INTEGER,
          name TEXT NOT NULL,
          email TEXT,
          is_registered BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (group_id) REFERENCES split_groups (id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы split_members:', err);
          reject(err);
        }
      });

      // Расходы для сплита
      db.run(`
        CREATE TABLE IF NOT EXISTS split_expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL,
          paid_by INTEGER NOT NULL,
          description TEXT NOT NULL,
          amount REAL NOT NULL,
          split_type TEXT DEFAULT 'equal',
          date TEXT NOT NULL,
          category TEXT,
          is_settled BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (group_id) REFERENCES split_groups (id) ON DELETE CASCADE,
          FOREIGN KEY (paid_by) REFERENCES split_members (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы split_expenses:', err);
          reject(err);
        }
      });

      // Доли участников в расходе
      db.run(`
        CREATE TABLE IF NOT EXISTS split_shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          expense_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          is_paid BOOLEAN DEFAULT 0,
          paid_at DATETIME,
          FOREIGN KEY (expense_id) REFERENCES split_expenses (id) ON DELETE CASCADE,
          FOREIGN KEY (member_id) REFERENCES split_members (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы split_shares:', err);
          reject(err);
        }
      });

      // Расчёты между участниками
      db.run(`
        CREATE TABLE IF NOT EXISTS split_settlements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL,
          from_member INTEGER NOT NULL,
          to_member INTEGER NOT NULL,
          amount REAL NOT NULL,
          date TEXT NOT NULL,
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (group_id) REFERENCES split_groups (id) ON DELETE CASCADE,
          FOREIGN KEY (from_member) REFERENCES split_members (id),
          FOREIGN KEY (to_member) REFERENCES split_members (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы split_settlements:', err);
          reject(err);
        }
      });

      // ==================== УВЕДОМЛЕНИЯ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT,
          data TEXT,
          is_read BOOLEAN DEFAULT 0,
          read_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы notifications:', err);
          reject(err);
        }
      });

      // Настройки уведомлений пользователя
      db.run(`
        CREATE TABLE IF NOT EXISTS notification_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE,
          budget_alerts BOOLEAN DEFAULT 1,
          recurring_reminders BOOLEAN DEFAULT 1,
          goal_milestones BOOLEAN DEFAULT 1,
          debt_reminders BOOLEAN DEFAULT 1,
          weekly_summary BOOLEAN DEFAULT 1,
          push_enabled BOOLEAN DEFAULT 0,
          email_enabled BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы notification_settings:', err);
          reject(err);
        }
      });

      // ==================== ИНВЕСТИЦИИ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS investment_portfolios (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          currency TEXT DEFAULT 'USD',
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы investment_portfolios:', err);
          reject(err);
        }
      });

      // Активы (акции, крипто и т.д.)
      db.run(`
        CREATE TABLE IF NOT EXISTS investments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          portfolio_id INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          quantity REAL NOT NULL,
          buy_price REAL NOT NULL,
          current_price REAL,
          currency TEXT DEFAULT 'USD',
          buy_date TEXT NOT NULL,
          notes TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (portfolio_id) REFERENCES investment_portfolios (id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы investments:', err);
          reject(err);
        }
      });

      // История цен активов
      db.run(`
        CREATE TABLE IF NOT EXISTS investment_prices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          price REAL NOT NULL,
          currency TEXT DEFAULT 'USD',
          date TEXT NOT NULL,
          source TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, date)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы investment_prices:', err);
          reject(err);
        }
      });

      // Транзакции с инвестициями (покупка/продажа/дивиденды)
      db.run(`
        CREATE TABLE IF NOT EXISTS investment_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          quantity REAL NOT NULL,
          price REAL NOT NULL,
          fee REAL DEFAULT 0,
          date TEXT NOT NULL,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (investment_id) REFERENCES investments (id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы investment_transactions:', err);
          reject(err);
        }
      });

      // ==================== ПОДПИСКИ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          amount REAL NOT NULL,
          currency TEXT DEFAULT 'UAH',
          billing_cycle TEXT DEFAULT 'monthly',
          category TEXT,
          icon TEXT,
          color TEXT DEFAULT '#5D5CDE',
          start_date TEXT NOT NULL,
          next_billing_date TEXT,
          reminder_days INTEGER DEFAULT 3,
          is_active BOOLEAN DEFAULT 1,
          auto_renew BOOLEAN DEFAULT 1,
          account_id INTEGER,
          url TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (account_id) REFERENCES accounts (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы subscriptions:', err);
          reject(err);
        }
      });

      // История платежей подписок
      db.run(`
        CREATE TABLE IF NOT EXISTS subscription_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subscription_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          payment_date TEXT NOT NULL,
          transaction_id INTEGER,
          status TEXT DEFAULT 'paid',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (subscription_id) REFERENCES subscriptions (id) ON DELETE CASCADE,
          FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE SET NULL
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы subscription_payments:', err);
          reject(err);
        }
      });

      // ==================== СКАНЕР ЧЕКОВ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          image_path TEXT,
          image_data TEXT,
          merchant TEXT,
          total_amount REAL,
          currency TEXT DEFAULT 'UAH',
          receipt_date TEXT,
          category TEXT,
          items TEXT,
          ocr_raw TEXT,
          ocr_status TEXT DEFAULT 'pending',
          transaction_id INTEGER,
          is_processed BOOLEAN DEFAULT 0,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE SET NULL
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы receipts:', err);
          reject(err);
        }
      });

      // ==================== NET WORTH ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS networth_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          total_assets REAL NOT NULL,
          total_liabilities REAL NOT NULL,
          net_worth REAL NOT NULL,
          assets_breakdown TEXT,
          liabilities_breakdown TEXT,
          snapshot_date TEXT NOT NULL,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы networth_snapshots:', err);
          reject(err);
        }
      });

      // Ручные активы (недвижимость, авто и т.д.)
      db.run(`
        CREATE TABLE IF NOT EXISTS manual_assets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          value REAL NOT NULL,
          currency TEXT DEFAULT 'UAH',
          purchase_date TEXT,
          purchase_price REAL,
          description TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы manual_assets:', err);
          reject(err);
        }
      });

      // ==================== ВИДЖЕТЫ ДАШБОРДА ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS dashboard_widgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          widget_type TEXT NOT NULL,
          title TEXT,
          position INTEGER DEFAULT 0,
          size TEXT DEFAULT 'medium',
          settings TEXT,
          is_visible BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы dashboard_widgets:', err);
          reject(err);
        }
      });

      // ==================== ФИНАНСОВЫЙ КАЛЕНДАРЬ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          event_type TEXT NOT NULL,
          amount REAL,
          currency TEXT DEFAULT 'UAH',
          event_date TEXT NOT NULL,
          end_date TEXT,
          is_recurring BOOLEAN DEFAULT 0,
          recurrence_rule TEXT,
          reminder_enabled BOOLEAN DEFAULT 1,
          reminder_days INTEGER DEFAULT 1,
          color TEXT DEFAULT '#5D5CDE',
          related_id INTEGER,
          related_type TEXT,
          is_completed BOOLEAN DEFAULT 0,
          completed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы calendar_events:', err);
          reject(err);
        }
      });

      // ==================== PDF ОТЧЁТЫ ====================
      db.run(`
        CREATE TABLE IF NOT EXISTS reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          report_type TEXT NOT NULL,
          title TEXT NOT NULL,
          period_start TEXT,
          period_end TEXT,
          file_path TEXT,
          file_data TEXT,
          format TEXT DEFAULT 'pdf',
          parameters TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `, (err) => {
        if (err) {
          console.error('Error creating reports table:', err);
          reject(err);
        }
      });

      // ==================== ORGANIZATIONS (SaaS) ====================
      db.run(`CREATE TABLE IF NOT EXISTS organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        plan TEXT DEFAULT 'free',
        ai_provider TEXT DEFAULT NULL,
        ai_model TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => { if (err) console.error('Error creating organizations table:', err); });

      db.run(`CREATE TABLE IF NOT EXISTS organization_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(org_id, user_id)
      )`, (err) => { if (err) console.error('Error creating organization_members table:', err); });

      db.run(`CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'member',
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
      )`, (err) => { if (err) console.error('Error creating invites table:', err); });

      db.run(`CREATE TABLE IF NOT EXISTS ai_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        period TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, period, type)
      )`, (err) => { if (err) console.error('Error creating ai_insights table:', err); });

      db.run(`CREATE TABLE IF NOT EXISTS ai_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        session_id TEXT UNIQUE NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => { if (err) console.error('Error creating ai_chat_sessions table:', err); });

      // Performance indexes for high-frequency queries
      const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_transactions_user_type ON transactions(user_id, type)`,
        `CREATE INDEX IF NOT EXISTS idx_transactions_user_category ON transactions(user_id, category)`,
        `CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id)`,
        `CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id, is_active)`,
        `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_payments(user_id, is_active)`,
        `CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id, is_active)`,
      ];
      for (const sql of indexes) {
        db.run(sql, (err) => { if (err) console.error('Index error:', err.message); });
      }

      // Migration: add org_id to users if not exists
      db.run(`ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES organizations(id)`,
        (err) => {
          if (err && !err.message.includes('duplicate column')) console.error('Migration error (users.org_id):', err);
        }
      );

      // Migration: change default currency from RUB to USD
      // (new accounts will default to USD via application layer)

      console.log('Database initialized successfully');
      resolve();
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
