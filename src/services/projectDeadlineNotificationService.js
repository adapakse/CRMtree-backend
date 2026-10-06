'use strict';
// services/projectDeadlineNotificationService.js
//
// Automatic deadline e-mails of the Projects module:
//   * end date of a task changed      — at once, to the project's PMs except
//                                       the PM who made the change;
//   * project became delayed          — at once, to the project's PMs, only
//                                       when a change flips the project from
//                                       not delayed to delayed by a task
//                                       ending after the project's end date;
//   * daily overdue summary           — once per person per day, from the
//                                       reminder job at 09:00 Europe/Warsaw:
//                                       own overdue tasks for every assignee,
//                                       overdue tasks and delayed projects for
//                                       every PM, both parts in one mail.
// A user may switch all of them off for themselves in "My settings"
// (users.project_deadline_notifications_enabled) — every project, both parts
// of the summary. Closed projects send nothing. The tenant admin gets these
// mails only as a PM. Language: the recipient's, as in every other mail.
//
// Everything here is best effort: a failed mail is logged and never fails the
// request or the job that triggered it.

const db = require('../config/database');
const logger = require('../utils/logger');
const emailUtil = require('../utils/email');
const { resolveLocale } = require('../config/locales');
const projectDeadlineService = require('./projectDeadlineService');
const { REMINDER_LOCAL_TIME } = require('./projectTaskService');

const localeOf = (recipient) => resolveLocale({
  userLocale: recipient.user_locale, tenantDefaultLocale: recipient.tenant_default_locale,
});

