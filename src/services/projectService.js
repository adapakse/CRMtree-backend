'use strict';
// services/projectService.js
//
// Projects, their members and the custom fields a PM attached to a project.
//
// Access model: a user sees a project only when they are its member; the
// tenant admin sees and manages every project. Inside a project the PM
// manages everything; other roles are limited by access_level and the
// status transition matrix (see projectConfigService).
//
// Projects are closed, never deleted. A closed project is read-only until
// it is reopened.
//
// A project may have a start and an end date. They never block task dates;
// whether the project is delayed is computed (projectDeadlineService).

const db = require('../config/database');
const projectDeadlineService = require('./projectDeadlineService');

const PROJECT_ROLES = ['pm', 'internal_participant', 'external_participant', 'controller'];
const ACCESS_LEVELS = ['full', 'read'];

const KEY_MAX_LENGTH       = 4;
const KEY_FALLBACK         = 'PRJ';
const KEY_MAX_SUFFIX_TRIES = 200;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// The PM always edits the whole project and the controller only ever reads,
// so their access level is not a choice.
function resolveAccessLevel(role, requestedLevel) {
  if (role === 'pm') return 'full';
  if (role === 'controller') return 'read';
  if (!ACCESS_LEVELS.includes(requestedLevel)) throw httpError(400, 'Nieprawidłowy poziom uprawnień');
  return requestedLevel;
}

function assertRoleMatchesAccountKind(role, isExternalUser) {
  if (!PROJECT_ROLES.includes(role)) throw httpError(400, 'Nieznana rola projektowa');
  if (isExternalUser && (role === 'pm' || role === 'internal_participant')) {
    throw httpError(400, 'Konto zewnętrzne może być tylko uczestnikiem zewnętrznym lub kontrolerem');
  }
  if (!isExternalUser && role === 'external_participant') {
    throw httpError(400, 'Rola uczestnika zewnętrznego wymaga konta oznaczonego jako zewnętrzne');
  }
}

function buildKeyBase(name) {
  const words = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (!words.length) return KEY_FALLBACK;
  const base = words.length === 1
    ? words[0].slice(0, 3)
    : words.map((word) => word[0]).join('').slice(0, KEY_MAX_LENGTH);
  return /^[A-Z]/.test(base) ? base : KEY_FALLBACK;
}

async function generateUniqueKey(client, tenantId, name) {
  const base = buildKeyBase(name);
  const { rows } = await client.query(
    'SELECT key FROM projects WHERE tenant_id = $1 AND key LIKE $2', [tenantId, `${base}%`],
  );
  const taken = new Set(rows.map((row) => row.key));
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= KEY_MAX_SUFFIX_TRIES; suffix++) {
    if (!taken.has(`${base}${suffix}`)) return `${base}${suffix}`;
  }
  throw httpError(409, 'Nie udało się nadać prefiksu projektu');
}

// Sort key → ORDER BY expressions over the `project` wrapper of searchProjects.
const PROJECT_SORT_EXPRESSIONS = {
  name:       ['lower(project.name)'],
  key:        ['project.key'],
  status:     ['project.status'],
  start_date: ['project.start_date'],
  end_date:   ['project.end_date'],
  // Delayed projects first when ascending; among them the longest overrun first.
  delay:      ['(NOT (project.has_task_after_end OR project.has_end_passed))',
               '(-GREATEST(COALESCE(project.days_after_end, 0), COALESCE(project.days_since_end, 0)))'],
  pm:         ['project.first_manager_name'],
  progress:   ['project.progress_percent'],
  overdue:    ['project.overdue_task_count'],
  at_risk:    ['project.at_risk_task_count'],
  // Raw amounts in each project's own currency; NULL (finance not readable) sorts last.
  cost:       ['project.filter_cost'],
  revenue:    ['project.filter_revenue'],
};
const PROJECT_SORT_KEYS = Object.keys(PROJECT_SORT_EXPRESSIONS);
// Selected only to filter or sort by; not part of a project row.
const PROJECT_HELPER_COLUMNS = ['filter_cost', 'filter_revenue', 'first_manager_name'];
const DELAY_REASON_COLUMNS = {
  task_after_end: 'project.has_task_after_end',
  end_passed:     'project.has_end_passed',
};
const DELAY_REASONS = Object.keys(DELAY_REASON_COLUMNS);
const MY_ROLE_FILTERS = {
  pm:          ['pm'],
  controller:  ['controller'],
  participant: ['internal_participant', 'external_participant'],
};
const MAX_PAGE_SIZE = 50;

const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

