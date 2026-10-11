const { query, get, run } = require('../db/database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const config = require('../config/config');

// Стоимость bcrypt берём из config (BCRYPT_ROUNDS, по умолчанию 12).
function bcryptRounds() {
  return config.bcryptRounds || 12;
}

class User {
  // Создание пользователя
  static async create(userData) {
    try {
      // Хеширование пароля
      const hashedPassword = await bcrypt.hash(userData.password, bcryptRounds());
      
      const result = await run(
        `INSERT INTO users (username, email, password, full_name) 
         VALUES (?, ?, ?, ?)`,
        [userData.username, userData.email, hashedPassword, userData.fullName || '']
      );
      
      return { id: result.id, ...userData, password: undefined };
    } catch (error) {
      throw error;
    }
  }
  
  // Поиск пользователя по ID
  static async findById(id) {
    try {
      const user = await get(
        `SELECT id, username, email, full_name, created_at, updated_at,
                subscription_tier, stripe_customer_id, stripe_subscription_id, timezone,
                google_id, avatar_url
         FROM users WHERE id = ?`,
        [id]
      );
      
      return user;
    } catch (error) {
      throw error;
    }
  }
  
  // Поиск пользователя по имени пользователя
  static async findByUsername(username) {
    try {
      const user = await get(
        `SELECT * FROM users WHERE username = ?`,
        [username]
      );
      
      return user;
    } catch (error) {
      throw error;
    }
  }
  
  // Поиск по Google-идентификатору
  static async findByGoogleId(googleId) {
    try {
      return await get('SELECT * FROM users WHERE google_id = ?', [googleId]);
    } catch (error) {
      throw error;
    }
  }

  // Создание пользователя из Google-профиля.
  // Пароль заполняется недостижимым случайным хешем: колонка NOT NULL,
  // но войти по паролю в такой аккаунт нельзя — сравнение никогда не совпадёт.
  static async createFromGoogle({ googleId, email, fullName, avatarUrl }) {
    const unusable = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), bcryptRounds());

    const base = (email || '').split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '') || 'user';
    let username = base;
    for (let i = 0; i < 50; i++) {
      const clash = await get('SELECT id FROM users WHERE username = ?', [username]);
      if (!clash) break;
      username = base + '-' + crypto.randomBytes(2).toString('hex');
    }

    const result = await run(
      `INSERT INTO users (username, email, password, full_name, google_id, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [username, email, unusable, fullName || '', googleId, avatarUrl || null]
    );
    return { id: result.id, username, email, fullName, googleId };
  }

  // Привязка Google-аккаунта к существующему пользователю с тем же email
  static async linkGoogle(userId, googleId, avatarUrl) {
    await run('UPDATE users SET google_id = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
      [googleId, avatarUrl || null, userId]);
  }

  // Поиск пользователя по email. Регистр не учитываем: /register хранит email
  // как ввели, а Google отдаёт его в нижнем регистре — иначе вход через Google
  // создавал бы второй аккаунт на тот же адрес вместо привязки.
  static async findByEmail(email) {
    try {
      const user = await get(
        `SELECT * FROM users WHERE email = ? COLLATE NOCASE`,
        [email]
      );
      
      return user;
    } catch (error) {
      throw error;
    }
  }
  
  // Обновление данных пользователя
  static async update(id, userData) {
    try {
      let updateFields = [];
      let params = [];
      
      if (userData.email) {
        updateFields.push('email = ?');
        params.push(userData.email);
      }
      
      if (userData.fullName) {
        updateFields.push('full_name = ?');
        params.push(userData.fullName);
      }
      
      if (userData.password) {
        const hashedPassword = await bcrypt.hash(userData.password, bcryptRounds());
        updateFields.push('password = ?');
        params.push(hashedPassword);
      }
      
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      
      const result = await run(
        `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
        params
      );
      
      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }
  
  // AI opt-in (migration 017e). Until the user uses/enables AI, nothing about their
  // finances is sent to the AI provider. Missing column (pre-017e DB) reads as opted out.
  static async getAiOptIn(id) {
    try {
      const row = await get(`SELECT ai_opt_in FROM users WHERE id = ?`, [id]);
      return Boolean(row && Number(row.ai_opt_in) === 1);
    } catch (_) {
      return false;
    }
  }

  static async setAiOptIn(id, enabled) {
    const value = enabled ? 1 : 0;
    const result = await run(`UPDATE users SET ai_opt_in = ? WHERE id = ? AND ai_opt_in IS NOT ?`, [value, id, value]);
    return result.changes > 0;
  }

  // Проверка пароля
  static async verifyPassword(user, password) {
    try {
      return await bcrypt.compare(password, user.password);
    } catch (error) {
      throw error;
    }
  }
}

module.exports = User;
  