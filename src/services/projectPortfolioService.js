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
//
// The filters of those lists pick from two lookups over the whole scope:
// its people (listScopePeople) and its projects (listScopeProjectOptions).
// A lookup cannot be paged, so both are cut at a cap and say so.

const db = require('../config/database');

const SCOPE_ROLES = ['pm', 'controller'];
const LOOKUP_LIMIT = 500;

const cutAtLimit = (rows) => ({
  items: rows.slice(0, LOOKUP_LIMIT), truncated: rows.length > LOOKUP_LIMIT, limit: LOOKUP_LIMIT,
});

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

// Members of the projects in scope and everyone assigned to a task there —
// deactivated accounts too, as their tasks are still on the lists.
async function listScopePeople({ scopeProjectIds }) {
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.display_name
     FROM users u
     WHERE EXISTS (SELECT 1 FROM project_members m
                   WHERE m.user_id = u.id AND m.project_id = ANY($1::uuid[]))
        OR EXISTS (SELECT 1 FROM project_task_assignees a
                   JOIN project_tasks t ON t.id = a.task_id
                   WHERE a.user_id = u.id AND t.project_id = ANY($1::uuid[]))
     ORDER BY lower(u.display_name), u.id
     LIMIT ${LOOKUP_LIMIT + 1}`,
    [scopeProjectIds],
  );
  const { items: people, ...cut } = cutAtLimit(rows);
  return { people, ...cut };
}

async function listScopeProjectOptions({ scopeProjectIds }) {
  const { rows } = await db.query(
    `SELECT id, key, name, start_date, end_date
     FROM projects
     WHERE id = ANY($1::uuid[])
     ORDER BY key
     LIMIT ${LOOKUP_LIMIT + 1}`,
    [scopeProjectIds],
  );
  const { items: projects, ...cut } = cutAtLimit(rows);
  return { projects, ...cut };
}

module.exports = { LOOKUP_LIMIT, listScopeProjectIds, hasAccess, listScopePeople, listScopeProjectOptions };
