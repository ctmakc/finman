// services/reconcileService.js — сверка счёта с банковской выпиской.
//
// Идея (как в Actual Budget): часть транзакций «проведена» в банковской
// выписке (cleared = 1), часть ещё нет (cleared = 0, например только что
// созданные вручную или ещё не отобразившиеся у банка). «Очищенный баланс»
// (cleared balance) = сумма всех проведённых транзакций счёта. Сравниваем его
// с балансом из выписки (statementBalance) и получаем delta — расхождение,
// которое пользователь либо объясняет (отметив ещё транзакции как cleared),
// либо закрывает балансирующей корректировкой (postAdjustment).
//
// Все деньги считаем через lib/money (float-safe, 2 знака). Любая запись,
// меняющая баланс счёта, идёт через Transaction.create (внутри transaction()).

const { query, get, run, transaction } = require('../db/database');
const money = require('../lib/money');
const Account = require('../models/account');
const Transaction = require('../models/transaction');

// Категория/описание для авто-корректировки сверки.
const ADJUST_CATEGORY = 'Корректировка сверки';

// Внутренний помощник: загрузить счёт пользователя или бросить понятную ошибку.
async function loadOwnedAccount(accountId, userId) {
  const account = await get(
    `SELECT * FROM accounts WHERE id = ? AND user_id = ?`,
    [accountId, userId]
  );
  return account || null;
}

// startReconcile — посчитать состояние сверки счёта против выписки.
//   accountId       — id счёта (должен принадлежать userId)
//   userId          — владелец
//   statementBalance — баланс по банковской выписке (число)
// Возвращает:
//   {
//     accountId, statementBalance,
//     clearedBalance,   // сумма проведённых (cleared) транзакций
//     unclearedTotal,   // сумма непроведённых транзакций
//     bookBalance,      // полный баланс счёта (cleared + uncleared)
//     delta,            // statementBalance - clearedBalance (что нужно закрыть)
//     reconciled,       // true если delta == 0
//     uncleared,        // [{...tx}] непроведённые транзакции
//     suspect           // [{...tx}] «подозрительные» (сумма == |delta|): вероятные
//                       //  кандидаты, отметка которых как cleared закроет расхождение
//   }
async function startReconcile(accountId, userId, statementBalance) {
  const account = await loadOwnedAccount(accountId, userId);
  if (!account) {
    const err = new Error('Account not found');
    err.code = 'ACCOUNT_NOT_FOUND';
    throw err;
  }

  const stmt = money.round(statementBalance);

  // Очищенный баланс = сумма проведённых транзакций.
  const clearedRow = await get(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
      WHERE account_id = ? AND user_id = ? AND cleared = 1`,
    [accountId, userId]
  );
  const clearedBalance = money.round(clearedRow ? clearedRow.total : 0);

  // Непроведённые транзакции (полные строки — пригодятся фронту).
  const uncleared = await query(
    `SELECT * FROM transactions
      WHERE account_id = ? AND user_id = ? AND cleared = 0
      ORDER BY date DESC, id DESC`,
    [accountId, userId]
  );
  const unclearedTotal = money.sum(uncleared.map((t) => t.amount));

  // Полный («книжный») баланс счёта по транзакциям.
  const bookBalance = money.add(clearedBalance, unclearedTotal);

  // Расхождение, которое нужно объяснить/закрыть.
  const delta = money.sub(stmt, clearedBalance);

  // «Подозрительные» транзакции: непроведённые, чья сумма в точности равна
  // расхождению — то есть пометка их как cleared точно закроет delta.
  const suspect = delta === 0
    ? []
    : uncleared.filter((t) => money.round(t.amount) === delta);

  return {
    accountId: Number(accountId),
    statementBalance: stmt,
    clearedBalance,
    unclearedTotal,
    bookBalance,
    delta,
    reconciled: delta === 0,
    uncleared,
    suspect,
  };
}

// markCleared — отметить транзакции как проведённые (cleared = 1).
//   txIds  — массив id транзакций
//   userId — владелец (страхуемся, что чужие транзакции не тронем)
// Баланс счёта НЕ меняется (cleared — только признак сверки, не движение денег).
// Возвращает { updated } — сколько строк реально обновлено.
async function markCleared(txIds, userId) {
  if (!Array.isArray(txIds) || txIds.length === 0) {
    return { updated: 0 };
  }
  // Только валидные целочисленные id.
  const ids = txIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) {
    return { updated: 0 };
  }

  const placeholders = ids.map(() => '?').join(',');
  const result = await run(
    `UPDATE transactions
        SET cleared = 1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id IN (${placeholders})`,
    [userId, ...ids]
  );
  return { updated: result.changes };
}

// markUncleared — снять отметку «проведено» (обратная операция, ADDITIVE-удобство).
async function markUncleared(txIds, userId) {
  if (!Array.isArray(txIds) || txIds.length === 0) {
    return { updated: 0 };
  }
  const ids = txIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) {
    return { updated: 0 };
  }
  const placeholders = ids.map(() => '?').join(',');
  const result = await run(
    `UPDATE transactions
        SET cleared = 0, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id IN (${placeholders})`,
    [userId, ...ids]
  );
  return { updated: result.changes };
}

// postAdjustment — создать балансирующую транзакцию на величину delta, чтобы
// очищенный баланс счёта сошёлся с выпиской. Транзакция создаётся сразу
// проведённой (cleared = 1) — она и есть «выписочная» корректировка.
//   accountId — счёт (владелец userId)
//   userId    — владелец
//   delta     — на сколько скорректировать (positive => income, negative => expense)
// Возвращает созданную транзакцию { id, amount, type, ... } или null если delta == 0.
async function postAdjustment(accountId, userId, delta) {
  const account = await loadOwnedAccount(accountId, userId);
  if (!account) {
    const err = new Error('Account not found');
    err.code = 'ACCOUNT_NOT_FOUND';
    throw err;
  }

  const amount = money.round(delta);
  if (amount === 0) {
    return null; // нечего корректировать — баланс уже сходится
  }

  // Создаём через единый transaction()-путь: вставка + атомарное обновление
  // баланса в одном BEGIN..COMMIT. Затем помечаем как cleared (та же
  // сериализованная очередь, отдельным UPDATE — баланс не трогаем).
  const created = await transaction(async () => {
    const result = await run(
      `INSERT INTO transactions
         (account_id, user_id, date, description, category, amount, type, cleared)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        accountId,
        userId,
        new Date().toISOString().split('T')[0],
        'Корректировка по результатам сверки',
        ADJUST_CATEGORY,
        amount,
        amount >= 0 ? 'income' : 'expense',
      ]
    );
    await Account.updateBalance(accountId, userId, amount);
    return {
      id: result.id,
      accountId: Number(accountId),
      userId,
      amount,
      type: amount >= 0 ? 'income' : 'expense',
      category: ADJUST_CATEGORY,
      cleared: 1,
    };
  });

  return created;
}

module.exports = {
  startReconcile,
  markCleared,
  markUncleared,
  postAdjustment,
  ADJUST_CATEGORY,
  // Экспортируем Transaction, чтобы downstream при желании мог переиспользовать
  // тот же путь создания (не используется напрямую здесь после inline-insert).
  _Transaction: Transaction,
};
