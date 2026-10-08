'use strict';
// services/projectDeadlineService.js
//
// Deadline control of the Projects module. Nothing here is stored as a status:
// every value is derived from dates when it is read. "Today" is the calendar
// date in Europe/Warsaw, the zone the module's reminders already use.
//
// Task timeliness (null for a task without an end date and for a done task):
//   overdue  — end date before today, status category not "done";
//   at_risk  — not overdue, status category "todo", end date within the
//              tenant's threshold (today … today + N days, inclusive);
//   on_time  — every other not-done task with an end date.
// A done task is instead "completed late" when it entered the done status
// after its end date. A task whose descendant is overdue only gets the weaker
// marker has_overdue_subtasks — it is not overdue itself.
//
// Project delay (only an open project with an end date can be delayed):
//   task_after_end — a not-done task ends after the project's end date;
//   end_passed     — the project's end date is before today and not-done
//                    tasks remain.

const db = require('../config/database');
const { AT_RISK_SETTING_KEY, DEFAULT_AT_RISK_THRESHOLD_DAYS } = require('./projectConfigService');

const TIME_ZONE = 'Europe/Warsaw';
const TIMELINESS_VALUES = ['overdue', 'at_risk', 'on_time'];

const AT_RISK_THRESHOLD_SQL = `COALESCE((
  SELECT threshold.value::int FROM app_settings threshold
  WHERE threshold.tenant_id = t.tenant_id AND threshold.key = '${AT_RISK_SETTING_KEY}'
), ${DEFAULT_AT_RISK_THRESHOLD_DAYS})`;

function todayInWarsaw(now = new Date()) {
  // en-CA prints a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function localTimeInWarsaw(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
}

// The SQL fragments below need the aliases `t` (project_tasks) and `s` (the
// task's status). `today` is the placeholder of the Warsaw date, e.g. "$2".
function timelinessSql(today) {
  return `CASE
    WHEN t.end_date IS NULL OR s.category = 'done' THEN NULL
    WHEN t.end_date < ${today}::date THEN 'overdue'
    WHEN s.category = 'todo' AND t.end_date <= ${today}::date + ${AT_RISK_THRESHOLD_SQL} THEN 'at_risk'
    ELSE 'on_time'
  END`;
}

// `onlyAssignedTo` is the placeholder of a user id (NULL at run time = no
// restriction): for an external participant only subtasks assigned to them
// raise has_overdue_subtasks, so the marker says nothing about tasks they
// cannot see.
function taskDeadlineColumns({ today, onlyAssignedTo = 'NULL' }) {
  return `
    t.original_end_date, t.completed_at,
    NULLIF(t.end_date - t.original_end_date, 0) AS slip_days,
    ${timelinessSql(today)} AS timeliness,
    CASE WHEN t.end_date < ${today}::date AND s.category <> 'done'
         THEN ${today}::date - t.end_date END AS days_overdue,
    (s.category = 'done' AND t.completed_at IS NOT NULL AND t.end_date IS NOT NULL
      AND (t.completed_at AT TIME ZONE '${TIME_ZONE}')::date > t.end_date) AS is_completed_late,
    EXISTS (
      WITH RECURSIVE descendant AS (
        SELECT child.id, child.end_date, child.status_id
        FROM project_tasks child WHERE child.parent_task_id = t.id
        UNION
        SELECT child.id, child.end_date, child.status_id
        FROM project_tasks child JOIN descendant ON child.parent_task_id = descendant.id
      )
      SELECT 1
      FROM descendant
      JOIN project_task_statuses descendant_status ON descendant_status.id = descendant.status_id
      WHERE descendant.end_date < ${today}::date AND descendant_status.category <> 'done'
        AND (${onlyAssignedTo}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM project_task_assignees descendant_assignee
          WHERE descendant_assignee.task_id = descendant.id
            AND descendant_assignee.user_id = ${onlyAssignedTo}::uuid))
    ) AS has_overdue_subtasks`;
}

// The delay of a project as SQL, so lists can filter and sort by it. A query
// with the alias `p` (projects) adds PROJECT_DELAY_JOIN and selects
// projectDelayColumns(); withProjectDelay() then turns the raw columns of a
// row into { is_delayed, delay_reasons, delay_details }.
const PROJECT_DELAY_JOIN = `CROSS JOIN LATERAL (
  SELECT COUNT(*) FILTER (WHERE s.category <> 'done')::int AS open_task_count,
         COUNT(*) FILTER (WHERE s.category <> 'done' AND t.end_date > p.end_date)::int AS tasks_after_end_count,
         MAX(t.end_date) FILTER (WHERE s.category <> 'done' AND t.end_date > p.end_date) AS latest_task_end_date
  FROM project_tasks t
  JOIN project_task_statuses s ON s.id = t.status_id
  WHERE t.project_id = p.id
) delay`;

