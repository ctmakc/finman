const { query } = require('../db/database');

// The organization is the tenant boundary. Every member of an org shares the
// org's financial data. `user_id` on each row is retained purely for
// attribution (who created it), never as the isolation boundary.

async function getMemberIds(orgId) {
  if (!orgId) {
    throw new Error('orgScope: orgId required (refusing to silently scope to a single user)');
  }
  const rows = await query(
    `SELECT user_id FROM organization_members WHERE org_id = ?`,
    [orgId]
  );
  return rows.map((r) => r.user_id);
}

// Accepts the authenticated `req.user` ({ id, orgId }) for org-scoped access,
// or a bare numeric user id from not-yet-migrated callers (own-data-only —
// safe, never a cross-tenant leak, just not org-shared yet).
async function scopeUserIds(principal) {
  if (typeof principal === 'number') {
    return [principal];
  }
  if (principal && principal.orgId) {
    return getMemberIds(principal.orgId);
  }
  if (principal && principal.id) {
    return [principal.id];
  }
  throw new Error('orgScope: invalid principal (need { id } or { orgId })');
}

function placeholders(n) {
  return Array(Math.max(n, 1)).fill('?').join(',');
}

// True if `ownerUserId` belongs to the principal's scope (own id or org).
// Used by by-id routes whose authorization gate is `row.user_id !== me`.
async function inScope(ownerUserId, principal) {
  const ids = await scopeUserIds(principal);
  return ids.includes(ownerUserId);
}

// True if two users are members of at least one common organization.
// Needs only the two user ids — no principal/orgId — so it slots into
// existing permission checks without signature changes.
async function shareOrg(userIdA, userIdB) {
  if (userIdA === userIdB) return true;
  const row = await query(
    `SELECT 1 AS ok
       FROM organization_members a
       JOIN organization_members b ON a.org_id = b.org_id
      WHERE a.user_id = ? AND b.user_id = ?
      LIMIT 1`,
    [userIdA, userIdB]
  );
  return row.length > 0;
}

module.exports = { getMemberIds, scopeUserIds, placeholders, inScope, shareOrg };
