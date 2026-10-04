'use strict';
// services/projectTaskService.js
//
// Tasks of a project.
//
// Who may do what (actor = { user, membership, canManage }):
//   - PM / tenant admin (canManage): everything, any status change.
//   - internal / external participant: content of tasks they are assigned to,
//     and only with access_level "full"; status changes on those tasks as
//     far as the tenant's transition matrix allows for their role.
//   - controller: never edits content; changes status on any task as far as
//     the transition matrix allows.
//   - external participant additionally sees only tasks assigned to them.
// Task structure (parent, assignees) is always the PM's.
//
// Tasks are never deleted. History is kept in audit_logs, keyed by
// metadata.task_id.

const db = require('../config/database');
const logger = require('../utils/logger');
const emailUtil = require('../utils/email');
const { resolveLocale } = require('../config/locales');
const projectService = require('./projectService');
const projectConfigService = require('./projectConfigService');

const CONTENT_FIELDS   = [
  'name', 'description', 'type_id', 'priority_id', 'start_date', 'end_date', 'custom_values',
  'reminder_type', 'reminder_at',
];
// A project task has a due date but no due time, so relative reminders are
// sent at the hour the task is shown at in the calendar.
const REMINDER_LOCAL_TIME = '09:00';
const REMINDER_TIME_ZONE  = 'Europe/Warsaw';
const STRUCTURE_FIELDS = ['parent_task_id', 'assignee_ids'];
const PARTICIPANT_ROLES = ['internal_participant', 'external_participant'];

const MAX_TEXT_VALUE_LENGTH = 5000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const HISTORY_LIMIT = 200;

const TASK_SELECT = `
  SELECT t.id, t.project_id, t.task_number, t.name, t.description,
         t.type_id, t.status_id, t.priority_id, t.start_date, t.end_date,
         t.parent_task_id, t.custom_values, t.created_by, t.created_at, t.updated_at,
         t.reminder_type, t.reminder_at,
         COALESCE((
           SELECT json_agg(json_build_object('user_id', u.id, 'display_name', u.display_name)
                           ORDER BY u.last_name, u.first_name)
           FROM project_task_assignees a
           JOIN users u ON u.id = a.user_id
           WHERE a.task_id = t.id
         ), '[]'::json) AS assignees
  FROM project_tasks t`;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function seesOnlyAssignedTasks(actor) {
  return !actor.canManage && actor.membership?.role === 'external_participant';
}

function isAssignedTo(task, userId) {
  return task.assignees.some((assignee) => assignee.user_id === userId);
}

function canEditContent(task, actor) {
  if (actor.canManage) return true;
  return PARTICIPANT_ROLES.includes(actor.membership?.role)
    && actor.membership.access_level === 'full'
    && isAssignedTo(task, actor.user.id);
}

function mayUseTransitionMatrix(task, actor) {
  if (actor.membership?.role === 'controller') return true;
  return canEditContent(task, actor);
}

async function listAllowedStatusIds(tenantId, task, actor) {
  if (actor.canManage) {
    const { rows } = await db.query(
      'SELECT id FROM project_task_statuses WHERE tenant_id = $1 AND is_active AND id <> $2',
      [tenantId, task.status_id],
    );
    return rows.map((row) => row.id);
  }
  if (!mayUseTransitionMatrix(task, actor)) return [];
  const { rows } = await db.query(
    `SELECT tr.to_status_id
     FROM project_status_transitions tr
     JOIN project_task_statuses s ON s.id = tr.to_status_id AND s.is_active
     WHERE tr.tenant_id = $1 AND tr.role = $2 AND tr.from_status_id = $3`,
    [tenantId, actor.membership.role, task.status_id],
  );
  return rows.map((row) => row.to_status_id);
}

