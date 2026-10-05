'use strict';
// routes/ksef.js — mounted at /api/ksef
//
// The tenant's KSeF purchase invoices, for users holding the KSeF permission
// (users.can_view_ksef_invoices; the tenant admin always has it).
//
// GET  /invoices        — invoices issued in a period, with filters, newest first, paginated
// GET  /invoices/:id    — everything parsed from one invoice plus its links to project costs
// GET  /companies       — the synced companies and their sync state (no token data)
// POST /sync            — "sync now": starts a sync in the background and answers 202
//
// Every route answers 403 without the permission and while the tenant has
// project finance switched off. Linking an invoice to a cost item is done
// through /api/projects/:id/finance/costs.

const router = require('express').Router();
const { body, param, query } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/crm-rbac');
const { validate } = require('../middleware/errorHandler');
const { requireFinanceEnabled, requireKsefAccess } = require('../middleware/project-access');
const logger = require('../utils/logger');
const ksefApiClient = require('../services/ksefApiClient');
const ksefCompanyService = require('../services/ksefCompanyService');
const ksefInvoiceService = require('../services/ksefInvoiceService');
const ksefSyncService = require('../services/ksefSyncService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = 999999999999.99;
const MAX_PAGE_SIZE = 200;

const isAnyUUID = (field) => field.matches(UUID_RE).withMessage('Invalid UUID');
const isDateOnly = (field) => field.isISO8601({ strict: true }).isLength({ min: 10, max: 10 });
const isAmount = (field) => field.optional().isFloat({ min: -MAX_AMOUNT, max: MAX_AMOUNT }).toFloat();
const isSearchText = (field) => field.optional().isString().trim().isLength({ max: 200 });

router.use(requireAuth, requireFeature('projects'), requireFinanceEnabled, requireKsefAccess);

router.get(
  '/invoices',
  [
    isDateOnly(query('date_from').optional()),
    isDateOnly(query('date_to').optional()),
    isSearchText(query('seller')),
    isSearchText(query('invoice_number')),
    query('buyer_nip').optional().isString().trim().isLength({ max: 20 }),
    isAmount(query('net_min')),
    isAmount(query('net_max')),
    isAmount(query('gross_min')),
    isAmount(query('gross_max')),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('page_size').optional().isInt({ min: 1, max: MAX_PAGE_SIZE }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      res.json(await ksefInvoiceService.listInvoices({ tenantId: req.tenantId, filters: req.query }));
    } catch (err) { next(err); }
  },
);

router.get(
  '/invoices/:id',
  [isAnyUUID(param('id'))],
  validate,
  async (req, res, next) => {
    try {
      const invoice = await ksefInvoiceService.getInvoice({ tenantId: req.tenantId, invoiceId: req.params.id });
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      res.json(invoice);
    } catch (err) { next(err); }
  },
);

router.get('/companies', async (req, res, next) => {
  try {
    const companies = await ksefCompanyService.listCompanies(req.tenantId);
    res.json({
      is_configured: ksefApiClient.isConfigured(),
      companies: companies.map(({ id, nip, name, status, last_attempt_at, last_synced_at }) => (
        { id, nip, name, status, last_attempt_at, last_synced_at }
      )),
    });
  } catch (err) { next(err); }
});

// A sync can take minutes (KSeF prepares the export asynchronously), so the
// request only starts it. Progress shows as a new last_attempt_at on the
// company; a company that is already being synced is simply left to finish.
router.post(
  '/sync',
  [isAnyUUID(body('company_id').optional({ nullable: true }))],
  validate,
  (req, res) => {
    if (!ksefApiClient.isConfigured()) {
      return res.status(400).json({ error: 'KSeF integration is not configured' });
    }
    ksefSyncService.syncCompaniesOf({ tenantId: req.tenantId, companyId: req.body.company_id || null })
      .catch((err) => logger.error('[ksef-sync] Manual sync failed', { tenantId: req.tenantId, error: err.message }));
    return res.status(202).json({ status: 'started' });
  },
);

module.exports = router;
