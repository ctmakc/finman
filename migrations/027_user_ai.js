// 027 — "Your AI": each person connects their own ChatGPT / Claude / Gemini / … key (ADDITIVE, idempotent).
//
// user_ai_keys      the person's API keys. key_enc = AES-256-GCM (config.encryptToken); the
//                   plain key never leaves the server and is never logged. key_hint = last 4.
// ai_agent_threads  conversations with the person's own AI (separate from the operator CFO chat).
// ai_agent_messages neutral transcript: role user | assistant | tool, content = JSON.
// ai_agent_actions  every tool call the model asked for. Read tools run at once (status auto);
//                   tools that change data wait for the person: pending -> done | declined | failed.
// Every table has user_id, so services/accountDeletion.js sweeps them with the account.
module.exports = {
  name: '027_user_ai',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS user_ai_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        key_enc TEXT NOT NULL,
        key_hint TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        base_url TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        last_used_at DATETIME,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_user_ai_keys_user ON user_ai_keys (user_id)');
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_id INTEGER,
        title TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_ai_agent_threads_user ON ai_agent_threads (user_id, updated_at)');
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES ai_agent_threads(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_thread ON ai_agent_messages (thread_id, id)');
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES ai_agent_threads(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      )
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_ai_agent_actions_msg ON ai_agent_actions (message_id, seq)');
  },
};