async function listTasks({ projectId, actor, onlyMine }) {
  const params = [projectId];
  let assignedCondition = '';
  if (onlyMine || seesOnlyAssignedTasks(actor)) {
    params.push(actor.user.id);
    assignedCondition = `AND EXISTS (SELECT 1 FROM project_task_assignees mine
                                     WHERE mine.task_id = t.id AND mine.user_id = $2)`;
  }
  const { rows } = await db.query(
    `${TASK_SELECT} WHERE t.project_id = $1 ${assignedCondition} ORDER BY t.task_number`,
    params,
  );
  return rows;
}

// Returns null when the task does not exist in the project or the actor may not see it.
async function findVisibleTask({ projectId, taskId, actor }) {
  const { rows: [task] } = await db.query(
    `${TASK_SELECT} WHERE t.id = $1 AND t.project_id = $2`, [taskId, projectId],
  );
  if (!task) return null;
  if (seesOnlyAssignedTasks(actor) && !isAssignedTo(task, actor.user.id)) return null;
  return task;
}

async function getTask({ tenantId, project, taskId, actor }) {
  const task = await findVisibleTask({ projectId: project.id, taskId, actor });
  if (!task) return null;
  const isOpen = project.status === 'open';
  return {
    ...task,
    permissions: {
      can_edit_content:   isOpen && canEditContent(task, actor),
      can_edit_structure: isOpen && actor.canManage,
      allowed_status_ids: isOpen ? await listAllowedStatusIds(tenantId, task, actor) : [],
    },
  };
}

async function assertActiveDictionaryItem(table, tenantId, id, label) {
  if (!id) return;
  const { rows } = await db.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2 AND is_active`, [id, tenantId],
  );
  if (!rows.length) throw httpError(400, `Nieznana lub nieaktywna pozycja słownika: ${label}`);
}

async function assertAssigneesAreMembers(projectId, assigneeIds) {
  if (!assigneeIds.length) return;
  const { rows } = await db.query(
    'SELECT user_id FROM project_members WHERE project_id = $1 AND user_id = ANY($2::uuid[])',
    [projectId, assigneeIds],
  );
  if (rows.length !== new Set(assigneeIds).size) {
    throw httpError(400, 'Zadanie można przypisać tylko członkom projektu');
  }
}

async function assertValidParent({ projectId, taskId, parentTaskId }) {
  if (!parentTaskId) return;
  if (parentTaskId === taskId) throw httpError(400, 'Zadanie nie może być własnym zadaniem nadrzędnym');
  const { rows: ancestors } = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_task_id, project_id FROM project_tasks WHERE id = $1
       UNION
       SELECT p.id, p.parent_task_id, p.project_id
       FROM project_tasks p JOIN chain c ON p.id = c.parent_task_id
     )
     SELECT id, project_id FROM chain`,
    [parentTaskId],
  );
  const parent = ancestors.find((row) => row.id === parentTaskId);
  if (!parent || parent.project_id !== projectId) {
    throw httpError(400, 'Zadanie nadrzędne musi należeć do tego samego projektu');
  }
  if (taskId && ancestors.some((row) => row.id === taskId)) {
    throw httpError(400, 'Zadanie nadrzędne nie może być podzadaniem tego zadania');
  }
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === '';
}

function cleanCustomValue(field, value) {
  const invalid = () => httpError(400, `Nieprawidłowa wartość pola „${field.name}”`);
  switch (field.field_type) {
    case 'text':
      if (typeof value !== 'string' || value.length > MAX_TEXT_VALUE_LENGTH) throw invalid();
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
      return value;
    case 'list':
      if (!field.options.includes(value)) throw invalid();
      return value;
    case 'date':
      if (typeof value !== 'string' || !ISO_DATE_RE.test(value) || Number.isNaN(Date.parse(value))) throw invalid();
      return value;
    case 'money':
      if (!value || typeof value.amount !== 'number' || !Number.isFinite(value.amount)
          || !CURRENCY_RE.test(value.currency || '')) throw invalid();
      return { amount: value.amount, currency: value.currency };
    default:
      throw invalid();
  }
}