function projectDelayColumns(today) {
  const canBeDelayed = `(p.status = 'open' AND p.end_date IS NOT NULL)`;
  return `
    delay.open_task_count, delay.tasks_after_end_count, delay.latest_task_end_date,
    delay.latest_task_end_date - p.end_date AS days_after_end,
    ${today}::date - p.end_date AS days_since_end,
    (${canBeDelayed} AND delay.tasks_after_end_count > 0) AS has_task_after_end,
    (${canBeDelayed} AND p.end_date < ${today}::date AND delay.open_task_count > 0) AS has_end_passed`;
}

function withProjectDelay(row) {
  const {
    open_task_count: openTaskCount, tasks_after_end_count: tasksAfterEndCount,
    latest_task_end_date: latestTaskEndDate, days_after_end: daysAfterEnd, days_since_end: daysSinceEnd,
    has_task_after_end: hasTaskAfterEnd, has_end_passed: hasEndPassed,
    ...project
  } = row;
  return {
    ...project,
    is_delayed: hasTaskAfterEnd || hasEndPassed,
    delay_reasons: [...(hasTaskAfterEnd ? ['task_after_end'] : []), ...(hasEndPassed ? ['end_passed'] : [])],
    delay_details: {
      open_task_count: openTaskCount,
      tasks_after_end_count: tasksAfterEndCount,
      latest_task_end_date: latestTaskEndDate,
      days_after_end: daysAfterEnd,
      days_past_end: hasEndPassed ? daysSinceEnd : null,
    },
  };
}

// Map of project id → { is_delayed, delay_reasons, delay_details }.
async function loadProjectDelays(projectIds, today = todayInWarsaw()) {
  if (!projectIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, ${projectDelayColumns('$2')}
     FROM projects p
     ${PROJECT_DELAY_JOIN}
     WHERE p.id = ANY($1::uuid[])`,
    [projectIds, today],
  );
  return new Map(rows.map((row) => {
    const { id, ...delay } = withProjectDelay(row);
    return [id, delay];
  }));
}

async function getProjectDelay(projectId) {
  return (await loadProjectDelays([projectId])).get(projectId);
}

// Open tasks per assignee of one project, plus the tasks nobody is assigned
// to. A task with several assignees counts for each of them.
async function loadAssigneeSummary(projectId, today = todayInWarsaw()) {
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.display_name,
            COUNT(*)::int AS open_task_count,
            COUNT(*) FILTER (WHERE open_task.timeliness = 'overdue')::int AS overdue_task_count,
            COUNT(*) FILTER (WHERE open_task.timeliness = 'at_risk')::int AS at_risk_task_count
     FROM (
       SELECT t.id, ${timelinessSql('$2')} AS timeliness
       FROM project_tasks t
       JOIN project_task_statuses s ON s.id = t.status_id
       WHERE t.project_id = $1 AND s.category <> 'done'
     ) open_task
     LEFT JOIN project_task_assignees a ON a.task_id = open_task.id
     LEFT JOIN users u ON u.id = a.user_id
     GROUP BY u.id, u.display_name, u.last_name, u.first_name
     ORDER BY u.last_name, u.first_name`,
    [projectId, today],
  );
  const counts = ({ open_task_count, overdue_task_count, at_risk_task_count }) =>
    ({ open_task_count, overdue_task_count, at_risk_task_count });
  const unassigned = rows.find((row) => row.user_id === null);
  return {
    people: rows.filter((row) => row.user_id !== null),
    unassigned: counts(unassigned || { open_task_count: 0, overdue_task_count: 0, at_risk_task_count: 0 }),
  };
}

module.exports = {
  TIME_ZONE,
  TIMELINESS_VALUES,
  todayInWarsaw,
  localTimeInWarsaw,
  timelinessSql,
  taskDeadlineColumns,
  PROJECT_DELAY_JOIN,
  projectDelayColumns,
  withProjectDelay,
  loadProjectDelays,
  getProjectDelay,
  loadAssigneeSummary,
};
