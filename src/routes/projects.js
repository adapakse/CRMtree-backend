'use strict';
// routes/projects.js
//
// Projects module — available to every authenticated user of a tenant with
// the `projects` feature, independent of CRM roles.
//
// GET    /api/projects/config                    — dictionaries, transitions, field definitions
// GET    /api/projects                           — projects the user is a member of (admin: all);
//                                                  finance totals for PM / admin / controller
// POST   /api/projects                           — create (admin or users.can_create_projects)
// GET    /api/projects/:id                       — project card: project, members, fields
// PATCH  /api/projects/:id                       — name / description / partner
// POST   /api/projects/:id/close | /reopen
// GET    /api/projects/:id/member-candidates     — tenant users not yet in the project
// POST   /api/projects/:id/members
// PATCH  /api/projects/:id/members/:userId
// DELETE /api/projects/:id/members/:userId
// PUT    /api/projects/:id/fields                — custom fields attached to the project
// PUT    /api/projects/:id/crm-link              — link to one lead or one partner (or unlink)
// GET    /api/projects/assigned-tasks            — open project tasks assigned to me / to given people
// GET    /api/projects/:id/messages              — general project chat
// POST   /api/projects/:id/messages

const router = require('express').Router();
const { body, param, query } = require('express-validator');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');
const { requireFeature, loadCrmScope } = require('../middleware/crm-rbac');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { loadProject, requireProjectManager, requireOpenProject } = require('../middleware/project-access');
const projectConfigService = require('../services/projectConfigService');
const projectService = require('../services/projectService');
const projectMessageService = require('../services/projectMessageService');
const projectCrmLinkService = require('../services/projectCrmLinkService');
const projectFinanceService = require('../services/projectFinanceService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAnyUUID = (field) => field.matches(UUID_RE).withMessage('Invalid UUID');

router.use(requireAuth, injectAuditContext, requireFeature('projects'));

function sendServiceError(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

function logProjectEvent(req, action, { beforeState, afterState, metadata } = {}) {
  return audit.log({
    user: req.user,
    action,
    beforeState,
    afterState,
    metadata: { project_id: req.project.id, project_key: req.project.key, ...metadata },
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
  });
}

const projectId = isAnyUUID(param('id'));

router.get('/config', async (req, res, next) => {
  try {
    res.json(await projectConfigService.getConfig(req.tenantId));
  } catch (err) { next(err); }
});

router.get(
  '/assigned-tasks',
  [
    query('assigned_to').optional().isString(),
    query('include_done').optional().isBoolean().toBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const requestedIds = (req.query.assigned_to || '').split(',').map((id) => id.trim()).filter(Boolean);
      if (requestedIds.some((id) => !UUID_RE.test(id))) {
        return res.status(400).json({ error: 'Invalid UUID' });
      }
      res.json(await projectCrmLinkService.listAssignedTasks({
        tenantId: req.tenantId,
        viewer: req.user,
        assigneeIds: requestedIds.length ? requestedIds : [req.user.id],
        includeDone: req.query.include_done === true,
      }));
    } catch (err) { next(err); }
  },
);

router.get(
  '/',
  [query('status').optional().isIn(['open', 'closed', 'all'])],
  validate,
  async (req, res, next) => {
    try {
      const projects = await projectService.listProjects({
        tenantId: req.tenantId, user: req.user, status: req.query.status || 'open',
      });
      const financeByProject = await projectFinanceService.loadTotalsForList({
        tenantId: req.tenantId, user: req.user, projects,
      });
      res.json({
        projects: projects.map((project) => ({ ...project, finance: financeByProject.get(project.id) ?? null })),
        can_create: Boolean(req.user.is_admin || req.user.can_create_projects),
      });
    } catch (err) { next(err); }
  },
);

router.post(
  '/',
  [
    body('name').isString().trim().notEmpty().isLength({ max: 200 }),
    body('description').optional({ nullable: true }).isString().isLength({ max: 20000 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      if (!req.user.is_admin && !req.user.can_create_projects) {
        return res.status(403).json({ error: 'Brak uprawnienia do zakładania projektów' });
      }
      const project = await projectService.createProject({
        tenantId: req.tenantId,
        user: req.user,
        name: req.body.name,
        description: req.body.description,
      });
      req.project = project;
      await logProjectEvent(req, 'project_created', { afterState: { name: project.name } });
      res.status(201).json(project);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.get('/:id', [projectId], validate, loadProject, async (req, res, next) => {
  try {
    const [members, fields, finance] = await Promise.all([
      projectService.listMembers(req.project.id),
      projectService.listProjectFields(req.project.id),
      projectFinanceService.describeAccess({
        tenantId: req.tenantId,
        project: req.project,
        membership: req.projectMembership,
        canManage: req.canManageProject,
      }),
    ]);
    res.json({
      project: req.project,
      members,
      fields,
      my_role: req.projectMembership?.role ?? null,
      my_access_level: req.projectMembership?.access_level ?? null,
      can_manage: req.canManageProject,
      finance,
    });
  } catch (err) { next(err); }
});

router.patch(
  '/:id',
  [
    projectId,
    body('name').optional().isString().trim().notEmpty().isLength({ max: 200 }),
    body('description').optional({ nullable: true }).isString().isLength({ max: 20000 }),
  ],
  validate,
  loadProject, requireProjectManager, requireOpenProject,
  async (req, res, next) => {
    try {
      const project = await projectService.updateProject({
        tenantId: req.tenantId, projectId: req.project.id, changes: req.body,
      });
      await logProjectEvent(req, 'project_updated', {
        beforeState: { name: req.project.name, description: req.project.description },
        afterState: { name: project.name, description: project.description },
      });
      res.json(project);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

function statusChangeHandler(status, action) {
  return async (req, res, next) => {
    try {
      if (req.project.status === status) return res.json(req.project);
      const project = await projectService.setProjectStatus({
        tenantId: req.tenantId, projectId: req.project.id, userId: req.user.id, status,
      });
      await logProjectEvent(req, action);
      res.json(project);
    } catch (err) { next(err); }
  };
}

router.post('/:id/close', [projectId], validate, loadProject, requireProjectManager,
  statusChangeHandler('closed', 'project_closed'));

router.post('/:id/reopen', [projectId], validate, loadProject, requireProjectManager,
  statusChangeHandler('open', 'project_reopened'));

router.get(
  '/:id/member-candidates',
  [projectId, query('search').optional().isString().trim().isLength({ max: 100 })],
  validate,
  loadProject, requireProjectManager,
  async (req, res, next) => {
    try {
      res.json(await projectService.listMemberCandidates({
        tenantId: req.tenantId, projectId: req.project.id, search: req.query.search,
      }));
    } catch (err) { next(err); }
  },
);

router.post(
  '/:id/members',
  [
    projectId,
    isAnyUUID(body('user_id')),
    body('role').isIn(projectService.PROJECT_ROLES),
    body('access_level').optional().isIn(projectService.ACCESS_LEVELS),
  ],
  validate,
  loadProject, requireProjectManager, requireOpenProject,
  async (req, res, next) => {
    try {
      const member = await projectService.addMember({
        tenantId: req.tenantId,
        projectId: req.project.id,
        userId: req.body.user_id,
        role: req.body.role,
        accessLevel: req.body.access_level,
        addedBy: req.user.id,
      });
      await logProjectEvent(req, 'project_member_added', {
        afterState: member, metadata: { target_user_id: req.body.user_id },
      });
      res.status(201).json(await projectService.listMembers(req.project.id));
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.patch(
  '/:id/members/:userId',
  [
    projectId,
    isAnyUUID(param('userId')),
    body('role').optional().isIn(projectService.PROJECT_ROLES),
    body('access_level').optional().isIn(projectService.ACCESS_LEVELS),
  ],
  validate,
  loadProject, requireProjectManager, requireOpenProject,
  async (req, res, next) => {
    try {
      const change = await projectService.updateMember({
        projectId: req.project.id,
        userId: req.params.userId,
        role: req.body.role,
        accessLevel: req.body.access_level,
      });
      await logProjectEvent(req, 'project_member_updated', {
        beforeState: change.before, afterState: change.after,
        metadata: { target_user_id: req.params.userId },
      });
      res.json(await projectService.listMembers(req.project.id));
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.delete(
  '/:id/members/:userId',
  [projectId, isAnyUUID(param('userId'))],
  validate,
  loadProject, requireProjectManager, requireOpenProject,
  async (req, res, next) => {
    try {
      const removed = await projectService.removeMember({
        projectId: req.project.id, userId: req.params.userId,
      });
      await logProjectEvent(req, 'project_member_removed', {
        beforeState: removed, metadata: { target_user_id: req.params.userId },
      });
      res.json(await projectService.listMembers(req.project.id));
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.put(
  '/:id/fields',
  [
    projectId,
    body('fields').isArray({ max: 100 }),
    isAnyUUID(body('fields.*.field_definition_id')),
    body('fields.*.is_required').optional().isBoolean(),
  ],
  validate,
  loadProject, requireProjectManager, requireOpenProject,
  async (req, res, next) => {
    try {
      const fields = await projectService.replaceProjectFields({
        tenantId: req.tenantId, projectId: req.project.id, fields: req.body.fields,
      });
      await logProjectEvent(req, 'project_updated', {
        afterState: { fields: fields.map((field) => ({ id: field.field_definition_id, is_required: field.is_required })) },
      });
      res.json(fields);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

// Linking needs CRM access: the PM picks a lead or partner they can see in the CRM.
function requireCrmAccess(req, res, next) {
  if (req.user.is_admin || req.user.crm_role) return next();
  return res.status(403).json({ error: 'Powiązanie z leadem lub partnerem wymaga dostępu do CRM' });
}

router.put(
  '/:id/crm-link',
  [
    projectId,
    body('lead_id').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
    body('partner_ref').optional({ nullable: true }).isString().isLength({ max: 40 }),
  ],
  validate,
  loadProject, requireProjectManager, requireOpenProject, requireCrmAccess, loadCrmScope,
  async (req, res, next) => {
    try {
      const link = await projectCrmLinkService.setCrmLink({
        tenantId: req.tenantId,
        projectId: req.project.id,
        leadId: req.body.lead_id || null,
        partnerRef: req.body.partner_ref || null,
        crmScopeUserIds: req.crmScopeUserIds,
      });
      await logProjectEvent(req, 'project_updated', {
        beforeState: { lead_id: req.project.lead_id, partner_id: req.project.partner_id },
        afterState: { lead_id: link.lead_id, partner_id: link.partner_id },
      });
      res.json(link);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.get('/:id/messages', [projectId], validate, loadProject, async (req, res, next) => {
  try {
    res.json(await projectMessageService.listMessages({ projectId: req.project.id }));
  } catch (err) { next(err); }
});

router.post(
  '/:id/messages',
  [projectId, body('body').isString().trim().notEmpty().isLength({ max: 4000 })],
  validate,
  loadProject, requireOpenProject,
  async (req, res, next) => {
    try {
      res.status(201).json(await projectMessageService.postMessage({
        tenantId: req.tenantId, projectId: req.project.id, author: req.user, body: req.body.body,
      }));
    } catch (err) { next(err); }
  },
);

module.exports = router;