// `submitted` holds values for the project's current fields only; values of
// fields since removed from the project stay in `existing` untouched.
function mergeCustomValues(projectFields, existing, submitted) {
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    throw httpError(400, 'custom_values musi być obiektem');
  }
  const fieldById = new Map(projectFields.map((field) => [field.field_definition_id, field]));
  const merged = { ...existing };
  for (const [fieldId, value] of Object.entries(submitted)) {
    const field = fieldById.get(fieldId);
    if (!field) throw httpError(400, 'Pole nie jest dodane do tego projektu');
    if (isEmptyValue(value)) delete merged[fieldId];
    else merged[fieldId] = cleanCustomValue(field, value);
  }
  const missing = projectFields.find(
    (field) => field.is_required && isEmptyValue(merged[field.field_definition_id]),
  );
  if (missing) throw httpError(400, `Pole „${missing.name}” jest wymagane`);
  return merged;
}

function assertDateOrder(startDate, endDate) {
  if (startDate && endDate && endDate < startDate) {
    throw httpError(400, 'Data zakończenia nie może być wcześniejsza niż data początku');
  }
}

async function findDefaultStatusId(tenantId) {
  // A task can be the first thing a tenant does in the module, before anyone read the configuration.
  await projectConfigService.ensureDefaults(tenantId);
  const { rows: [status] } = await db.query(
    `SELECT id FROM project_task_statuses
     WHERE tenant_id = $1 AND is_active
     ORDER BY (category = 'todo') DESC, sort_order
     LIMIT 1`,
    [tenantId],
  );
  if (!status) throw httpError(409, 'Brak skonfigurowanych statusów zadań');
  return status.id;
}

// Stores the reminder choice and derives when it fires. Re-arming
// (reminder_sent = false) happens on every call: the callers invoke this only
// when the reminder settings or the due date changed.
async function applyReminder(client, taskId, reminderType, customReminderAt) {
  if (reminderType === 'custom' && !customReminderAt) {
    throw httpError(400, 'Własne przypomnienie wymaga daty');
  }
  await client.query(
    `UPDATE project_tasks
     SET reminder_type = $2::text,
         reminder_sent = FALSE,
         reminder_at = CASE
           WHEN $2::text IS NULL THEN NULL
           WHEN $2::text = 'custom' THEN $3::timestamptz
           WHEN end_date IS NULL THEN NULL
           ELSE ((end_date + $4::time) AT TIME ZONE $5::text)
                - make_interval(days => CASE $2::text WHEN '1d_before' THEN 1 WHEN '2d_before' THEN 2
                                                     WHEN '3d_before' THEN 3 ELSE 0 END)
         END
     WHERE id = $1`,
    [taskId, reminderType || null, customReminderAt || null, REMINDER_LOCAL_TIME, REMINDER_TIME_ZONE],
  );
}

async function replaceAssignees(client, tenantId, taskId, assigneeIds) {
  await client.query('DELETE FROM project_task_assignees WHERE task_id = $1', [taskId]);
  for (const userId of new Set(assigneeIds)) {
    await client.query(
      'INSERT INTO project_task_assignees (task_id, user_id, tenant_id) VALUES ($1, $2, $3)',
      [taskId, userId, tenantId],
    );
  }
}

