const { query, get, run } = require('../db/database');
const crypto = require('crypto');

class Family {
  // Генерация кода приглашения
  static generateInviteCode() {
    return crypto.randomBytes(6).toString('hex').toUpperCase();
  }

  // Генерация токена приглашения
  static generateInviteToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  // Создание семьи
  static async create(familyData) {
    const { name, ownerId, description } = familyData;
    const inviteCode = this.generateInviteCode();

    const result = await run(
      `INSERT INTO families (name, owner_id, invite_code, description)
       VALUES (?, ?, ?, ?)`,
      [name, ownerId, inviteCode, description || null]
    );

    // Автоматически добавляем владельца как участника с ролью owner
    await run(
      `INSERT INTO family_members (family_id, user_id, role, nickname)
       VALUES (?, ?, 'owner', NULL)`,
      [result.id, ownerId]
    );

    return this.findById(result.id);
  }

  // Поиск по ID
  static async findById(id) {
    const family = await get(
      `SELECT f.*, u.username as owner_username, u.full_name as owner_name
       FROM families f
       JOIN users u ON f.owner_id = u.id
       WHERE f.id = ?`,
      [id]
    );

    if (family) {
      family.members = await this.getMembers(id);
    }

    return family;
  }

  // Получение семей пользователя
  static async findByUserId(userId) {
    const families = await query(
      `SELECT f.*, fm.role as my_role, u.username as owner_username
       FROM families f
       JOIN family_members fm ON f.id = fm.family_id
       JOIN users u ON f.owner_id = u.id
       WHERE fm.user_id = ? AND f.is_active = 1
       ORDER BY f.created_at DESC`,
      [userId]
    );

    // Получаем количество участников для каждой семьи
    for (const family of families) {
      const count = await get(
        `SELECT COUNT(*) as count FROM family_members WHERE family_id = ?`,
        [family.id]
      );
      family.member_count = count.count;
    }

    return families;
  }

  // Получение участников семьи
  static async getMembers(familyId) {
    return query(
      `SELECT fm.*, u.username, u.email, u.full_name
       FROM family_members fm
       JOIN users u ON fm.user_id = u.id
       WHERE fm.family_id = ?
       ORDER BY
         CASE fm.role
           WHEN 'owner' THEN 1
           WHEN 'admin' THEN 2
           ELSE 3
         END,
         fm.joined_at ASC`,
      [familyId]
    );
  }

  // Проверка, является ли пользователь участником семьи
  static async isMember(familyId, userId) {
    const member = await get(
      `SELECT id FROM family_members WHERE family_id = ? AND user_id = ?`,
      [familyId, userId]
    );
    return !!member;
  }

  // Получение роли пользователя в семье
  static async getUserRole(familyId, userId) {
    const member = await get(
      `SELECT role FROM family_members WHERE family_id = ? AND user_id = ?`,
      [familyId, userId]
    );
    return member ? member.role : null;
  }

  // Проверка прав (owner или admin)
  static async canManage(familyId, userId) {
    const role = await this.getUserRole(familyId, userId);
    return role === 'owner' || role === 'admin';
  }

  // Обновление семьи
  static async update(id, ownerId, updateData) {
    const { name, description } = updateData;

    // Проверяем, что пользователь - владелец
    const family = await get(
      `SELECT id FROM families WHERE id = ? AND owner_id = ?`,
      [id, ownerId]
    );

    if (!family) {
      return false;
    }

    const fields = [];
    const values = [];

    if (name !== undefined) {
      fields.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      fields.push('description = ?');
      values.push(description);
    }

    if (fields.length === 0) return true;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await run(
      `UPDATE families SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return true;
  }

  // Регенерация кода приглашения
  static async regenerateInviteCode(familyId, ownerId) {
    const canManage = await this.canManage(familyId, ownerId);
    if (!canManage) return null;

    const newCode = this.generateInviteCode();
    await run(
      `UPDATE families SET invite_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newCode, familyId]
    );

