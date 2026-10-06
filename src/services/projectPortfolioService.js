'use strict';
// services/projectPortfolioService.js
//
// Who has the cross-project view and over which projects: the tenant admin
// over every open project of the tenant, any other user over the open projects
// in which they are PM or controller. Closed projects are never part of the
// view. A user with an empty scope who is not the admin does not have the view
// at all.
//
// The lists themselves come from the shared queries: projectTaskListService
// (tasks) and projectService.searchProjects (projects), narrowed to this scope.

const db = require('../config/database');

const SCOPE_ROLES = ['pm', 'controller'];

async function listScopeProjectIds({ tenantId, user }) {
  const { rows } = user.is_admin
    ? await db.query(`SELECT id FROM projects WHERE tenant_id = $1 AND status = 'open'`, [tenantId])
    : await db.query(
      `SELECT p.id
       FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.user_id = $2 AND m.role = ANY($3::text[])
       WHERE p.tenant_id = $1 AND p.status = 'open'`,
      [tenantId, user.id, SCOPE_ROLES],
    );
  return rows.map((row) => row.id);
}

async function hasAccess({ tenantId, user }) {
  if (user.is_admin) return true;
  return (await listScopeProjectIds({ tenantId, user })).length > 0;
}

module.exports = { listScopeProjectIds, hasAccess };