async function createTask({ tenantId, project, actor, input }) {
  if (!actor.canManage) throw httpError(403, 'Zadania zakłada PM projektu');

  const assigneeIds = input.assignee_ids || [];
  const statusId = input.status_id || await findDefaultStatusId(tenantId);
  assertDateOrder(input.start_date, input.end_date);
  await Promise.all([
    assertActiveDictionaryItem('project_task_statuses', tenantId, statusId, 'status'),
    assertActiveDictionaryItem('project_task_types', tenantId, input.type_id, 'typ'),
    assertActiveDictionaryItem('project_task_priorities', tenantId, input.priority_id, 'priorytet'),
    assertAssigneesAreMembers(project.id, assigneeIds),
    assertValidParent({ projectId: project.id, taskId: null, parentTaskId: input.parent_task_id }),
  ]);
  const projectFields = await projectService.listProjectFields(project.id);
  const customValues = mergeCustomValues(projectFields, {}, input.custom_values || {});

  const taskId = await db.transaction(async (client) => {
    const { rows: [counter] } = await client.query(
      `UPDATE projects SET next_task_number = next_task_number + 1
       WHERE id = $1 RETURNING next_task_number - 1 AS task_number`,
      [project.id],
    );
    const { rows: [created] } = await client.query(
      `INSERT INTO project_tasks
         (tenant_id, project_id, task_number, name, description, type_id, status_id, priority_id,
          start_date, end_date, parent_task_id, custom_values, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
       RETURNING id`,
      [tenantId, project.id, counter.task_number, input.name, input.description || null,
       input.type_id || null, statusId, input.priority_id || null,
       input.start_date || null, input.end_date || null, input.parent_task_id || null,
       JSON.stringify(customValues), actor.user.id],
    );
    await replaceAssignees(client, tenantId, created.id, assigneeIds);
    if (input.reminder_type) await applyReminder(client, created.id, input.reminder_type, input.reminder_at);
    return created.id;
  });

  const task = await findVisibleTask({ projectId: project.id, taskId, actor });
  return { task, addedAssigneeIds: [...new Set(assigneeIds)] };
}

async function assertStatusChangeAllowed({ tenantId, task, actor, nextStatusId }) {
  await assertActiveDictionaryItem('project_task_statuses', tenantId, nextStatusId, 'status');
  if (actor.canManage) return;
  const allowed = await listAllowedStatusIds(tenantId, task, actor);
  if (!allowed.includes(nextStatusId)) {
    throw httpError(403, 'Twoja rola nie pozwala na tę zmianę statusu');
  }
}

