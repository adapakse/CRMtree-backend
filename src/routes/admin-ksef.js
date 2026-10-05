'use strict';
// routes/admin-ksef.js — mounted at /api/admin/ksef
//
// KSeF configuration by the tenant admin (not the super admin).
//
// GET    /                  — settings and companies (never the token, only its last 4 characters)
// PUT    /settings          — how many days the first sync of a new company goes back
// POST   /companies         — add a company: the tenant's NIP + its KSeF token (verified against KSeF)
// PATCH  /companies/:id     — rename, or replace the token (verified; re-activates the company)
// DELETE /companies/:id     — remove a company; its synced invoices stay
//
// Every route answers 403 while the tenant has project finance switched off.

const router = require('express').Router();
const { body, param } = require('express-validator');
const audit = require('../services/auditService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireFeature } = require('../middleware/crm-rbac');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { requireFinanceEnabled } = require('../middleware/project-access');
const ksefCompanyService = require('../services/ksefCompanyService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAnyUUID = (field) => field.matches(UUID_RE).withMessage('Invalid UUID');
const isToken = (field) => field.isString().trim().notEmpty().isLength({ max: 500 });
const isCompanyName = (field) => field.optional({ nullable: true }).isString().trim().isLength({ max: 200 });

router.use(requireAuth, requireAdmin, injectAuditContext, requireFeature('projects'), requireFinanceEnabled);

function sendServiceError(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

// The audit entry never carries the token.
function logConfigEvent(req, area, afterState) {
  return audit.log({
    user: req.user,
    action: 'project_config_updated',
    afterState,
    metadata: { area },
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
  });
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await ksefCompanyService.getConfig(req.tenantId));
  } catch (err) { next(err); }
});

router.put(
  '/settings',
  [body('initial_sync_days').isInt({
    min: ksefCompanyService.MIN_INITIAL_SYNC_DAYS, max: ksefCompanyService.MAX_INITIAL_SYNC_DAYS,
  }).toInt()],
  validate,
  async (req, res, next) => {
    try {
      await ksefCompanyService.setInitialSyncDays(req.tenantId, req.body.initial_sync_days, req.user.id);
      await logConfigEvent(req, 'ksef_settings', { initial_sync_days: req.body.initial_sync_days });
      res.json(await ksefCompanyService.getConfig(req.tenantId));
    } catch (err) { next(err); }
  },
);

router.post(
  '/companies',
  [body('nip').isString().isLength({ max: 20 }), isToken(body('token')), isCompanyName(body('name'))],
  validate,
  async (req, res, next) => {
    try {
      const company = await ksefCompanyService.addCompany({
        tenantId: req.tenantId, userId: req.user.id, nip: req.body.nip, token: req.body.token, name: req.body.name,
      });
      await logConfigEvent(req, 'ksef_company_added', { company_id: company.id, nip: company.nip });
      res.status(201).json(company);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.patch(
  '/companies/:id',
  [isAnyUUID(param('id')), isToken(body('token').optional()), isCompanyName(body('name'))],
  validate,
  async (req, res, next) => {
    try {
      const company = await ksefCompanyService.updateCompany({
        tenantId: req.tenantId,
        companyId: req.params.id,
        changes: { token: req.body.token, name: req.body.name },
      });
      await logConfigEvent(req, 'ksef_company_updated', {
        company_id: company.id, nip: company.nip, is_token_replaced: req.body.token !== undefined,
      });
      res.json(company);
    } catch (err) { sendServiceError(err, res, next); }
  },
);

router.delete(
  '/companies/:id',
  [isAnyUUID(param('id'))],
  validate,
  async (req, res, next) => {
    try {
      const removed = await ksefCompanyService.removeCompany({ tenantId: req.tenantId, companyId: req.params.id });
      await logConfigEvent(req, 'ksef_company_removed', { company_id: removed.id, nip: removed.nip });
      res.status(204).end();
    } catch (err) { sendServiceError(err, res, next); }
  },
);

module.exports = router;
