'use strict';
// services/projectTaskListService.js
//
// The filterable task lists of the Projects module. One query serves three
// views that differ only in scope:
//   * projectScope   — the tasks of one project the actor may see;
//   * myTasksScope   — tasks of open projects assigned to the viewer;
//   * portfolioScope — tasks of the projects of the cross-project view.
// Each view has a paged list (searchTasks) and, for the timeline, the whole
// filtered set up to a cap (listForGantt).
//
// Rows are flat: a filtered page cannot be a tree, so a task carries its
// parent's id, number and name instead. The whole-project tree of the project
// view still comes from projectTaskService.listTasks.
//
// Filters: projectTaskFilters. Deadline fields: projectDeadlineService.

const db = require('../config/database');
const projectDeadlineService = require('./projectDeadlineService');
const { seesOnlyAssignedTasks } = require('./projectTaskService');
const { taskCostColumns, buildTaskFilterConditions, whereOf } = require('./projectTaskFilters');

const MAX_PAGE_SIZE = 50;
const GANTT_TASK_LIMIT = 500;

// Sort key → ORDER BY expressions over the `task` wrapper.
const SORT_EXPRESSIONS = {
  number:            ['task.project_key', 'task.task_number'],
  name:              ['lower(task.name)'],
  project:           ['lower(task.project_name)'],
  status:            ['task.status_sort_order', 'lower(task.status_name)'],
  priority:          ['task.priority_sort_order', 'lower(task.priority_name)'],
  type:              ['task.type_sort_order', 'lower(task.type_name)'],
  assignee:          ['task.first_assignee_name'],
  start_date:        ['task.start_date'],
  end_date:          ['task.end_date'],
  original_end_date: ['task.original_end_date'],
  slip_days:         ['task.slip_days'],
  days_overdue:      ['task.days_overdue'],
  timeliness:        [`CASE task.timeliness WHEN 'overdue' THEN 0 WHEN 'at_risk' THEN 1 WHEN 'on_time' THEN 2 END`],
  cost:              ['task.cost_total'],
};
const SORT_KEYS = Object.keys(SORT_EXPRESSIONS);
// Selected only to sort by; not part of a task row.
const SORT_HELPER_COLUMNS = ['status_sort_order', 'priority_sort_order', 'type_sort_order', 'first_assignee_name'];

function orderBy(sort, order) {
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  const expressions = SORT_EXPRESSIONS[sort].map((expression) => `${expression} ${direction} NULLS LAST`);
  // The tie-breaker keeps pages stable when the sorted column repeats.
  return [...expressions, 'task.project_key', 'task.task_number'].join(', ');
}

// A scope is { restrictedViewerId, defaultSort, build(addParam) } where build
// returns { joins, conditions, canReadFinance } — SQL over the aliases of the
// query below. `restrictedViewerId` is set for a viewer who sees only tasks
// assigned to them (see taskDeadlineColumns).

function projectScope({ project, actor, onlyMine, canReadFinance }) {
  const isRestricted = seesOnlyAssignedTasks(actor);
  return {
    restrictedViewerId: isRestricted ? actor.user.id : null,
    defaultSort: 'number',
    build: (addParam) => ({
      conditions: [
        `t.project_id = ${addParam(project.id)}`,
        ...(onlyMine || isRestricted ? [assignedTo(addParam(actor.user.id))] : []),
      ],
      canReadFinance: `${addParam(Boolean(canReadFinance))}::boolean`,
    }),
  };
}

// The cost of a task is shown only in projects whose finance the viewer may
// read: tenant admin, PM, controller (the rule of projectFinanceService.resolveAccess).
function myTasksScope({ tenantId, viewer, includeDone, isFinanceEnabled }) {
  return {
    restrictedViewerId: viewer.is_external ? viewer.id : null,
    defaultSort: 'end_date',
    build: (addParam) => {
      const viewerId = addParam(viewer.id);
      return {
        joins: `LEFT JOIN project_members viewer_membership
                       ON viewer_membership.project_id = p.id AND viewer_membership.user_id = ${viewerId}`,
        conditions: [
          `t.tenant_id = ${addParam(tenantId)}`,
          `p.status = 'open'`,
          `(${addParam(Boolean(includeDone))}::boolean OR s.category <> 'done')`,
          assignedTo(viewerId),
        ],
        canReadFinance: `(${addParam(Boolean(isFinanceEnabled))}::boolean
                          AND (${addParam(Boolean(viewer.is_admin))}::boolean
                               OR viewer_membership.role IN ('pm', 'controller')))`,
      };
    },
  };
}

