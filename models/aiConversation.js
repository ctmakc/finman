// ==================== МОДЕЛЬ AI-РАЗГОВОРОВ (CFO) ====================
// Хранит беседы пользователя с ИИ-финансовым директором и их сообщения.
// Таблицы созданы миграцией 002_ai_conversations:
//   ai_conversations(id, user_id, title, created_at)
//   ai_messages(id, conversation_id, role, content, created_at)
//
// Все методы используют общие db-хелперы (параметризованные запросы).

const { query, get, run } = require('../db/database');

const AiConversation = {
  // Создать новый разговор для пользователя.
  async create(userId, title = null) {
    const result = await run(
      `INSERT INTO ai_conversations (user_id, title) VALUES (?, ?)`,
      [userId, title || 'New conversation']
    );
    return this.findById(result.id);
  },

  // Получить разговор по ID.
  async findById(id) {
    return get('SELECT * FROM ai_conversations WHERE id = ?', [id]);
  },

  // Все разговоры пользователя (свежие сверху).
  async findByUser(userId) {
    return query(
      'SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
  },

  // Загрузчик ресурса для requireOwnership: -> { user_id } | null.
  async loadForOwnership(req) {
    const id = req.body && req.body.conversationId;
    if (!id) return null;
    return get('SELECT user_id FROM ai_conversations WHERE id = ?', [id]);
  },

  // Обновить заголовок (например, по первому сообщению пользователя).
  async setTitle(id, title) {
    await run('UPDATE ai_conversations SET title = ? WHERE id = ?', [title, id]);
    return this.findById(id);
  },

  // Добавить сообщение в разговор. role in {'user','assistant','system'}.
  async addMessage(conversationId, role, content) {
    const result = await run(
      `INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, ?, ?)`,
      [conversationId, role, content]
    );
    return get('SELECT * FROM ai_messages WHERE id = ?', [result.id]);
  },

  // Получить все сообщения разговора (хронологически).
  async getMessages(conversationId) {
    return query(
      'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC',
      [conversationId]
    );
  },

  // Получить разговор вместе с его сообщениями.
  async getWithMessages(conversationId) {
    const conversation = await this.findById(conversationId);
    if (!conversation) return null;
    const messages = await this.getMessages(conversationId);
    return { ...conversation, messages };
  },
};

module.exports = AiConversation;
