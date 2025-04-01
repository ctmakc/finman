const { query, get, run } = require('../db/database');

class BankConnection {
  // Создание или обновление подключения к банку
  static async createOrUpdate(connectionData) {
    try {
      // Проверить, существует ли уже подключение
      const existingConnection = await get(
        `SELECT * FROM bank_connections 
         WHERE user_id = ? AND bank_id = ?`,
        [connectionData.userId, connectionData.bankId]
      );
      
      if (existingConnection) {
        // Обновить существующее подключение
        await run(
          `UPDATE bank_connections 
           SET access_token = ?, 
               refresh_token = ?, 
               expires_at = ?, 
               account_ids = ?,
               is_active = 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            connectionData.accessToken,
            connectionData.refreshToken || null,
            connectionData.expiresAt || null,
            JSON.stringify(connectionData.accountIds || []),
            existingConnection.id
          ]
        );
        
        return { ...existingConnection, ...connectionData, id: existingConnection.id };
      } else {
        // Создать новое подключение
        const result = await run(
          `INSERT INTO bank_connections 
           (user_id, bank_id, access_token, refresh_token, expires_at, account_ids)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            connectionData.userId,
            connectionData.bankId,
            connectionData.accessToken,
            connectionData.refreshToken || null,
            connectionData.expiresAt || null,
            JSON.stringify(connectionData.accountIds || [])
          ]
        );
        
        return { id: result.id, ...connectionData };
      }
    } catch (error) {
      throw error;
    }
  }
  
  // Получение всех банковских подключений пользователя
  static async findByUserId(userId) {
    try {
      const connections = await query(
        `SELECT * FROM bank_connections WHERE user_id = ? AND is_active = 1`,
        [userId]
      );
      
      // Преобразование JSON строки account_ids обратно в массив
      return connections.map(conn => ({
        ...conn,
        accountIds: JSON.parse(conn.account_ids || '[]')
      }));
    } catch (error) {
      throw error;
    }
  }
  
  // Получение подключения по ID банка
  static async findByBankId(userId, bankId) {
    try {
      const connection = await get(
        `SELECT * FROM bank_connections 
         WHERE user_id = ? AND bank_id = ? AND is_active = 1`,
        [userId, bankId]
      );
      
      if (connection) {
        connection.accountIds = JSON.parse(connection.account_ids || '[]');
      }
      
      return connection;
    } catch (error) {
      throw error;
    }
  }
  
  // Получение подключения по ID
  static async findById(id, userId) {
    try {
      const connection = await get(
        `SELECT * FROM bank_connections WHERE id = ? AND user_id = ?`,
        [id, userId]
      );
      
      if (connection) {
        connection.accountIds = JSON.parse(connection.account_ids || '[]');
      }
      
      return connection;
    } catch (error) {
      throw error;
    }
  }
  
  // Обновление токенов
  static async updateTokens(id, userId, tokenData) {
    try {
      const result = await run(
        `UPDATE bank_connections 
         SET access_token = ?, 
             refresh_token = ?, 
             expires_at = ?, 
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [
          tokenData.accessToken,
          tokenData.refreshToken || null,
          tokenData.expiresAt || null,
          id,
          userId
        ]
      );
      
      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }
  
  // Деактивация подключения
  static async deactivate(id, userId) {
    try {
      const result = await run(
        `UPDATE bank_connections 
         SET is_active = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [id, userId]
      );
      
      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = BankConnection;