function projectOrderBy(sort, order) {
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  const expressions = sort
    ? PROJECT_SORT_EXPRESSIONS[sort].map((expression) => `${expression} ${direction} NULLS LAST`)
    : ['project.status'];
  return [...expressions, 'lower(project.name)', 'project.key'].join(', ');
}

// The paged, filterable list of projects: those the user is a member of (the
// tenant admin: all), or — with `scopeProjectIds` — exactly the given ones
// (the cross-project view).
//
// filters (all optional, combined with AND): status ('open' | 'closed' | 'all'),
// name (matches name or key), startFrom/startTo, endFrom/endTo, isDelayed,
// leadId, partnerId, myRoles, managerId (a PM of the project), delayReasons
// (any of them), overdueMin/overdueMax and atRiskMin/atRiskMax (task counts),
// progressMin/progressMax (progress_percent), costMin/costMax,
// revenueMin/revenueMax.
// progress_percent is the share of done tasks rounded to a whole percent, 0
// for a project without tasks — the number the row carries, so the filter and
// the column always agree.
// The amounts are the actual ones the list shows (incurred cost; invoiced and
// paid revenue), in each project's own currency — never converted. As in the
// task lists, they are known only where the user may read the project's
// finance (admin, PM, controller, finance switched on); elsewhere an amount
// filter lets the project through.
async function searchProjects({
  tenantId, user, scopeProjectIds = null, isFinanceEnabled = false,
  filters = {}, sort, order, page = 1, pageSize = MAX_PAGE_SIZE,
}) {
  const params = [tenantId, user.id, projectDeadlineService.todayInWarsaw(), Boolean(user.is_admin), Boolean(isFinanceEnabled)];
  const addParam = (value) => { params.push(value); return `$${params.length}`; };
  const inner = ['p.tenant_id = $1'];
  const outer = [];

  if (scopeProjectIds) inner.push(`p.id = ANY(${addParam(scopeProjectIds)}::uuid[])`);
  else inner.push('($4::boolean OR me.user_id IS NOT NULL)');
  if (filters.status && filters.status !== 'all') inner.push(`p.status = ${addParam(filters.status)}`);
  if (filters.name) {
    const pattern = addParam(`%${escapeLike(filters.name)}%`);
    inner.push(`(p.name ILIKE ${pattern} OR p.key ILIKE ${pattern})`);
  }
  const range = (column, from, to) => {
    if (from) inner.push(`${column} >= ${addParam(from)}::date`);
    if (to) inner.push(`${column} <= ${addParam(to)}::date`);
  };
  range('p.start_date', filters.startFrom, filters.startTo);
  range('p.end_date', filters.endFrom, filters.endTo);
  if (filters.leadId) inner.push(`p.lead_id = ${addParam(filters.leadId)}`);
  if (filters.partnerId) inner.push(`p.partner_id = ${addParam(filters.partnerId)}`);
  if (filters.myRoles?.length) {
    const roles = filters.myRoles.flatMap((role) => MY_ROLE_FILTERS[role]);
    inner.push(`me.role = ANY(${addParam(roles)}::text[])`);
  }
  if (filters.managerId) {
    inner.push(`EXISTS (SELECT 1 FROM project_members manager
                        WHERE manager.project_id = p.id AND manager.role = 'pm'
                          AND manager.user_id = ${addParam(filters.managerId)}::uuid)`);
  }
  const countRange = (column, min, max) => {
    if (min !== undefined) outer.push(`${column} >= ${addParam(min)}::int`);
    if (max !== undefined) outer.push(`${column} <= ${addParam(max)}::int`);
  };
  countRange('project.overdue_task_count', filters.overdueMin, filters.overdueMax);
  countRange('project.at_risk_task_count', filters.atRiskMin, filters.atRiskMax);
  countRange('project.progress_percent', filters.progressMin, filters.progressMax);
  if (filters.delayReasons?.length) {
    outer.push(`(${filters.delayReasons.map((reason) => DELAY_REASON_COLUMNS[reason]).join(' OR ')})`);
  }
  if (filters.isDelayed !== undefined) {
    outer.push(`(project.has_task_after_end OR project.has_end_passed) = ${addParam(filters.isDelayed)}::boolean`);
  }
  const amountRange = (column, min, max) => {
    if (min !== undefined) outer.push(`(${column} IS NULL OR ${column} >= ${addParam(min)}::numeric)`);
    if (max !== undefined) outer.push(`(${column} IS NULL OR ${column} <= ${addParam(max)}::numeric)`);
  };
  amountRange('project.filter_cost', filters.costMin, filters.costMax);
  amountRange('project.filter_revenue', filters.revenueMin, filters.revenueMax);

  const canReadFinance = `($5::boolean AND ($4::boolean OR me.role IN ('pm', 'controller')))`;
  const from = `FROM (
    SELECT p.id, p.key, p.name, p.description, p.status, p.partner_id, p.lead_id, p.created_at, p.closed_at,
           p.start_date, p.end_date,
           partner.company AS partner_name, lead.company AS lead_name,
           me.role AS my_role, me.access_level AS my_access_level,
           (SELECT COUNT(*)::int FROM project_members m WHERE m.project_id = p.id) AS member_count,
           counts.task_count, counts.done_task_count, counts.overdue_task_count, counts.at_risk_task_count,
           CASE WHEN counts.task_count = 0 THEN 0
                ELSE ROUND(counts.done_task_count * 100.0 / counts.task_count)::int END AS progress_percent,
           (SELECT COUNT(*)::int
              FROM project_tasks t
              JOIN project_task_statuses s ON s.id = t.status_id
              JOIN project_task_assignees a ON a.task_id = t.id AND a.user_id = $2
             WHERE t.project_id = p.id AND s.category <> 'done') AS my_open_task_count,
           COALESCE((
             SELECT json_agg(json_build_object('user_id', u.id, 'display_name', u.display_name)
                             ORDER BY u.last_name, u.first_name)
             FROM project_members manager
             JOIN users u ON u.id = manager.user_id
             WHERE manager.project_id = p.id AND manager.role = 'pm'
           ), '[]'::json) AS project_managers,
           (SELECT MIN(lower(u.display_name))
            FROM project_members manager
            JOIN users u ON u.id = manager.user_id
            WHERE manager.project_id = p.id AND manager.role = 'pm') AS first_manager_name,
           ${projectDeadlineService.projectDelayColumns('$3')},
           CASE WHEN ${canReadFinance} THEN (
             SELECT COALESCE(SUM(c.amount), 0) FROM project_cost_items c
             WHERE c.project_id = p.id AND c.status = 'incurred') END AS filter_cost,
           CASE WHEN ${canReadFinance} THEN (
             SELECT COALESCE(SUM(r.amount), 0) FROM project_revenue_items r
             WHERE r.project_id = p.id AND r.status IN ('invoiced', 'paid')) END AS filter_revenue
    FROM projects p
    LEFT JOIN project_members me ON me.project_id = p.id AND me.user_id = $2
    LEFT JOIN crm_partners partner ON partner.id = p.partner_id AND partner.tenant_id = p.tenant_id
    LEFT JOIN crm_leads lead ON lead.id = p.lead_id AND lead.tenant_id = p.tenant_id
    ${projectDeadlineService.PROJECT_DELAY_JOIN}
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS task_count,
             COUNT(*) FILTER (WHERE task.status_category = 'done')::int AS done_task_count,
             COUNT(*) FILTER (WHERE task.timeliness = 'overdue')::int   AS overdue_task_count,
             COUNT(*) FILTER (WHERE task.timeliness = 'at_risk')::int   AS at_risk_task_count
      FROM (
        SELECT s.category AS status_category, ${projectDeadlineService.timelinessSql('$3')} AS timeliness
        FROM project_tasks t
        JOIN project_task_statuses s ON s.id = t.status_id
        WHERE t.project_id = p.id
      ) task
    ) counts
    WHERE ${inner.join(' AND ')}
  ) project
  ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}`;

  const [{ rows: [{ total }] }, { rows }] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total ${from}`, params),
    db.query(
      `SELECT * ${from}
       ORDER BY ${projectOrderBy(sort, order)}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
  ]);
  const items = rows.map((row) => {
    const project = projectDeadlineService.withProjectDelay(row);
    // The amounts shown come with the finance totals.
    for (const column of PROJECT_HELPER_COLUMNS) delete project[column];
    return project;
  });
  return { items, total, page, page_size: pageSize };
}

