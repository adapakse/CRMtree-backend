'use strict';
// routes/admin-project-config.js
//
// Tenant-admin configuration of the Projects module. Reading the
// configuration is open to every project user via GET /api/projects/config.
//
// PUT   /api/admin/project-config/finance                           — switch project finance on / off
// POST  /api/admin/project-config/dictionaries/:dictionary          — statuses | types | priorities |
//                                                                     cost-categories (finance on only)
// PATCH /api/admin/project-config/dictionaries/:dictionary/:id
// PUT   /api/admin/project-config/dictionaries/:dictionary/order
// PUT   /api/admin/project-config/transitions/:role                 — replace a role's allowed transitions
// POST  /api/admin/project-config/fields
// PATCH /api/admin/project-config/fields/:id

const router = require('express').Router();
const { body, param } = require('express-validator');
const audit = require('../services/auditService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireFeature } = require('../middleware/crm-rbac');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const projectConfigService = require('../services/projectConfigService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAnyUUID = (field) => field.matches(UUID_RE).withMessage('Invalid UUID');
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

router.use(requireAuth, requireAdmin, injectAuditContext, requireFeature('projects'));

// Runs a config mutation, records it in the audit log and answers with the
// tenant's full, fresh configuration so the settings screen needs no refetch.
function configMutation(area, mutate) {
  return async (req, res, next) => {
    try {
      await mutate(req);
      await audit.log({
        user: req.user,
        action: 'project_config_updated',
        afterState: req.body,
        metadata: { area, ...req.params },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });
      res.json(await projectConfigService.getConfig(req.tenantId));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
}

router.put(
  '/finance',
  [body('is_enabled').isBoolean({ strict: true })],
  validate,
  configMutation('finance', (req) =>
    projectConfigService.setFinanceEnabled(req.tenantId, req.body.is_enabled, req.user.id)),
);

// The cost category dictionary belongs to project finance and follows its switch.
async function requireFinanceForCostCategories(req, res, next) {
  try {
    if (req.params.dictionary !== projectConfigService.COST_CATEGORIES) return next();
    if (await projectConfigService.isFinanceEnabled(req.tenantId)) return next();
    return res.status(403).json({ error: 'Project finance is switched off' });
  } catch (err) { next(err); }
}

const dictionaryItemRules = [
  body('color').optional().matches(HEX_COLOR_RE),
  body('category').optional().isIn(projectConfigService.STATUS_CATEGORIES),
];

router.post(
  '/dictionaries/:dictionary',
  [body('name').isString().trim().notEmpty().isLength({ max: 80 }), ...dictionaryItemRules],
  validate,
  requireFinanceForCostCategories,
  configMutation('dictionary', (req) =>
    projectConfigService.createDictionaryItem(req.tenantId, req.params.dictionary, req.body)),
);

router.put(
  '/dictionaries/:dictionary/order',
  [body('ids').isArray({ min: 1, max: 500 }), isAnyUUID(body('ids.*'))],
  validate,
  requireFinanceForCostCategories,
  configMutation('dictionary_order', (req) =>
    projectConfigService.reorderDictionary(req.tenantId, req.params.dictionary, req.body.ids)),
);

router.patch(
  '/dictionaries/:dictionary/:id',
  [
    isAnyUUID(param('id')),
    body('name').optional().isString().trim().notEmpty().isLength({ max: 80 }),
    body('is_active').optional().isBoolean(),
    ...dictionaryItemRules,
  ],
  validate,
  requireFinanceForCostCategories,
  configMutation('dictionary', (req) =>
    projectConfigService.updateDictionaryItem(req.tenantId, req.params.dictionary, req.params.id, req.body)),
);

router.put(
  '/transitions/:role',
  [
    param('role').isIn(projectConfigService.TRANSITION_ROLES),
    body('transitions').isArray({ max: 2000 }),
    isAnyUUID(body('transitions.*.from_status_id')),
    isAnyUUID(body('transitions.*.to_status_id')),
  ],
  validate,
  configMutation('transitions', (req) =>
    projectConfigService.replaceRoleTransitions(req.tenantId, req.params.role, req.body.transitions)),
);

router.post(
  '/fields',
  [
    body('name').isString().trim().notEmpty().isLength({ max: 120 }),
    body('field_type').isIn(projectConfigService.FIELD_TYPES),
    body('options').optional().isArray(),
  ],
  validate,
  configMutation('field', (req) => projectConfigService.createFieldDefinition(req.tenantId, req.body)),
);

router.patch(
  '/fields/:id',
  [
    isAnyUUID(param('id')),
    body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
    body('is_active').optional().isBoolean(),
    body('options').optional().isArray(),
  ],
  validate,
  configMutation('field', (req) =>
    projectConfigService.updateFieldDefinition(req.tenantId, req.params.id, req.body)),
);

module.exports = router;
