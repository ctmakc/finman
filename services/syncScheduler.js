// services/syncScheduler.js — автоматическая фоновая синхронизация банковских
// транзакций. Использует СУЩЕСТВУЮЩИЙ bankApiService (Monobank/Revolut/Tinkoff и
// т.д.) для выгрузки транзакций и дедуплицирует их перед вставкой в БД.
//
// ВКЛЮЧЕНИЕ: gated по env SYNC_ENABLED (по умолчанию ВЫКЛ). Сервер должен вызвать
// start() только если SYNC_ENABLED истинно.
//
// Экспорт:
//   start()            -> запускает node-cron job (idempotent)
//   stop()             -> останавливает job
//   runOnce(userId?)   -> один прогон синхронизации:
//                           * без userId — по всем пользователям с активными
//                             подключениями;
//                           * с userId   — только по одному пользователю.
//                         Возвращает сводку { users, connections, accounts,
//                         fetched, inserted, skipped, errors }.
//
// ДЕДУПЛИКАЦИЯ: в таблице transactions нет колонки под bank tx id (схема — общая,
// её менять нельзя), поэтому уникальность транзакции определяется по комбинации
// account_id + date + amount + description. Перед вставкой грузим уже имеющиеся
// «отпечатки» транзакций счёта и пропускаем совпадения. Это безопасно при
// повторных прогонах и не ломает ручной импорт.

const cron = require('node-cron');

const BankConnection = require('../models/bankConnection');
const Account = require('../models/account');
const bankApiService = require('../services/bankApiService');
const bankApiConfig = require('../config/bank-api-config');
const { query, get, run } = require('../db/database');
const { round } = require('../lib/money');
const logger = require('../lib/logger');

// Расписание cron: по умолчанию каждый час. Переопределяется env SYNC_CRON.
const DEFAULT_CRON = '0 * * * *';

let task = null; // ссылка на активный node-cron task