function assertDateOrder(startDate, endDate) {
  if (startDate && endDate && endDate < startDate) {
    throw httpError(400, 'The project end date cannot be earlier than its start date');
  }
}

async function createProject({ tenantId, user, name, description, startDate, endDate }) {
  assertDateOrder(startDate, endDate);
  try {
    return await db.transaction(async (client) => {
      const key = await generateUniqueKey(client, tenantId, name);
      const { rows: [project] } = await client.query(
        `INSERT INTO projects (tenant_id, key, name, description, start_date, end_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [tenantId, key, name, description || null, startDate || null, endDate || null, user.id],
      );
      await client.query(
        `INSERT INTO project_members (project_id, user_id, tenant_id, role, access_level, added_by)
         VALUES ($1, $2, $3, 'pm', 'full', $2)`,
        [project.id, user.id, tenantId],
      );
      return project;
    });
  } catch (err) {
    // Two projects created at the same moment picked the same key.
    if (err.code === '23505') throw httpError(409, 'Prefiks projektu jest już zajęty — spróbuj ponownie');
    throw err;
  }
}

// Returns null when the project does not exist in the tenant or the user may
// not see it — callers answer 404 in both cases so project ids do not leak.
async function loadProjectForUser({ tenantId, user, projectId }) {
  const { rows: [project] } = await db.query(
    `SELECT p.*, partner.company AS partner_name, lead.company AS lead_name
     FROM projects p
     LEFT JOIN crm_partners partner ON partner.id = p.partner_id AND partner.tenant_id = p.tenant_id
     LEFT JOIN crm_leads lead ON lead.id = p.lead_id AND lead.tenant_id = p.tenant_id
     WHERE p.id = $1 AND p.tenant_id = $2`,
    [projectId, tenantId],
  );
  if (!project) return null;
  const { rows: [membership] } = await db.query(
    'SELECT role, access_level FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, user.id],
  );
  if (!membership && !user.is_admin) return null;
  return {
    project,
    membership: membership || null,
    canManage: Boolean(user.is_admin) || membership?.role === 'pm',
  };
}

async function listMembers(projectId) {
  const { rows } = await db.query(
    `SELECT m.user_id, m.role, m.access_level, m.created_at,
            u.display_name, u.email, u.phone, u.company, u.department, u.is_external, u.is_active
     FROM project_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.project_id = $1
     ORDER BY (m.role = 'pm') DESC, u.last_name, u.first_name`,
    [projectId],
  );
  return rows;
}

async function listProjectFields(projectId) {
  const { rows } = await db.query(
    `SELECT pf.field_definition_id, pf.is_required, pf.sort_order,
            d.name, d.field_type, d.options, d.is_active
     FROM project_fields pf
     JOIN project_field_definitions d ON d.id = pf.field_definition_id
     WHERE pf.project_id = $1
     ORDER BY pf.sort_order, d.name`,
    [projectId],
  );
  return rows;
}

const EDITABLE_PROJECT_FIELDS = ['name', 'description', 'start_date', 'end_date'];

async function updateProject({ tenantId, project, changes }) {
  assertDateOrder(
    changes.start_date === undefined ? project.start_date : changes.start_date,
    changes.end_date === undefined ? project.end_date : changes.end_date,
  );
  const setClauses = [];
  const params = [];
  for (const field of EDITABLE_PROJECT_FIELDS) {
    if (changes[field] === undefined) continue;
    params.push(changes[field]);
    setClauses.push(`${field} = $${params.length}`);
  }
  if (!setClauses.length) throw httpError(400, 'Brak pól do zmiany');
  params.push(project.id, tenantId);
  const { rows: [updated] } = await db.query(
    `UPDATE projects SET ${setClauses.join(', ')}, updated_at = now()
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
     RETURNING *`,
    params,
  );
  return updated;
}

async function setProjectStatus({ tenantId, projectId, userId, status }) {
  const isClosing = status === 'closed';
  const { rows: [project] } = await db.query(
    `UPDATE projects
     SET status = $1,
         closed_at = CASE WHEN $2 THEN now() ELSE NULL END,
         closed_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
         updated_at = now()
     WHERE id = $4 AND tenant_id = $5
     RETURNING *`,
    [status, isClosing, userId, projectId, tenantId],
  );
  return project;
}

async function listMemberCandidates({ tenantId, projectId, search }) {
  const params = [tenantId, projectId];
  let searchCondition = '';
  if (search) {
    params.push(`%${search}%`);
    searchCondition = `AND (u.email ILIKE $3 OR u.first_name ILIKE $3 OR u.last_name ILIKE $3
                            OR u.company ILIKE $3)`;
  }
  const { rows } = await db.query(
    `SELECT u.id, u.display_name, u.email, u.company, u.department, u.is_external
     FROM users u
     WHERE u.tenant_id = $1 AND u.is_active
       AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = $2 AND m.user_id = u.id)
       ${searchCondition}
     ORDER BY u.last_name, u.first_name
     LIMIT 50`,
    params,
  );
  return rows;
}

async function addMember({ tenantId, projectId, userId, role, accessLevel, addedBy }) {
  const { rows: [candidate] } = await db.query(
    'SELECT is_external FROM users WHERE id = $1 AND tenant_id = $2 AND is_active',
    [userId, tenantId],
  );
  if (!candidate) throw httpError(400, 'Nie znaleziono aktywnego użytkownika');
  assertRoleMatchesAccountKind(role, candidate.is_external);
  const level = resolveAccessLevel(role, accessLevel);
  try {
    await db.query(
      `INSERT INTO project_members (project_id, user_id, tenant_id, role, access_level, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, userId, tenantId, role, level, addedBy],
    );
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'Użytkownik jest już członkiem projektu');
    throw err;
  }
  return { role, access_level: level };
}

