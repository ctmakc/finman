// 010 — двойная запись переводов между счетами (ADDITIVE, idempotent).
// Добавляем колонку transactions.transfer_id: общий UUID для двух строк
// одного перевода (списание со счёта A + зачисление на счёт B). Тип строки —
// 'transfer', поэтому агрегаты income/expense (фильтр type IN ('income','expense'))
// её НЕ учитывают.
module.exports = {
  name: '010_transfers',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'transactions', 'transfer_id'))) {
      await db.run(`ALTER TABLE transactions ADD COLUMN transfer_id TEXT`);
    }
    // Индекс для быстрого поиска парной строки перевода (idempotent).
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_transactions_transfer ON transactions (transfer_id)`
    );
  },
};
