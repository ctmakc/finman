// 017a_google_columns — колонки для входа через Google (PORT_PLAN A3).
//
// users.google_id  — идентификатор Google-аккаунта (sub), уникален среди
//                    заполненных строк;
// users.avatar_url — ссылка на аватар из Google-профиля.
//
// Прод-линейка (app.finman.money) добавляла эти колонки ad-hoc ALTER'ами с
// проглатыванием «duplicate column»; здесь — через columnExists, так что
// миграция безопасна и на свежей БД, и на копии прода, и рядом с 017
// (инфраструктурная миграция той же волны добавляет те же колонки под
// такими же гардами — интегратор дедуплицирует).
module.exports = {
  name: '017a_google_columns',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'users', 'google_id'))) {
      await db.run('ALTER TABLE users ADD COLUMN google_id TEXT');
    }
    if (!(await columnExists(db, 'users', 'avatar_url'))) {
      await db.run('ALTER TABLE users ADD COLUMN avatar_url TEXT');
    }
    // Частичный уникальный индекс: NULL-строки (обычные пользователи) не конфликтуют.
    await db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL'
    );
  },
};