async function listNotifiedProjectManagers(projectId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.display_name, u.locale AS user_locale, tn.default_locale AS tenant_default_locale
     FROM project_members m
     JOIN users u ON u.id = m.user_id AND u.is_active AND u.project_deadline_notifications_enabled
     JOIN tenants tn ON tn.id = m.tenant_id
     WHERE m.project_id = $1 AND m.role = 'pm'`,
    [projectId],
  );
  return rows;
}

const taskLabelOf = (project, task) => `${project.key}-${task.task_number}`;

async function notifyEndDateChanged({ project, task, previousEndDate, changedBy, reason }) {
  try {
    const managers = await listNotifiedProjectManagers(project.id);
    const recipients = managers.filter((manager) => manager.id !== changedBy.id);
    await Promise.all(recipients.map((recipient) => emailUtil.sendProjectTaskEndDateChanged({
      to: recipient.email,
      locale: localeOf(recipient),
      recipientName: recipient.display_name,
      changedByName: changedBy.display_name || changedBy.email,
      projectId: project.id,
      projectName: project.name,
      taskId: task.id,
      taskLabel: taskLabelOf(project, task),
      taskName: task.name,
      previousEndDate,
      newEndDate: task.end_date,
      originalEndDate: task.original_end_date,
      slipDays: task.slip_days,
      reason,
    })));
  } catch (err) {
    logger.warn('Project task end date email failed', { taskId: task.id, error: err.message });
  }
}

// `wasDelayed` is the project's is_delayed read before the change was made.
async function notifyIfProjectBecameDelayed({ project, wasDelayed }) {
  try {
    if (wasDelayed) return;
    const delay = await projectDeadlineService.getProjectDelay(project.id);
    if (!delay?.delay_reasons.includes('task_after_end')) return;
    const { rows: [current] } = await db.query('SELECT end_date FROM projects WHERE id = $1', [project.id]);
    const recipients = await listNotifiedProjectManagers(project.id);
    await Promise.all(recipients.map((recipient) => emailUtil.sendProjectDelayed({
      to: recipient.email,
      locale: localeOf(recipient),
      recipientName: recipient.display_name,
      projectId: project.id,
      projectName: project.name,
      projectEndDate: current.end_date,
      tasksAfterEndCount: delay.delay_details.tasks_after_end_count,
      latestTaskEndDate: delay.delay_details.latest_task_end_date,
      daysAfterEnd: delay.delay_details.days_after_end,
    })));
  } catch (err) {
    logger.warn('Project delay email failed', { projectId: project.id, error: err.message });
  }
}

// ── Daily overdue summary ────────────────────────────────────────────────────

// requireFeature treats a tenant without a row as having the module on.
const PROJECTS_MODULE_ON = `NOT EXISTS (
  SELECT 1 FROM tenant_features feature
  WHERE feature.tenant_id = p.tenant_id AND feature.feature = 'projects' AND feature.is_enabled = FALSE
)`;

async function loadOverdueTasks({ today, tenantId }) {
  const { rows } = await db.query(
    `SELECT t.id, t.task_number, t.name, t.end_date,
            ($1::date - t.end_date) AS days_overdue,
            (t.end_date = $1::date - 1) AS is_new,
            t.project_id,
            COALESCE((
              SELECT json_agg(json_build_object('user_id', u.id, 'display_name', u.display_name)
                              ORDER BY u.last_name, u.first_name)
              FROM project_task_assignees a
              JOIN users u ON u.id = a.user_id
              WHERE a.task_id = t.id
            ), '[]'::json) AS assignees
     FROM project_tasks t
     JOIN projects p ON p.id = t.project_id
     JOIN project_task_statuses s ON s.id = t.status_id
     WHERE p.status = 'open'
       AND t.end_date < $1::date AND s.category <> 'done'
       AND ($2::uuid IS NULL OR p.tenant_id = $2::uuid)
       AND ${PROJECTS_MODULE_ON}
     ORDER BY (t.end_date = $1::date - 1) DESC, t.end_date, t.task_number`,
    [today, tenantId],
  );
  return rows;
}

async function loadDatedOpenProjects({ tenantId }) {
  const { rows } = await db.query(
    `SELECT p.id FROM projects p
     WHERE p.status = 'open' AND p.end_date IS NOT NULL
       AND ($1::uuid IS NULL OR p.tenant_id = $1::uuid)
       AND ${PROJECTS_MODULE_ON}`,
    [tenantId],
  );
  return rows.map((row) => row.id);
}

// One entry per person with something to report:
// { ownTasks: [task], managedProjects: [{ project, overdueTasks, delay }] }.
async function buildSummaries({ today, tenantId }) {
  const overdueTasks = await loadOverdueTasks({ today, tenantId });
  const delays = await projectDeadlineService.loadProjectDelays(await loadDatedOpenProjects({ tenantId }), today);
  const delayedProjectIds = [...delays].filter(([, delay]) => delay.is_delayed).map(([projectId]) => projectId);
  const projectIds = [...new Set([...overdueTasks.map((task) => task.project_id), ...delayedProjectIds])];
  if (!projectIds.length) return new Map();

  const [{ rows: projects }, { rows: managers }] = await Promise.all([
    db.query('SELECT id, key, name, end_date FROM projects WHERE id = ANY($1::uuid[]) ORDER BY name', [projectIds]),
    db.query(
      `SELECT project_id, user_id FROM project_members WHERE project_id = ANY($1::uuid[]) AND role = 'pm'`,
      [projectIds],
    ),
  ]);
  const projectById = new Map(projects.map((project) => [project.id, project]));

  const summaries = new Map();
  const summaryOf = (userId) => {
    if (!summaries.has(userId)) summaries.set(userId, { ownTasks: [], managedProjects: [] });
    return summaries.get(userId);
  };

  for (const task of overdueTasks) {
    const labelled = { ...task, project: projectById.get(task.project_id) };
    for (const assignee of task.assignees) summaryOf(assignee.user_id).ownTasks.push(labelled);
  }
  for (const project of projects) {
    const delay = delays.get(project.id);
    const report = {
      project,
      overdueTasks: overdueTasks.filter((task) => task.project_id === project.id),
      delay: delay?.is_delayed ? delay : null,
    };
    for (const manager of managers) {
      if (manager.project_id === project.id) summaryOf(manager.user_id).managedProjects.push(report);
    }
  }
  return summaries;
}

// Claims the person's summary for the day; false when it was already sent
// (an earlier tick, a restart or another replica of the backend).
async function claimSummary({ userId, tenantId, today }) {
  const { rows } = await db.query(
    `INSERT INTO project_deadline_digests (user_id, digest_date, tenant_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, digest_date) DO NOTHING RETURNING user_id`,
    [userId, today, tenantId],
  );
  return rows.length > 0;
}

// `tenantId` narrows the run to one tenant — the tests use it to stay inside
// their own data; the job runs for every tenant.
async function sendDailySummaries({ now = new Date(), tenantId = null } = {}) {
  if (projectDeadlineService.localTimeInWarsaw(now) < REMINDER_LOCAL_TIME) return { sentCount: 0 };
  const today = projectDeadlineService.todayInWarsaw(now);
  const summaries = await buildSummaries({ today, tenantId });
  if (!summaries.size) return { sentCount: 0 };

  const { rows: recipients } = await db.query(
    `SELECT u.id, u.email, u.display_name, u.tenant_id,
            u.locale AS user_locale, tn.default_locale AS tenant_default_locale
     FROM users u
     JOIN tenants tn ON tn.id = u.tenant_id
     WHERE u.id = ANY($1::uuid[]) AND u.is_active AND u.project_deadline_notifications_enabled`,
    [[...summaries.keys()]],
  );

  let sentCount = 0;
  for (const recipient of recipients) {
    if (!await claimSummary({ userId: recipient.id, tenantId: recipient.tenant_id, today })) continue;
    try {
      const summary = summaries.get(recipient.id);
      await emailUtil.sendProjectDeadlineSummary({
        to: recipient.email,
        locale: localeOf(recipient),
        recipientName: recipient.display_name,
        date: today,
        ownTasks: summary.ownTasks,
        managedProjects: summary.managedProjects,
      });
      sentCount++;
    } catch (err) {
      await db.query(
        'DELETE FROM project_deadline_digests WHERE user_id = $1 AND digest_date = $2', [recipient.id, today],
      );
      logger.error('[ProjectDeadlines] Daily summary failed', { userId: recipient.id, error: err.message });
    }
  }
  logger.info(`[ProjectDeadlines] Sent ${sentCount} daily summaries`);
  return { sentCount };
}

module.exports = {
  notifyEndDateChanged,
  notifyIfProjectBecameDelayed,
  sendDailySummaries,
};
