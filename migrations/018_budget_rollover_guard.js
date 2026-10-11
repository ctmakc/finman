// 018 — budgets.last_rolled_period (ADDITIVE, idempotent).
//
// Envelope roll-forward (models/budget.js rollForward) closes the PREVIOUS
// period of a rollover budget: carryover += amount + carryover - spent(prev).
// last_rolled_period stores the start date ('YYYY-MM-DD') of the last period
// that was rolled, so a second call in the same period changes nothing
// (it used to add the carryover again: 300 -> 600).
module.exports = {
  name: '018_budget_rollover_guard',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'budgets', 'last_rolled_period'))) {
      await db.run(`ALTER TABLE budgets ADD COLUMN last_rolled_period TEXT`);
    }
  },
};