async function assertAnotherPmRemains(client, projectId, userId) {
  const { rows } = await client.query(
    `SELECT 1 FROM project_members
     WHERE project_id = $1 AND role = 'pm' AND user_id <> $2 LIMIT 1`,
    [projectId, userId],
  );
  if (!rows.length) throw httpError(409, 'Projekt musi mieć co najmniej jednego PM-a');
}

async function updateMember({ projectId, userId, role, accessLevel }) {
  return db.transaction(async (client) => {
    const { rows: [current] } = await client.query(
      `SELECT m.role, m.access_level, u.is_external
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = $1 AND m.user_id = $2
       FOR UPDATE OF m`,
      [projectId, userId],
    );
    if (!current) throw httpError(404, 'Nie znaleziono członka projektu');

    const nextRole = role ?? current.role;
    assertRoleMatchesAccountKind(nextRole, current.is_external);
    const nextLevel = resolveAccessLevel(nextRole, accessLevel ?? current.access_level);
    if (current.role === 'pm' && nextRole !== 'pm') {
      await assertAnotherPmRemains(client, projectId, userId);
    }
    await client.query(
      'UPDATE project_members SET role = $1, access_level = $2 WHERE project_id = $3 AND user_id = $4',
      [nextRole, nextLevel, projectId, userId],
    );
    return {
      before: { role: current.role, access_level: current.access_level },
      after:  { role: nextRole, access_level: nextLevel },
    };
  });
}