// Everyone with the cross-project view (admin, PM, controller) may read the
// finance of the projects in their scope.
function portfolioScope({ scopeProjectIds, isFinanceEnabled }) {
  return {
    restrictedViewerId: null,
    defaultSort: 'end_date',
    build: (addParam) => ({
      conditions: [`t.project_id = ANY(${addParam(scopeProjectIds)}::uuid[])`],
      canReadFinance: `${addParam(Boolean(isFinanceEnabled))}::boolean`,
    }),
  };
}

function assignedTo(userPlaceholder) {
  return `EXISTS (SELECT 1 FROM project_task_assignees own
                  WHERE own.task_id = t.id AND own.user_id = ${userPlaceholder})`;
}

// Returns { from, params }: `from` is "FROM (...) task WHERE ..." ready for a
// SELECT list, an ORDER BY and a LIMIT.
function buildFilteredTasks(scope, filters) {
  const params = [projectDeadlineService.todayInWarsaw(), scope.restrictedViewerId];
  const addParam = (value) => { params.push(value); return `$${params.length}`; };
  const { joins = '', conditions, canReadFinance } = scope.build(addParam);
  const { inner, outer } = buildTaskFilterConditions(filters, addParam);
  // A restricted viewer learns the parent's number and name only when the parent is theirs too.
  const mayNameParent = `($2::uuid IS NULL OR EXISTS (
    SELECT 1 FROM project_task_assignees parent_assignee
    WHERE parent_assignee.task_id = parent.id AND parent_assignee.user_id = $2::uuid))`;
  const from = `FROM (
    SELECT t.id, t.project_id, p.key AS project_key, p.name AS project_name,
           t.task_number, t.name, t.start_date, t.end_date, t.parent_task_id,
           CASE WHEN ${mayNameParent} THEN parent.task_number END AS parent_task_number,
           CASE WHEN ${mayNameParent} THEN parent.name END AS parent_task_name,
           t.status_id, s.name AS status_name, s.category AS status_category, s.color AS status_color,
           t.priority_id, pr.name AS priority_name, pr.color AS priority_color,
           t.type_id, ty.name AS type_name, ty.color AS type_color,
           s.sort_order AS status_sort_order, pr.sort_order AS priority_sort_order, ty.sort_order AS type_sort_order,
           ${projectDeadlineService.taskDeadlineColumns({ today: '$1', onlyAssignedTo: '$2' })},
           ${taskCostColumns(canReadFinance)},
           COALESCE((
             SELECT json_agg(json_build_object('user_id', u.id, 'display_name', u.display_name)
                             ORDER BY u.last_name, u.first_name)
             FROM project_task_assignees a
             JOIN users u ON u.id = a.user_id
             WHERE a.task_id = t.id
           ), '[]'::json) AS assignees,
           (SELECT MIN(lower(u.display_name))
            FROM project_task_assignees a
            JOIN users u ON u.id = a.user_id
            WHERE a.task_id = t.id) AS first_assignee_name
    FROM project_tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN project_task_statuses s ON s.id = t.status_id
    LEFT JOIN project_task_priorities pr ON pr.id = t.priority_id
    LEFT JOIN project_task_types ty ON ty.id = t.type_id
    LEFT JOIN project_tasks parent ON parent.id = t.parent_task_id
    ${joins}
    ${whereOf([...conditions, ...inner])}
  ) task
  ${whereOf(outer)}`;
  return { from, params };
}

function toTaskRow(row) {
  const task = { ...row };
  for (const column of SORT_HELPER_COLUMNS) delete task[column];
  return task;
}

async function searchTasks({ scope, filters = {}, sort, order, page = 1, pageSize = MAX_PAGE_SIZE }) {
  const { from, params } = buildFilteredTasks(scope, filters);
  const [{ rows: [{ total }] }, { rows }] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total ${from}`, params),
    db.query(
      `SELECT * ${from}
       ORDER BY ${orderBy(sort || scope.defaultSort, order)}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
  ]);
  return { items: rows.map(toTaskRow), total, page, page_size: pageSize };
}

// A timeline needs every matching task at once; past the cap the answer is
// cut and flagged so the user narrows the filters.
async function listForGantt({ scope, filters = {} }) {
  const { from, params } = buildFilteredTasks(scope, filters);
  const { rows } = await db.query(
    `SELECT * ${from}
     ORDER BY task.project_key, task.task_number
     LIMIT ${GANTT_TASK_LIMIT + 1}`,
    params,
  );
  return {
    items: rows.slice(0, GANTT_TASK_LIMIT).map(toTaskRow),
    truncated: rows.length > GANTT_TASK_LIMIT,
    limit: GANTT_TASK_LIMIT,
  };
}

module.exports = {
  MAX_PAGE_SIZE,
  GANTT_TASK_LIMIT,
  SORT_KEYS,
  projectScope,
  myTasksScope,
  portfolioScope,
  searchTasks,
  listForGantt,
};
