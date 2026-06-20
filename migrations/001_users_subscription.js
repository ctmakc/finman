// 001 — добавляем поля подписки/Stripe в таблицу users (ADDITIVE, idempotent).
module.exports = {
  name: '001_users_subscription',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'users', 'subscription_tier'))) {
      await db.run(`ALTER TABLE users ADD COLUMN subscription_tier TEXT DEFAULT 'free'`);
    }
    if (!(await columnExists(db, 'users', 'stripe_customer_id'))) {
      await db.run(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`);
    }
    if (!(await columnExists(db, 'users', 'stripe_subscription_id'))) {
      await db.run(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`);
    }
    // На случай, если колонка уже существовала, но без значения по умолчанию.
    await db.run(`UPDATE users SET subscription_tier = 'free' WHERE subscription_tier IS NULL`);
  },
};