async function removeMember({ projectId, userId }) {
  return db.transaction(async (client) => {
    const { rows: [current] } = await client.query(
      'SELECT role, access_level FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE',
      [projectId, userId],
    );
    if (!current) throw httpError(404, 'Nie znaleziono członka projektu');
    if (current.role === 'pm') await assertAnotherPmRemains(client, projectId, userId);

    await client.query(
      `DELETE FROM project_task_assignees a
       USING project_tasks t
       WHERE a.task_id = t.id AND t.project_id = $1 AND a.user_id = $2`,
      [projectId, userId],
    );
    await client.query(
      'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId],
    );
    return current;
  });
}

// Replaces the project's custom field list; array order becomes the display
// order. Values already stored on tasks for a removed field are left in
// place, so re-adding the field brings them back.
async function replaceProjectFields({ tenantId, projectId, fields }) {
  const definitionIds = fields.map((field) => field.field_definition_id);
  if (new Set(definitionIds).size !== definitionIds.length) {
    throw httpError(400, 'Pole dodano więcej niż raz');
  }
  // Deactivated definitions are accepted: a field already on the project must
  // survive the PM re-saving the list. The UI offers only active ones to add.
  const { rows: known } = await db.query(
    'SELECT id FROM project_field_definitions WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
    [tenantId, definitionIds],
  );
  if (known.length !== definitionIds.length) throw httpError(400, 'Nieznane pole');

  await db.transaction(async (client) => {
    await client.query('DELETE FROM project_fields WHERE project_id = $1', [projectId]);
    for (const [index, field] of fields.entries()) {
      await client.query(
        `INSERT INTO project_fields (project_id, field_definition_id, tenant_id, is_required, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [projectId, field.field_definition_id, tenantId, Boolean(field.is_required), index],
      );
    }
  });
  return listProjectFields(projectId);
}

module.exports = {
  PROJECT_ROLES,
  ACCESS_LEVELS,
  EDITABLE_PROJECT_FIELDS,
  PROJECT_SORT_KEYS,
  MY_ROLE_FILTERS,
  DELAY_REASONS,
  buildKeyBase,
  searchProjects,
  createProject,
  loadProjectForUser,
  listMembers,
  listProjectFields,
  updateProject,
  setProjectStatus,
  listMemberCandidates,
  addMember,
  updateMember,
  removeMember,
  replaceProjectFields,
};
