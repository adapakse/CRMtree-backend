'use strict';
// routes/project-tasks.js — mounted at /api/projects/:id/tasks
//
// GET   /                  — tasks of the project (?mine=true → assigned to the caller)
// POST  /                  — create (PM)
// GET   /:taskId           — task with the caller's permissions on it
// PATCH /:taskId           — edit / change status, as far as the caller's role allows
// GET   /:taskId/history   — change history
// GET   /:taskId/messages  — chat thread of the task
// POST  /:taskId/messages
//
// Permission rules live in projectTaskService.

const router = require('express').Router({ mergeParams: true });
const { body, param, query } = require('express-validator');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/crm-rbac');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { loadProject, requireOpenProject } = require('../middleware/project-access');
const projectTaskService = require('../services/projectTaskService');
const projectMessageService = require('../services/projectMessageService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAnyUUID = (field) => field.matches(UUID_RE).withMessage('Invalid UUID');
const isDateOnly = (field) => field.isISO8601({ strict: true }).isLength({ min: 10, max: 10 });

router.use(
  requireAuth, injectAuditContext, requireFeature('projects'),
  [isAnyUUID(param('id'))], validate, loadProject,
);

const actorOf = (req) => ({
  user: req.user, membership: req.projectMembership, canManage: req.canManageProject,
});

function sendServiceError(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

function logTaskEvent(req, action, task, { beforeState, afterState } = {}) {
  return audit.log({
    user: req.user,
    action,
    beforeState,
    afterState,
    metadata: { project_id: req.project.id, task_id: task.id, task_number: task.task_number },
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
  });
}

function taskBodyRules({ isCreate }) {
  const name = body('name').isString().trim().notEmpty().isLength({ max: 300 });
  return [
    isCreate ? name : name.optional(),
    body('description').optional({ nullable: true }).isString().isLength({ max: 20000 }),
    isAnyUUID(body('type_id').optional({ nullable: true })),
    isAnyUUID(body('priority_id').optional({ nullable: true })),
    isAnyUUID(body('status_id').optional()),
    isDateOnly(body('start_date').optional({ nullable: true })),
    isDateOnly(body('end_date').optional({ nullable: true })),
    isAnyUUID(body('parent_task_id').optional({ nullable: true })),
    body('assignee_ids').optional().isArray({ max: 100 }),
    isAnyUUID(body('assignee_ids.*')),
    body('custom_values').optional().isObject(),
    body('reminder_type').optional({ nullable: true }).isIn(['at_due', '1d_before', '2d_before', '3d_before', 'custom']),
    body('reminder_at').optional({ nullable: true }).isISO8601(),
  ];
}

router.get('/', [query('mine').optional().isBoolean().toBoolean()], validate, async (req, res, next) => {
  try {
    res.json(await projectTaskService.listTasks({
      projectId: req.project.id, actor: actorOf(req), onlyMine: req.query.mine === true,
    }));
  } catch (err) { next(err); }
});

router.post('/', taskBodyRules({ isCreate: true }), validate, requireOpenProject, async (req, res, next) => {
  try {
    const { task, addedAssigneeIds } = await projectTaskService.createTask({
      tenantId: req.tenantId, project: req.project, actor: actorOf(req), input: req.body,
    });
    await logTaskEvent(req, 'project_task_created', task, {
      afterState: { name: task.name, status_id: task.status_id, assignee_ids: addedAssigneeIds },
    });
    await projectTaskService.notifyNewAssignees({
      project: req.project, task, assigner: req.user, assigneeIds: addedAssigneeIds,
    });
    res.status(201).json(task);
  } catch (err) { sendServiceError(err, res, next); }
});

router.get('/:taskId', [isAnyUUID(param('taskId'))], validate, async (req, res, next) => {
  try {
    const task = await projectTaskService.getTask({
      tenantId: req.tenantId, project: req.project, taskId: req.params.taskId, actor: actorOf(req),
    });
    if (!task) return res.status(404).json({ error: 'Nie znaleziono zadania' });
    res.json(task);
  } catch (err) { next(err); }
});

router.patch(
  '/:taskId',
  [isAnyUUID(param('taskId')), ...taskBodyRules({ isCreate: false })],
  validate,
  requireOpenProject,
  async (req, res, next) => {
    try {
      const { task, before, after, addedAssigneeIds } = await projectTaskService.updateTask({
        tenantId: req.tenantId,
        project: req.project,
        actor: actorOf(req),
        taskId: req.params.taskId,
        changes: req.body,
      });
      if (after) {
        await logTaskEvent(req, 'project_task_updated', task, { beforeState: before, afterState: after });
        await projectTaskService.notifyNewAssignees({
          project: req.project, task, assigner: req.user, assigneeIds: addedAssigneeIds,
        });
      }
      res.json(await projectTaskService.getTask({
        tenantId: req.tenantId, project: req.project, taskId: task.id, actor: actorOf(req),
      }));
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.get('/:taskId/history', [isAnyUUID(param('taskId'))], validate, async (req, res, next) => {
  try {
    const task = await projectTaskService.getTask({
      tenantId: req.tenantId, project: req.project, taskId: req.params.taskId, actor: actorOf(req),
    });
    if (!task) return res.status(404).json({ error: 'Nie znaleziono zadania' });
    res.json(await projectTaskService.listTaskHistory({ tenantId: req.tenantId, taskId: task.id }));
  } catch (err) { next(err); }
});

// Resolves :taskId to a task the caller may see; the thread is as visible as the task.
async function loadVisibleTask(req, res, next) {
  try {
    const task = await projectTaskService.getTask({
      tenantId: req.tenantId, project: req.project, taskId: req.params.taskId, actor: actorOf(req),
    });
    if (!task) return res.status(404).json({ error: 'Nie znaleziono zadania' });
    req.task = task;
    next();
  } catch (err) { next(err); }
}

router.get('/:taskId/messages', [isAnyUUID(param('taskId'))], validate, loadVisibleTask, async (req, res, next) => {
  try {
    res.json(await projectMessageService.listMessages({ projectId: req.project.id, taskId: req.task.id }));
  } catch (err) { next(err); }
});

router.post(
  '/:taskId/messages',
  [isAnyUUID(param('taskId')), body('body').isString().trim().notEmpty().isLength({ max: 4000 })],
  validate,
  requireOpenProject, loadVisibleTask,
  async (req, res, next) => {
    try {
      res.status(201).json(await projectMessageService.postMessage({
        tenantId: req.tenantId, projectId: req.project.id, taskId: req.task.id, author: req.user, body: req.body.body,
      }));
    } catch (err) { next(err); }
  },
);

module.exports = router;
