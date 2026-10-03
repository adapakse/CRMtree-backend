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

const db = require('../config/database');

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

async function assertPartnerInTenant(tenantId, partnerId) {
  if (!partnerId) return;
  const { rows } = await db.query(
    'SELECT 1 FROM crm_partners WHERE id = $1 AND tenant_id = $2', [partnerId, tenantId],
  );
  if (!rows.length) throw httpError(400, 'Nie znaleziono partnera');
}

async function listProjects({ tenantId, user, status }) {
  const params = [tenantId, user.id];
  const conditions = ['p.tenant_id = $1'];
  if (!user.is_admin) conditions.push('me.user_id IS NOT NULL');
  if (status !== 'all') {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  const { rows } = await db.query(
    `SELECT p.id, p.key, p.name, p.description, p.status, p.partner_id, p.created_at, p.closed_at,
            partner.company AS partner_name,
            me.role AS my_role, me.access_level AS my_access_level,
            (SELECT COUNT(*)::int FROM project_members m WHERE m.project_id = p.id) AS member_count,
            (SELECT COUNT(*)::int FROM project_tasks t WHERE t.project_id = p.id)   AS task_count,
            (SELECT COUNT(*)::int
               FROM project_tasks t
               JOIN project_task_statuses s ON s.id = t.status_id
               JOIN project_task_assignees a ON a.task_id = t.id AND a.user_id = $2
              WHERE t.project_id = p.id AND s.category <> 'done') AS my_open_task_count
     FROM projects p
     LEFT JOIN project_members me ON me.project_id = p.id AND me.user_id = $2
     LEFT JOIN crm_partners partner ON partner.id = p.partner_id AND partner.tenant_id = p.tenant_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY p.status, p.name`,
    params,
  );
  return rows;
}

async function createProject({ tenantId, user, name, description, partnerId }) {
  await assertPartnerInTenant(tenantId, partnerId);
  try {
    return await db.transaction(async (client) => {
      const key = await generateUniqueKey(client, tenantId, name);
      const { rows: [project] } = await client.query(
        `INSERT INTO projects (tenant_id, key, name, description, partner_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenantId, key, name, description || null, partnerId || null, user.id],
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
    `SELECT p.*, partner.company AS partner_name
     FROM projects p
     LEFT JOIN crm_partners partner ON partner.id = p.partner_id AND partner.tenant_id = p.tenant_id
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

async function updateProject({ tenantId, projectId, changes }) {
  if (changes.partner_id) await assertPartnerInTenant(tenantId, changes.partner_id);
  const setClauses = [];
  const params = [];
  for (const field of ['name', 'description', 'partner_id']) {
    if (changes[field] === undefined) continue;
    params.push(changes[field]);
    setClauses.push(`${field} = $${params.length}`);
  }
  if (!setClauses.length) throw httpError(400, 'Brak pól do zmiany');
  params.push(projectId, tenantId);
  const { rows: [project] } = await db.query(
    `UPDATE projects SET ${setClauses.join(', ')}, updated_at = now()
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
     RETURNING *`,
    params,
  );
  return project;
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
  buildKeyBase,
  listProjects,
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