    return newCode;
  }

  // Присоединение по коду приглашения
  static async joinByCode(inviteCode, userId) {
    const family = await get(
      `SELECT id FROM families WHERE invite_code = ? AND is_active = 1`,
      [inviteCode.toUpperCase()]
    );

    if (!family) {
      return { success: false, message: 'Семья не найдена или код неверный' };
    }

    // Проверяем, не является ли уже участником
    const isMember = await this.isMember(family.id, userId);
    if (isMember) {
      return { success: false, message: 'Вы уже являетесь участником этой семьи' };
    }

    await run(
      `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'member')`,
      [family.id, userId]
    );

    return { success: true, familyId: family.id };
  }

  // Создание персонального приглашения
  static async createInvite(familyId, createdBy, email, role = 'member') {
    const canManage = await this.canManage(familyId, createdBy);
    if (!canManage) return null;

    const token = this.generateInviteToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 дней

    await run(
      `INSERT INTO family_invites (family_id, email, role, invite_token, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [familyId, email, role, token, expiresAt.toISOString(), createdBy]
    );

    return { token, expiresAt };
  }

  // Принятие приглашения по токену
  static async acceptInvite(token, userId) {
    const invite = await get(
      `SELECT * FROM family_invites
       WHERE invite_token = ? AND used_at IS NULL AND expires_at > datetime('now')`,
      [token]
    );

    if (!invite) {
      return { success: false, message: 'Приглашение не найдено или истекло' };
    }

    // Проверяем, не является ли уже участником
    const isMember = await this.isMember(invite.family_id, userId);
    if (isMember) {
      return { success: false, message: 'Вы уже являетесь участником этой семьи' };
    }

    // Добавляем участника
    await run(
      `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, ?)`,
      [invite.family_id, userId, invite.role]
    );

    // Помечаем приглашение как использованное
    await run(
      `UPDATE family_invites SET used_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [invite.id]
    );

    return { success: true, familyId: invite.family_id };
  }

  // Удаление участника
  static async removeMember(familyId, memberId, removedBy) {
    // Проверяем права
    const removerRole = await this.getUserRole(familyId, removedBy);
    const memberRole = await this.getUserRole(familyId, memberId);

    if (!removerRole || !memberRole) {
      return { success: false, message: 'Участник не найден' };
    }

    // Владельца нельзя удалить
    if (memberRole === 'owner') {
      return { success: false, message: 'Нельзя удалить владельца семьи' };
    }

    // Только owner и admin могут удалять
    if (removerRole !== 'owner' && removerRole !== 'admin') {
      return { success: false, message: 'Недостаточно прав' };
    }

    // Admin не может удалить другого admin
    if (removerRole === 'admin' && memberRole === 'admin') {
      return { success: false, message: 'Администратор не может удалить другого администратора' };
    }

    // Удаляем права доступа участника к счетам семьи
    await run(
      `DELETE FROM account_permissions WHERE user_id = ? AND account_id IN (
        SELECT a.id FROM accounts a
        JOIN family_members fm ON a.user_id = fm.user_id
        WHERE fm.family_id = ?
      )`,
      [memberId, familyId]
    );

    await run(
      `DELETE FROM family_members WHERE family_id = ? AND user_id = ?`,
      [familyId, memberId]
    );

    return { success: true };
  }

  // Изменение роли участника
  static async changeMemberRole(familyId, memberId, newRole, changedBy) {
    const changerRole = await this.getUserRole(familyId, changedBy);
    const currentRole = await this.getUserRole(familyId, memberId);

    if (!changerRole || !currentRole) {
      return { success: false, message: 'Участник не найден' };
    }

    // Только владелец может менять роли
    if (changerRole !== 'owner') {
      return { success: false, message: 'Только владелец может менять роли' };
    }

    // Нельзя изменить роль владельца
    if (currentRole === 'owner') {
      return { success: false, message: 'Нельзя изменить роль владельца' };
    }

    const validRoles = ['admin', 'member'];
    if (!validRoles.includes(newRole)) {
      return { success: false, message: 'Некорректная роль' };
    }

    await run(
      `UPDATE family_members SET role = ? WHERE family_id = ? AND user_id = ?`,
      [newRole, familyId, memberId]
    );

    return { success: true };
  }

  // Выход из семьи
  static async leave(familyId, userId) {
    const role = await this.getUserRole(familyId, userId);

    if (!role) {
      return { success: false, message: 'Вы не являетесь участником этой семьи' };
    }

    if (role === 'owner') {
      return { success: false, message: 'Владелец не может покинуть семью. Сначала передайте права или удалите семью.' };
    }

    // Удаляем права доступа
    await run(
      `DELETE FROM account_permissions WHERE user_id = ? AND granted_by IN (
        SELECT user_id FROM family_members WHERE family_id = ?
      )`,
      [userId, familyId]
    );

    await run(
      `DELETE FROM family_members WHERE family_id = ? AND user_id = ?`,
      [familyId, userId]
    );

    return { success: true };
  }

  // Передача владения
  static async transferOwnership(familyId, currentOwnerId, newOwnerId) {
    const family = await get(
      `SELECT id FROM families WHERE id = ? AND owner_id = ?`,
      [familyId, currentOwnerId]
    );

    if (!family) {
      return { success: false, message: 'Семья не найдена или вы не владелец' };
    }

    const isMember = await this.isMember(familyId, newOwnerId);
    if (!isMember) {
      return { success: false, message: 'Новый владелец должен быть участником семьи' };
    }

    // Обновляем владельца в families
    await run(
      `UPDATE families SET owner_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newOwnerId, familyId]
    );

    // Меняем роли
    await run(
      `UPDATE family_members SET role = 'admin' WHERE family_id = ? AND user_id = ?`,
      [familyId, currentOwnerId]
    );
    await run(
      `UPDATE family_members SET role = 'owner' WHERE family_id = ? AND user_id = ?`,
      [familyId, newOwnerId]
    );

    return { success: true };
  }

  // Удаление семьи
  static async delete(familyId, ownerId) {
    const family = await get(
      `SELECT id FROM families WHERE id = ? AND owner_id = ?`,
      [familyId, ownerId]
    );

    if (!family) {
      return false;
    }

    // Удаляем все связанные данные (каскадное удаление через FK)
    await run(`DELETE FROM account_permissions WHERE granted_by IN (
      SELECT user_id FROM family_members WHERE family_id = ?
    )`, [familyId]);
    await run(`DELETE FROM budget_permissions WHERE granted_by IN (
      SELECT user_id FROM family_members WHERE family_id = ?
    )`, [familyId]);
    await run(`DELETE FROM family_invites WHERE family_id = ?`, [familyId]);
    await run(`DELETE FROM family_members WHERE family_id = ?`, [familyId]);
    await run(`DELETE FROM families WHERE id = ?`, [familyId]);

    return true;
  }
}

module.exports = Family;