async function updateTask({ tenantId, project, actor, taskId, changes }) {
  const task = await findVisibleTask({ projectId: project.id, taskId, actor });
  if (!task) throw httpError(404, 'Nie znaleziono zadania');

  const has = (field) => changes[field] !== undefined;
  if (STRUCTURE_FIELDS.some(has) && !actor.canManage) {
    throw httpError(403, 'Zadanie nadrzędne i przypisane osoby zmienia PM projektu');
  }
  if (CONTENT_FIELDS.some(has) && !canEditContent(task, actor)) {
    throw httpError(403, 'Brak uprawnień do edycji tego zadania');
  }

  const isStatusChange = has('status_id') && changes.status_id !== task.status_id;
  if (isStatusChange) {
    await assertStatusChangeAllowed({ tenantId, task, actor, nextStatusId: changes.status_id });
  }
  assertDateOrder(
    has('start_date') ? changes.start_date : task.start_date,
    has('end_date') ? changes.end_date : task.end_date,
  );
  if (has('type_id') && changes.type_id !== task.type_id) {
    await assertActiveDictionaryItem('project_task_types', tenantId, changes.type_id, 'typ');
  }
  if (has('priority_id') && changes.priority_id !== task.priority_id) {
    await assertActiveDictionaryItem('project_task_priorities', tenantId, changes.priority_id, 'priorytet');
  }
  if (has('parent_task_id')) {
    await assertValidParent({ projectId: project.id, taskId, parentTaskId: changes.parent_task_id });
  }
  if (has('assignee_ids')) await assertAssigneesAreMembers(project.id, changes.assignee_ids);

  const next = {};
  for (const field of ['name', 'description', 'type_id', 'priority_id', 'start_date', 'end_date', 'parent_task_id']) {
    if (has(field) && changes[field] !== task[field]) next[field] = changes[field];
  }
  if (isStatusChange) next.status_id = changes.status_id;
  if (has('custom_values')) {
    const projectFields = await projectService.listProjectFields(project.id);
    const merged = mergeCustomValues(projectFields, task.custom_values, changes.custom_values);
    if (JSON.stringify(merged) !== JSON.stringify(task.custom_values)) next.custom_values = merged;
  }

  const previousAssigneeIds = task.assignees.map((assignee) => assignee.user_id);
  const nextAssigneeIds = has('assignee_ids') ? [...new Set(changes.assignee_ids)] : previousAssigneeIds;
  const addedAssigneeIds = nextAssigneeIds.filter((id) => !previousAssigneeIds.includes(id));
  const assigneesChanged = addedAssigneeIds.length > 0 || nextAssigneeIds.length !== previousAssigneeIds.length;

  const nextReminderType = has('reminder_type') ? changes.reminder_type : task.reminder_type;
  const reminderSettingsChanged = (has('reminder_type') && changes.reminder_type !== task.reminder_type)
    || (nextReminderType === 'custom' && has('reminder_at')
        && new Date(changes.reminder_at).getTime() !== new Date(task.reminder_at).getTime());
  // A changed due date moves a relative reminder with it.
  const reminderNeedsRecalculation = reminderSettingsChanged
    || (Boolean(nextReminderType) && nextReminderType !== 'custom' && 'end_date' in next);

  const changedFields = Object.keys(next);
  if (!changedFields.length && !assigneesChanged && !reminderNeedsRecalculation) {
    return { task, before: null, after: null, addedAssigneeIds: [] };
  }

  await db.transaction(async (client) => {
    if (changedFields.length) {
      const setClauses = changedFields.map((field, index) =>
        `${field} = $${index + 1}${field === 'custom_values' ? '::jsonb' : ''}`);
      const params = changedFields.map((field) =>
        (field === 'custom_values' ? JSON.stringify(next[field]) : next[field]));
      params.push(taskId);
      await client.query(
        `UPDATE project_tasks SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
        params,
      );
    }
    if (assigneesChanged) await replaceAssignees(client, tenantId, taskId, nextAssigneeIds);
    if (reminderNeedsRecalculation) {
      await applyReminder(client, taskId, nextReminderType, has('reminder_at') ? changes.reminder_at : task.reminder_at);
    }
  });

  const before = Object.fromEntries(changedFields.map((field) => [field, task[field]]));
  const after = { ...next };
  if (assigneesChanged) {
    before.assignee_ids = previousAssigneeIds;
    after.assignee_ids = nextAssigneeIds;
  }
  if (reminderSettingsChanged) {
    before.reminder_type = task.reminder_type;
    after.reminder_type = nextReminderType;
  }
  // The PM always sees the task; a participant keeps seeing it because only the PM changes assignees.
  const updated = await findVisibleTask({ projectId: project.id, taskId, actor });
  return { task: updated, before, after, addedAssigneeIds };
}

async function listTaskHistory({ tenantId, taskId }) {
  const { rows } = await db.query(
    `SELECT id, user_name, action, before_state, after_state, created_at
     FROM audit_logs
     WHERE tenant_id = $1 AND metadata->>'task_id' = $2
     ORDER BY created_at DESC
     LIMIT ${HISTORY_LIMIT}`,
    [tenantId, taskId],
  );
  return rows;
}

// Best effort: a failed notification must not fail the request that assigned the task.
async function notifyNewAssignees({ project, task, assigner, assigneeIds }) {
  const recipientIds = assigneeIds.filter((id) => id !== assigner.id);
  if (!recipientIds.length) return;
  try {
    const { rows: recipients } = await db.query(
      `SELECT u.email, u.display_name, u.locale AS user_locale, t.default_locale AS tenant_default_locale
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = ANY($1::uuid[]) AND u.is_active`, [recipientIds],
    );
    await Promise.all(recipients.map((recipient) => emailUtil.sendProjectTaskAssigned({
      to: recipient.email,
      locale: resolveLocale({ userLocale: recipient.user_locale, tenantDefaultLocale: recipient.tenant_default_locale }),
      assigneeName: recipient.display_name,
      assignerName: assigner.display_name,
      projectId: project.id,
      projectName: project.name,
      taskId: task.id,
      taskLabel: `${project.key}-${task.task_number}`,
      taskName: task.name,
      endDate: task.end_date,
    })));
  } catch (err) {
    logger.warn('Project task assignment email failed', { taskId: task.id, error: err.message });
  }
}

module.exports = {
  listTasks,
  getTask,
  createTask,
  updateTask,
  listTaskHistory,
  notifyNewAssignees,
};
