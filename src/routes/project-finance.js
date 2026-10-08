'use strict';
// routes/project-finance.js — mounted at /api/projects/:id/finance
//
// GET    /                              — summary for the Finance tab (PM, admin, controller)
// PATCH  /                              — currency, planned revenue, category budgets,
//                                         "participants may add costs" (PM, admin)
// PUT    /tasks/:taskId/planned-cost    — planned cost of a task (PM, admin)
// GET    /costs                         — cost items (?task_id=); a participant gets only own items
// POST   /costs                         — with ksef_invoice_id: a cost item created from a KSeF invoice;
//                                         with document_id: from an invoice document
// PATCH  /costs/:itemId                 — ksef_invoice_id / document_id (uuid | null) attach / detach an invoice
// DELETE /costs/:itemId
// GET    /revenues                      — revenue items (PM, admin, controller)
// POST   /revenues                      — (PM, admin)
// PATCH  /revenues/:itemId
// DELETE /revenues/:itemId
//
// Every route answers 403 while the tenant has project finance switched off.
// Permission rules live in projectFinanceService.

const router = require('express').Router({ mergeParams: true });
const { body, param, query } = require('express-validator');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/crm-rbac');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const {
  loadProject, requireOpenProject, requireFinanceEnabled, loadFinanceAccess,
  requireFinanceRead, requireFinanceWrite, requireCostAccess, requireCostWriteAccess,
} = require('../middleware/project-access');
const projectFinanceService = require('../services/projectFinanceService');
const { roundMoney } = require('../services/projectFinanceCalculations');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
// Largest value a NUMERIC(14,2) column holds.
const MAX_AMOUNT = 999999999999.99;

const isAnyUUID = (field) => field.matches(UUID_RE).withMessage('Invalid UUID');
const isDateOnly = (field) => field.isISO8601({ strict: true }).isLength({ min: 10, max: 10 });
const isMoney = (field, min) => field.isFloat({ min, max: MAX_AMOUNT }).toFloat().customSanitizer(roundMoney);
const isPositiveMoney = (field) => isMoney(field, 0.01);
const isNonNegativeMoney = (field) => isMoney(field, 0);

router.use(
  requireAuth, injectAuditContext, requireFeature('projects'),
  [isAnyUUID(param('id'))], validate, loadProject, requireFinanceEnabled, loadFinanceAccess,
);

