// 017c — часовой пояс пользователя (ADDITIVE, idempotent).
//
// users.timezone хранит IANA-зону ('America/Toronto'). Дефолт колонки — литерал
// (SQLite требует константу в ADD COLUMN DEFAULT); существующие строки и NULL
// добиваются значением из env DEFAULT_TZ (lib/dates.js использует тот же дефолт,
// когда у пользователя зона не задана).
module.exports = {
  name: '017c_user_timezone',
  async up(db, { columnExists }) {
    const defaultTz = process.env.DEFAULT_TZ || 'America/Toronto';
    if (!(await columnExists(db, 'users', 'timezone'))) {
      await db.run(`ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'America/Toronto'`);
    }
    await db.run(`UPDATE users SET timezone = ? WHERE timezone IS NULL OR timezone = ''`, [defaultTz]);
  },
};
