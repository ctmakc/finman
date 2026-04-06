const { query, get, run } = require('../db/database');
const crypto = require('crypto');

class Organization {
  static async create({ name, ownerId }) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      + '-' + crypto.randomBytes(3).toString('hex');
    const org = await run(`INSERT INTO organizations (name, slug) VALUES (?, ?)`, [name, slug]);
    await run(`INSERT INTO organization_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, [org.id, ownerId]);
    await run(`UPDATE users SET org_id = ? WHERE id = ?`, [org.id, ownerId]);
    return { id: org.id, name, slug, plan: 'free', role: 'owner' };
  }

  static async findById(orgId) {
    return get(`SELECT * FROM organizations WHERE id = ?`, [orgId]);
  }

  static async getMembers(orgId) {
    return query(
      `SELECT u.id, u.username, u.email, u.full_name, om.role, om.created_at
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? ORDER BY om.created_at ASC`,
      [orgId]
    );
  }

  static async getMemberRole(orgId, userId) {
    const row = await get(
      `SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?`,
      [orgId, userId]
    );
    return row ? row.role : null;
  }

  static async removeMember(orgId, userId) {
    return run(
      `DELETE FROM organization_members WHERE org_id = ? AND user_id = ? AND role != 'owner'`,
      [orgId, userId]
    );
  }

  static async createInvite({ orgId, email, role = 'member' }) {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await run(
      `INSERT INTO invites (org_id, email, token, role, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [orgId, email, token, role, expiresAt]
    );
    return token;
  }

  static async findInvite(token) {
    return get(
      `SELECT * FROM invites WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')`,
      [token]
    );
  }

  static async useInvite(token, userId) {
    const invite = await this.findInvite(token);
    if (!invite) throw new Error('Invalid or expired invite');
    await run(
      `INSERT OR IGNORE INTO organization_members (org_id, user_id, role) VALUES (?, ?, ?)`,
      [invite.org_id, userId, invite.role]
    );
    await run(`UPDATE users SET org_id = ? WHERE id = ?`, [invite.org_id, userId]);
    await run(`UPDATE invites SET used_at = datetime('now') WHERE token = ?`, [token]);
    return invite;
  }

  static async update(orgId, fields) {
    const allowed = ['name', 'plan', 'ai_provider', 'ai_model'];
    const updates = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== undefined);
    if (updates.length === 0) return;
    const sql = `UPDATE organizations SET ${updates.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`;
    return run(sql, [...updates.map(k => fields[k]), orgId]);
  }
}

module.exports = Organization;
