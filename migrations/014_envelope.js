// 014 — envelope / rollover budgeting (ADDITIVE, idempotent).
// Добавляем в budgets два поля:
//   rollover  — флаг «конвертного» бюджета: остаток переносится в след. период;
//   carryover — накопленный перенос (может быть отрицательным при перерасходе).
// effectiveLimit = amount + carryover (считается в модели через lib/money).
module.exports = {
  name: '014_envelope',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'budgets', 'rollover'))) {
      await db.run(`ALTER TABLE budgets ADD COLUMN rollover BOOLEAN DEFAULT 0`);
    }
    if (!(await columnExists(db, 'budgets', 'carryover'))) {
      await db.run(`ALTER TABLE budgets ADD COLUMN carryover REAL DEFAULT 0`);
    }
    // На случай, если колонки уже существовали, но без значения по умолчанию.
    await db.run(`UPDATE budgets SET rollover = 0 WHERE rollover IS NULL`);
    await db.run(`UPDATE budgets SET carryover = 0 WHERE carryover IS NULL`);
  },
};
