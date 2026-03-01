'use strict';

const db     = require('../config/database');
const logger = require('../utils/logger');

/**
 * Load all roles for a user in one query.
 * Returns: [{ group_id, group_name, access_level, has_owner_restriction }]
 */
async function getUserRoles(userId) {
  const { rows } = await db.query(
    `SELECT ugr.group_id, gp.name AS group_name, ugr.access_level,
            gp.has_owner_restriction
     FROM user_group_roles ugr
     JOIN group_profiles gp ON gp.id = ugr.group_id
     WHERE ugr.user_id = $1 AND gp.is_active = TRUE`,
    [userId]
  );
  return rows;
}

/**
 * Check if a user can READ a specific document.
 * Rules:
 *   1. Admin → always
 *   2. Active workflow task assigned to user → temporary access
 *   3. User has any role (read OR full) for the document's group
 *      AND if group has owner_restriction → user must be owner
 */
async function canRead(userId, document) {
  if (!document) return false;

  // 1. Admin check (caller should inject this from req.user)
  const { rows: userRows } = await db.query(
    'SELECT is_admin FROM users WHERE id = $1 AND is_active = TRUE', [userId]
  );
  if (!userRows.length) return false;
  if (userRows[0].is_admin) return true;

  // 2. Active workflow task
  const { rows: taskRows } = await db.query(
    `SELECT id FROM workflow_tasks
     WHERE document_id = $1 AND assigned_to = $2
       AND task_status IN ('pending','in_progress')`,
    [document.id, userId]
  );
  if (taskRows.length > 0) return true;

  // 3. Group role
  const roles = await getUserRoles(userId);
  const role  = roles.find(r => r.group_id === document.group_id);
  if (!role) return false;
  if (role.has_owner_restriction && document.owner_id !== userId) return false;

  return true;
}

/**
 * Check if a user can perform FULL access operations (edit/delete/download).
 */
async function canFull(userId, document) {
  if (!document) return false;

  const { rows: userRows } = await db.query(
    'SELECT is_admin FROM users WHERE id = $1 AND is_active = TRUE', [userId]
  );
  if (!userRows.length) return false;
  if (userRows[0].is_admin) return true;

  // Active workflow task (temporary full-equivalent for task scope)
  const { rows: taskRows } = await db.query(
    `SELECT id, task_type FROM workflow_tasks
     WHERE document_id = $1 AND assigned_to = $2
       AND task_status IN ('pending','in_progress')`,
    [document.id, userId]
  );
  if (taskRows.length > 0) return true;

  const roles = await getUserRoles(userId);
  const role  = roles.find(r => r.group_id === document.group_id);
  if (!role || role.access_level !== 'full') return false;
  if (role.has_owner_restriction && document.owner_id !== userId) return false;

  return true;
}

/**
 * Build a WHERE clause fragment that filters documents visible to a user.
 * Used in document list/search queries.
 * Returns { sql, params, nextParamIndex }
 */
async function buildVisibilityFilter(userId, startParamAt = 1) {
  const { rows: userRows } = await db.query(
    'SELECT is_admin FROM users WHERE id = $1 AND is_active = TRUE', [userId]
  );
  if (!userRows.length) return { sql: '1=0', params: [], nextParamAt: startParamAt };
  if (userRows[0].is_admin) return { sql: '1=1', params: [], nextParamAt: startParamAt };

  const roles = await getUserRoles(userId);

  const conditions = [];
  const params     = [];
  let   p          = startParamAt;

  // Workflow task access
  conditions.push(
    `d.id IN (SELECT document_id FROM workflow_tasks
              WHERE assigned_to = $${p} AND task_status IN ('pending','in_progress'))`
  );
  params.push(userId);
  p++;

  // Role-based group access
  for (const role of roles) {
    if (role.has_owner_restriction) {
      conditions.push(`(d.group_id = $${p} AND d.owner_id = $${p + 1})`);
      params.push(role.group_id, userId);
      p += 2;
    } else {
      conditions.push(`d.group_id = $${p}`);
      params.push(role.group_id);
      p++;
    }
  }

  if (conditions.length === 0) return { sql: '1=0', params: [], nextParamAt: p };

  return {
    sql: '(' + conditions.join(' OR ') + ')',
    params,
    nextParamAt: p,
  };
}

/**
 * Middleware factory: inject visibility filter into req for service layer.
 */
async function assertCanRead(userId, document) {
  const ok = await canRead(userId, document);
  if (!ok) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }
}

async function assertCanFull(userId, document) {
  const ok = await canFull(userId, document);
  if (!ok) {
    const err = new Error('Full access required');
    err.status = 403;
    throw err;
  }
}

/**
 * Check if user can CREATE documents (must have at least one 'full' role in any group).
 */
async function canCreateDocuments(userId) {
  const { rows } = await db.query(
    'SELECT is_admin FROM users WHERE id = $1 AND is_active = TRUE', [userId]
  );
  if (!rows.length) return false;
  if (rows[0].is_admin) return true;

  const { rows: roleRows } = await db.query(
    `SELECT 1 FROM user_group_roles ugr
     JOIN group_profiles gp ON gp.id = ugr.group_id
     WHERE ugr.user_id = $1 AND ugr.access_level = 'full' AND gp.is_active = TRUE
     LIMIT 1`,
    [userId]
  );
  return roleRows.length > 0;
}

module.exports = {
  getUserRoles,
  canRead,
  canFull,
  buildVisibilityFilter,
  assertCanRead,
  assertCanFull,
  canCreateDocuments,
};
