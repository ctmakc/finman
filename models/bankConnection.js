const { query, get, run } = require('../db/database');
const { encryptToken, decryptToken } = require('../config/config');

class BankConnection {
  // Шифрование токенов перед сохранением
  static encryptTokens(data) {
    return {
      ...data,
      accessToken: data.accessToken ? encryptToken(data.accessToken) : null,
      refreshToken: data.refreshToken ? encryptToken(data.refreshToken) : null
    };
  }

  // Расшифровка токенов после получения
  static decryptTokens(connection) {
    if (!connection) return null;
    try {
      return {
        ...connection,
        access_token: connection.access_token ? decryptToken(connection.access_token) : null,
        refresh_token: connection.refresh_token ? decryptToken(connection.refresh_token) : null
      };
    } catch (error) {
      // Do NOT fall back to the still-encrypted connection: callers would
      // use ciphertext as a bearer token, producing silent auth failures
      // that mask key/IV corruption. Fail loudly so callers skip it.
      console.error('Token decryption failed for connection', connection.id, '-', error.message);
      throw new Error(`Bank connection ${connection.id} token decryption failed`);
    }
  }

  // Создание или обновление подключения к банку
  static async createOrUpdate(connectionData) {
    try {
      // Шифруем токены
      const encrypted = this.encryptTokens(connectionData);

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
            encrypted.accessToken,
            encrypted.refreshToken || null,
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
            encrypted.accessToken,
            encrypted.refreshToken || null,
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
  
  // Безопасный парсинг JSON
  static safeParseJSON(str, defaultValue = []) {
    try {
      return JSON.parse(str || JSON.stringify(defaultValue));
    } catch {
      return defaultValue;
    }
  }

  // Получение всех банковских подключений пользователя
  static async findByUserId(userId) {
    try {
      const connections = await query(
        `SELECT * FROM bank_connections WHERE user_id = ? AND is_active = 1`,
        [userId]
      );

      // Decrypt + parse. A single undecryptable row must not break the whole
      // list nor leak ciphertext downstream — skip it (logged in decryptTokens).
      const result = [];
      for (const conn of connections) {
        try {
          const decrypted = this.decryptTokens(conn);
          result.push({
            ...decrypted,
            accountIds: this.safeParseJSON(conn.account_ids, [])
          });
        } catch (_) {
          /* broken connection excluded; error already logged */
        }
      }
      return result;
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
        const decrypted = this.decryptTokens(connection);
        decrypted.accountIds = this.safeParseJSON(connection.account_ids, []);
        return decrypted;
      }

      return null;
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
        const decrypted = this.decryptTokens(connection);
        decrypted.accountIds = this.safeParseJSON(connection.account_ids, []);
        return decrypted;
      }

      return null;
    } catch (error) {
      throw error;
    }
  }
  
  // Обновление токенов
  static async updateTokens(id, userId, tokenData) {
    try {
      // Шифруем токены перед сохранением
      const encrypted = this.encryptTokens(tokenData);

      const result = await run(
        `UPDATE bank_connections
         SET access_token = ?,
             refresh_token = ?,
             expires_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [
          encrypted.accessToken,
          encrypted.refreshToken || null,
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