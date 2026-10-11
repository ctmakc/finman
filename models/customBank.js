const { query, get, run } = require('../db/database');

class CustomBank {
  // Создание кастомного банка
  static async create(bankData) {
    try {
      const bankKey = this.generateBankKey(bankData.name);

      const result = await run(
        `INSERT INTO custom_banks
         (user_id, bank_key, name, country, api_url, auth_type, scopes, endpoints, token_instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bankData.userId,
          bankKey,
          bankData.name,
          bankData.country,
          bankData.apiUrl,
          bankData.authType || 'api_key',
          JSON.stringify(bankData.scopes || ['accounts', 'transactions']),
          JSON.stringify(bankData.endpoints || {}),
          bankData.tokenInstructions || ''
        ]
      );

      return { id: result.id, bank_key: bankKey, ...bankData };
    } catch (error) {
      if (error.message.includes('UNIQUE constraint')) {
        throw new Error('A bank with this name already exists');
      }
      throw error;
    }
  }

  // Генерация уникального ключа для банка
  static generateBankKey(name) {
    return 'custom_' + name
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]/gi, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30);
  }

  // Получение всех кастомных банков пользователя
  static async findByUserId(userId) {
    try {
      const banks = await query(
        `SELECT * FROM custom_banks WHERE user_id = ? AND is_active = 1 ORDER BY name`,
        [userId]
      );

      return banks.map(bank => this.formatBank(bank));
    } catch (error) {
      throw error;
    }
  }

  // Получение кастомного банка по ID
  static async findById(id, userId) {
    try {
      const bank = await get(
        `SELECT * FROM custom_banks WHERE id = ? AND user_id = ? AND is_active = 1`,
        [id, userId]
      );

      return bank ? this.formatBank(bank) : null;
    } catch (error) {
      throw error;
    }
  }

  // Получение кастомного банка по ключу
  static async findByKey(bankKey, userId) {
    try {
      const bank = await get(
        `SELECT * FROM custom_banks WHERE bank_key = ? AND user_id = ? AND is_active = 1`,
        [bankKey, userId]
      );

      return bank ? this.formatBank(bank) : null;
    } catch (error) {
      throw error;
    }
  }

  // Форматирование банка для API
  static formatBank(bank) {
    return {
      id: bank.id,
      bankKey: bank.bank_key,
      name: bank.name,
      country: bank.country,
      apiUrl: bank.api_url,
      authType: bank.auth_type,
      scopes: this.safeParseJSON(bank.scopes, ['accounts', 'transactions']),
      endpoints: this.safeParseJSON(bank.endpoints, {}),
      tokenInstructions: bank.token_instructions,
      isCustom: true,
      region: 'custom',
      createdAt: bank.created_at
    };
  }

  // Преобразование в формат конфига банка
  static toConfigFormat(bank) {
    const formatted = this.formatBank(bank);
    return {
      name: formatted.name,
      country: formatted.country,
      region: 'custom',
      apiUrl: formatted.apiUrl,
      authType: formatted.authType,
      scopes: formatted.scopes,
      endpoints: formatted.endpoints,
      tokenInstructions: formatted.tokenInstructions,
      requiresRedirect: formatted.authType === 'oauth2',
      isCustom: true
    };
  }

  // Безопасный парсинг JSON
  static safeParseJSON(str, defaultValue = []) {
    try {
      return JSON.parse(str || JSON.stringify(defaultValue));
    } catch {
      return defaultValue;
    }
  }

  // Обновление кастомного банка
  static async update(id, userId, bankData) {
    try {
      const updates = [];
      const params = [];

      if (bankData.name !== undefined) {
        updates.push('name = ?');
        params.push(bankData.name);
      }
      if (bankData.country !== undefined) {
        updates.push('country = ?');
        params.push(bankData.country);
      }
      if (bankData.apiUrl !== undefined) {
        updates.push('api_url = ?');
        params.push(bankData.apiUrl);
      }
      if (bankData.authType !== undefined) {
        updates.push('auth_type = ?');
        params.push(bankData.authType);
      }
      if (bankData.scopes !== undefined) {
        updates.push('scopes = ?');
        params.push(JSON.stringify(bankData.scopes));
      }
      if (bankData.endpoints !== undefined) {
        updates.push('endpoints = ?');
        params.push(JSON.stringify(bankData.endpoints));
      }
      if (bankData.tokenInstructions !== undefined) {
        updates.push('token_instructions = ?');
        params.push(bankData.tokenInstructions);
      }

      if (updates.length === 0) {
        return false;
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id, userId);

      const result = await run(
        `UPDATE custom_banks SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
        params
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Удаление (деактивация) кастомного банка
  static async delete(id, userId) {
    try {
      const result = await run(
        `UPDATE custom_banks
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

module.exports = CustomBank;
