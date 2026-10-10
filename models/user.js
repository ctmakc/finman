const { query, get, run } = require('../db/database');
const bcrypt = require('bcrypt');

class User {
  // Создание пользователя
  static async create(userData) {
    try {
      // Хеширование пароля
      const hashedPassword = await bcrypt.hash(userData.password, 12);
      
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
    const crypto = require('crypto');
    const unusable = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 12);

    let base = (email || '').split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '') || 'user';
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

  // Поиск пользователя по ID
  static async findById(id) {
    try {
      const user = await get(
        `SELECT id, username, email, full_name, created_at, updated_at 
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
  
  // Поиск пользователя по email
  static async findByEmail(email) {
    try {
      const user = await get(
        `SELECT * FROM users WHERE email = ?`,
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
        const hashedPassword = await bcrypt.hash(userData.password, 12);
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
  