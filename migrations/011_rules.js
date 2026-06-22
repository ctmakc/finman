// 011 — таблица детерминированных правил категоризации транзакций.
// ADDITIVE, идемпотентно (CREATE TABLE IF NOT EXISTS).
// Правило: для расходных транзакций пользователя, если поле match_field
// удовлетворяет оператору match_op со значением match_value — выставить
// категорию set_category. Применяются в порядке priority (меньше = раньше).
module.exports = {
  name: '011_rules',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS category_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        match_field TEXT NOT NULL DEFAULT 'description',
        match_op TEXT NOT NULL DEFAULT 'contains',
        match_value TEXT NOT NULL,
        set_category TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_category_rules_user
         ON category_rules (user_id, priority)`
    );
  },
};