// --- ВКЛючён ли планировщик через env ---------------------------------------
function isEnabled() {
  const v = String(process.env.SYNC_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// --- Имя банка по bank_id (для сопоставления со счётом по bank_name) ---------
function bankNameFor(bankId) {
  const cfg = bankApiConfig[bankId];
  return (cfg && cfg.name) || bankId;
}

// --- «Отпечаток» транзакции для дедупликации --------------------------------
// Сумма округляется через money.round, чтобы устранить float-дрейф между тем,
// что вернул банк, и тем, что хранится в SQLite.
function fingerprint(accountId, date, amount, description) {
  return [
    String(accountId),
    String(date || ''),
    String(round(Number(amount) || 0)),
    String(description || ''),
  ].join('|');
}

// --- Загрузка существующих отпечатков транзакций счёта ----------------------
async function loadExistingFingerprints(accountId, userId) {
  const rows = await query(
    `SELECT date, amount, description FROM transactions
     WHERE account_id = ? AND user_id = ?`,
    [accountId, userId]
  );
  const set = new Set();
  for (const r of rows) {
    set.add(fingerprint(accountId, r.date, r.amount, r.description));
  }
  return set;
}

// --- Вставка одной транзакции (без обновления баланса) ----------------------
// Баланс счёта обновляется отдельно при синхронизации счетов (sync-accounts),
// поэтому здесь баланс НЕ трогаем — иначе он задвоится.
async function insertTransaction(t) {
  await run(
    `INSERT INTO transactions
       (account_id, user_id, date, description, category, amount, type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      t.accountId,
      t.userId,
      t.date,
      t.description || '',
      t.category || 'Прочее',
      round(Number(t.amount) || 0),
      t.type || ((Number(t.amount) || 0) >= 0 ? 'income' : 'expense'),
    ]
  );
}

// --- Синхронизация одного счёта по одному подключению -----------------------
// connection — расшифрованное подключение (как из BankConnection.findByUserId).
// Возвращает { fetched, inserted, skipped }.
async function syncAccount(connection, account, userId) {
  const result = { fetched: 0, inserted: 0, skipped: 0 };

  let bankTransactions = [];
  try {
    bankTransactions = await bankApiService.getTransactions(
      connection.bank_id,
      connection,
      account.account_number
    );
  } catch (err) {
    // Пробрасываем выше, чтобы вызывающий учёл ошибку по этому счёту.
    throw err;
  }

  if (!Array.isArray(bankTransactions)) bankTransactions = [];
  result.fetched = bankTransactions.length;

  if (bankTransactions.length === 0) return result;

  // Грузим отпечатки один раз и дополняем их по мере вставки, чтобы внутри
  // одного прогона не задвоить идентичные записи из самого банковского ответа.
  const seen = await loadExistingFingerprints(account.id, userId);

  for (const tx of bankTransactions) {
    const fp = fingerprint(account.id, tx.date, tx.amount, tx.description);
    if (seen.has(fp)) {
      result.skipped += 1;
      continue;
    }
    await insertTransaction({
      accountId: account.id,
      userId,
      date: tx.date,
      description: tx.description,
      category: tx.category,
      amount: tx.amount,
      type: tx.type,
    });
    seen.add(fp);
    result.inserted += 1;
  }

  return result;
}

// --- Синхронизация всех подключений одного пользователя ---------------------
async function syncUser(userId, summary) {
  let connections = [];
  try {
    connections = await BankConnection.findByUserId(userId);
  } catch (err) {
    summary.errors.push({ userId, error: err.message });
    return;
  }

  if (!connections || connections.length === 0) return;

  summary.users += 1;

  // Счета пользователя грузим один раз.
  let accounts = [];
  try {
    accounts = await Account.findByUserId(userId);
  } catch (err) {
    summary.errors.push({ userId, error: err.message });
    return;
  }

  for (const connection of connections) {
    summary.connections += 1;
    const bankName = bankNameFor(connection.bank_id);

    // Счета, относящиеся к этому подключению. Сопоставляем по bank_name
    // (так же, как существующий маршрут sync-transactions). Если совпадений
    // нет — берём все счета пользователя как fallback (на случай, когда
    // bank_name не был проставлен).
    let targetAccounts = accounts.filter((a) => a.bank_name === bankName);
    if (targetAccounts.length === 0) {
      targetAccounts = accounts.filter((a) => a.account_number);
    }

    for (const account of targetAccounts) {
      if (!account.account_number) continue;
      summary.accounts += 1;
      try {
        const r = await syncAccount(connection, account, userId);
        summary.fetched += r.fetched;
        summary.inserted += r.inserted;
        summary.skipped += r.skipped;
      } catch (err) {
        summary.errors.push({
          userId,
          bankId: connection.bank_id,
          accountId: account.id,
          error: err.message,
        });
      }
    }
  }
}

// --- Один прогон синхронизации ----------------------------------------------
// userId опционален: если задан — синхронизируем только его, иначе всех
// пользователей, у которых есть активные банковские подключения.
async function runOnce(userId) {
  const summary = {
    users: 0,
    connections: 0,
    accounts: 0,
    fetched: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
    startedAt: new Date().toISOString(),
  };

  let userIds = [];
  if (userId !== undefined && userId !== null) {
    userIds = [userId];
  } else {
    // Все пользователи с активными подключениями.
    const rows = await query(
      `SELECT DISTINCT user_id FROM bank_connections WHERE is_active = 1`
    );
    userIds = rows.map((r) => r.user_id);
  }

  for (const uid of userIds) {
    await syncUser(uid, summary);
  }

  summary.finishedAt = new Date().toISOString();
  logger.info(
    {
      users: summary.users,
      connections: summary.connections,
      accounts: summary.accounts,
      inserted: summary.inserted,
      skipped: summary.skipped,
      errors: summary.errors.length,
    },
    'syncScheduler runOnce complete'
  );
  return summary;
}

// --- Запуск cron-расписания --------------------------------------------------
// Idempotent: повторный start() не плодит задачи.
function start() {
  if (task) return task;

  const schedule = process.env.SYNC_CRON || DEFAULT_CRON;
  if (!cron.validate(schedule)) {
    logger.warn({ schedule }, 'syncScheduler: invalid SYNC_CRON, using default');
  }
  const effective = cron.validate(schedule) ? schedule : DEFAULT_CRON;

  task = cron.schedule(effective, async () => {
    try {
      await runOnce();
    } catch (err) {
      logger.error({ err }, 'syncScheduler scheduled run failed');
    }
  });

  logger.info({ schedule: effective }, 'syncScheduler started');
  return task;
}

// --- Остановка cron-расписания ----------------------------------------------
function stop() {
  if (task) {
    try {
      task.stop();
    } catch (e) {
      /* ignore */
    }
    task = null;
    logger.info('syncScheduler stopped');
  }
}

// Текущее состояние (для маршрута /status).
function status() {
  return {
    enabled: isEnabled(),
    running: task !== null,
    schedule: process.env.SYNC_CRON || DEFAULT_CRON,
  };
}

module.exports = { start, stop, runOnce, status, isEnabled };
