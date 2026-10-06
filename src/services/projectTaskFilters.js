'use strict';
// services/projectTaskFilters.js
//
// One filter set for every filterable task list of the Projects module: a
// project's tasks, "my tasks" and the cross-project view (the query itself is
// in projectTaskListService). The lists are paged, so every column is
// filtered here, on the server.
//
// The query must expose the aliases `t` (project_tasks), `s` (the task's
// status) and `p` (the project), and wrap its SELECT as `task` — the
// timeliness and cost conditions work on computed columns of that wrapper.
//
// Cost of a task = the sum of its OWN cost items (planned + incurred, not its
// subtasks'), in the currency of its project. Amounts of different projects
// are never converted, so across projects the range compares raw amounts.
// The total — and the cost filter — exist only where the viewer may read the
// project's finance; elsewhere the column is NULL and the filter lets the
// task through.

const UNASSIGNED = 'unassigned';
const DEFAULT_CURRENCY = 'PLN';

const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

// `canReadFinance` is a boolean SQL expression, evaluated per task.
function taskCostColumns(canReadFinance) {
  return `
    CASE WHEN ${canReadFinance} THEN (
      SELECT COALESCE(SUM(cost.amount), 0)::float FROM project_cost_items cost WHERE cost.task_id = t.id
    ) END AS cost_total,
    CASE WHEN ${canReadFinance} THEN COALESCE(
      (SELECT finance.currency FROM project_finance finance WHERE finance.project_id = t.project_id),
      '${DEFAULT_CURRENCY}'
    ) END AS cost_currency`;
}

// `addParam(value)` registers a query parameter and returns its placeholder.
// Returns { inner, outer }: conditions for inside and outside the `task` wrapper.
function buildTaskFilterConditions(filters, addParam) {
  const inner = [];
  const outer = [];
  const anyOf = (column, values, type) => {
    if (values?.length) inner.push(`${column} = ANY(${addParam(values)}::${type}[])`);
  };
  const range = (column, from, to) => {
    if (from) inner.push(`${column} >= ${addParam(from)}::date`);
    if (to) inner.push(`${column} <= ${addParam(to)}::date`);
  };

  if (filters.name) inner.push(`t.name ILIKE ${addParam(`%${escapeLike(filters.name)}%`)}`);
  if (filters.number) {
    inner.push(`(p.key || '-' || t.task_number) ILIKE ${addParam(`%${escapeLike(filters.number)}%`)}`);
  }
  anyOf('t.project_id', filters.projectIds, 'uuid');
  anyOf('t.status_id', filters.statusIds, 'uuid');
  anyOf('s.category', filters.statusCategories, 'text');
  anyOf('t.priority_id', filters.priorityIds, 'uuid');
  anyOf('t.type_id', filters.typeIds, 'uuid');
  if (filters.assignee === UNASSIGNED) {
    inner.push('NOT EXISTS (SELECT 1 FROM project_task_assignees anyone WHERE anyone.task_id = t.id)');
  } else if (filters.assignee) {
    inner.push(`EXISTS (SELECT 1 FROM project_task_assignees assigned
                        WHERE assigned.task_id = t.id AND assigned.user_id = ${addParam(filters.assignee)}::uuid)`);
  }
  range('t.start_date', filters.startFrom, filters.startTo);
  range('t.end_date', filters.endFrom, filters.endTo);
  range('t.original_end_date', filters.originalEndFrom, filters.originalEndTo);
  // Compared as a plain difference, so a task that never moved has a slip of 0 here.
  const slip = '(t.end_date - t.original_end_date)';
  if (filters.slipMin !== undefined) inner.push(`${slip} >= ${addParam(filters.slipMin)}::int`);
  if (filters.slipMax !== undefined) inner.push(`${slip} <= ${addParam(filters.slipMax)}::int`);

  if (filters.timeliness?.length) outer.push(`task.timeliness = ANY(${addParam(filters.timeliness)}::text[])`);
  if (filters.costMin !== undefined) {
    outer.push(`(task.cost_total IS NULL OR task.cost_total >= ${addParam(filters.costMin)}::numeric)`);
  }
  if (filters.costMax !== undefined) {
    outer.push(`(task.cost_total IS NULL OR task.cost_total <= ${addParam(filters.costMax)}::numeric)`);
  }
  return { inner, outer };
}

const whereOf = (conditions) => (conditions.length ? `WHERE ${conditions.join(' AND ')}` : '');

module.exports = { UNASSIGNED, taskCostColumns, buildTaskFilterConditions, whereOf };
