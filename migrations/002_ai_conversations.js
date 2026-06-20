// 002 — таблицы AI-ассистента (диалоги + сообщения).
module.exports = {
  name: '002_ai_conversations',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES ai_conversations (id) ON DELETE CASCADE
      )
    `);

    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages (conversation_id)`
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations (user_id)`
    );
  },
};