function sendServiceError(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

function logFinanceEvent(req, action, { beforeState, afterState, metadata } = {}) {
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

const summaryOf = (req) => projectFinanceService.getSummary({ tenantId: req.tenantId, project: req.project });

router.get('/', requireFinanceRead, async (req, res, next) => {
  try {
    res.json(await summaryOf(req));
  } catch (err) { sendServiceError(err, res, next); }
});

router.patch(
  '/',
  [
    body('currency').optional().matches(CURRENCY_RE),
    isNonNegativeMoney(body('planned_revenue').optional({ nullable: true })),
    body('participants_can_add_costs').optional().isBoolean({ strict: true }),
    body('category_budgets').optional().isArray({ max: 500 }),
    isAnyUUID(body('category_budgets.*.category_id')),
    isNonNegativeMoney(body('category_budgets.*.planned_cost')),
  ],
  validate,
  requireFinanceWrite, requireOpenProject,
  async (req, res, next) => {
    try {
      const { before, after } = await projectFinanceService.updateFinancePlan({
        tenantId: req.tenantId, project: req.project, changes: req.body,
      });
      await logFinanceEvent(req, 'project_updated', {
        beforeState: before, afterState: after, metadata: { area: 'finance_plan' },
      });
      res.json(await summaryOf(req));
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.put(
  '/tasks/:taskId/planned-cost',
  [isAnyUUID(param('taskId')), isNonNegativeMoney(body('planned_cost').optional({ nullable: true }))],
  validate,
  requireFinanceWrite, requireOpenProject,
  async (req, res, next) => {
    try {
      const change = await projectFinanceService.setTaskPlannedCost({
        projectId: req.project.id, taskId: req.params.taskId, plannedCost: req.body.planned_cost ?? null,
      });
      await logFinanceEvent(req, 'project_updated', {
        beforeState: { planned_cost: change.before },
        afterState: { planned_cost: change.after },
        metadata: { area: 'finance_task_planned_cost', task_number: change.task_number },
      });
      res.json({ task_id: change.task_id, planned_cost: change.after });
    } catch (err) { sendServiceError(err, res, next); }
  },
);

function costItemRules({ isCreate }) {
  const date = isDateOnly(body('date'));
  const category = isAnyUUID(body('category_id'));
  return [
    // On create the date may be left out only with ksef_invoice_id or
    // document_id (it then defaults to the invoice issue date) — the service
    // enforces that.
    date.optional(),
    isCreate ? category : category.optional(),
    isAnyUUID(body('ksef_invoice_id').optional({ nullable: true })),
    isAnyUUID(body('document_id').optional({ nullable: true })),
    isPositiveMoney(body('amount').optional({ nullable: true })),
    isPositiveMoney(body('original_amount').optional({ nullable: true })),
    body('original_currency').optional({ nullable: true }).matches(CURRENCY_RE),
    isAnyUUID(body('task_id').optional({ nullable: true })),
    body('status').optional().isIn(projectFinanceService.COST_STATUSES),
    body('description').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    body('supplier_name').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('document_number').optional({ nullable: true }).isString().isLength({ max: 100 }),
  ];
}

router.get(
  '/costs',
  [isAnyUUID(query('task_id').optional())],
  validate,
  requireCostAccess,
  async (req, res, next) => {
    try {
      res.json(await projectFinanceService.listCostItems({
        projectId: req.project.id, access: req.financeAccess, user: req.user, taskId: req.query.task_id,
      }));
    } catch (err) { next(err); }
  },
);

router.post(
  '/costs',
  costItemRules({ isCreate: true }),
  validate,
  requireCostWriteAccess, requireOpenProject,
  async (req, res, next) => {
    try {
      const { item, after } = await projectFinanceService.createCostItem({
        tenantId: req.tenantId, project: req.project, access: req.financeAccess, user: req.user, input: req.body,
      });
      await logFinanceEvent(req, 'project_cost_created', {
        afterState: after, metadata: { cost_item_id: item.id },
      });
      res.status(201).json(item);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.patch(
  '/costs/:itemId',
  [isAnyUUID(param('itemId')), ...costItemRules({ isCreate: false })],
  validate,
  requireCostWriteAccess, requireOpenProject,
  async (req, res, next) => {
    try {
      const { item, before, after } = await projectFinanceService.updateCostItem({
        tenantId: req.tenantId,
        project: req.project,
        access: req.financeAccess,
        user: req.user,
        itemId: req.params.itemId,
        changes: req.body,
      });
      if (after) {
        await logFinanceEvent(req, 'project_cost_updated', {
          beforeState: before, afterState: after, metadata: { cost_item_id: item.id },
        });
      }
      res.json(item);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.delete(
  '/costs/:itemId',
  [isAnyUUID(param('itemId'))],
  validate,
  requireCostWriteAccess, requireOpenProject,
  async (req, res, next) => {
    try {
      const { item, before } = await projectFinanceService.deleteCostItem({
        project: req.project, access: req.financeAccess, user: req.user, itemId: req.params.itemId,
      });
      await logFinanceEvent(req, 'project_cost_deleted', {
        beforeState: before, metadata: { cost_item_id: item.id },
      });
      res.status(204).end();
    } catch (err) { sendServiceError(err, res, next); }
  },
);

function revenueItemRules({ isCreate }) {
  const date = isDateOnly(body('date'));
  const amount = isPositiveMoney(body('amount'));
  return [
    isCreate ? date : date.optional(),
    isCreate ? amount : amount.optional(),
    body('status').optional().isIn(projectFinanceService.REVENUE_STATUSES),
    body('description').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ];
}

router.get('/revenues', requireFinanceRead, async (req, res, next) => {
  try {
    res.json(await projectFinanceService.listRevenueItems(req.project.id));
  } catch (err) { next(err); }
});

router.post(
  '/revenues',
  revenueItemRules({ isCreate: true }),
  validate,
  requireFinanceWrite, requireOpenProject,
  async (req, res, next) => {
    try {
      const { item, after } = await projectFinanceService.createRevenueItem({
        tenantId: req.tenantId, project: req.project, user: req.user, input: req.body,
      });
      await logFinanceEvent(req, 'project_revenue_created', {
        afterState: after, metadata: { revenue_item_id: item.id },
      });
      res.status(201).json(item);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.patch(
  '/revenues/:itemId',
  [isAnyUUID(param('itemId')), ...revenueItemRules({ isCreate: false })],
  validate,
  requireFinanceWrite, requireOpenProject,
  async (req, res, next) => {
    try {
      const { item, before, after } = await projectFinanceService.updateRevenueItem({
        project: req.project, itemId: req.params.itemId, changes: req.body,
      });
      if (after) {
        await logFinanceEvent(req, 'project_revenue_updated', {
          beforeState: before, afterState: after, metadata: { revenue_item_id: item.id },
        });
      }
      res.json(item);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.delete(
  '/revenues/:itemId',
  [isAnyUUID(param('itemId'))],
  validate,
  requireFinanceWrite, requireOpenProject,
  async (req, res, next) => {
    try {
      const { item, before } = await projectFinanceService.deleteRevenueItem({
        project: req.project, itemId: req.params.itemId,
      });
      await logFinanceEvent(req, 'project_revenue_deleted', {
        beforeState: before, metadata: { revenue_item_id: item.id },
      });
      res.status(204).end();
    } catch (err) { sendServiceError(err, res, next); }
  },
);

module.exports = router;
