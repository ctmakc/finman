// 012 — сверка счёта с банковской выпиской (account reconciliation).
// ADDITIVE, идемпотентно: добавляем флаг transactions.cleared (проведено в
// выписке), по умолчанию 0. Никаких удалений/переименований — только новая
// колонка с guard через columnExists.
module.exports = {
  name: '012_reconcile',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'transactions', 'cleared'))) {
      await db.run(`ALTER TABLE transactions ADD COLUMN cleared BOOLEAN DEFAULT 0`);
    }
    // На случай, если колонка уже была, но с NULL — нормализуем к 0.
    await db.run(`UPDATE transactions SET cleared = 0 WHERE cleared IS NULL`);
  },
};
