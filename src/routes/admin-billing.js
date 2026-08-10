'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/admin-billing.js
//
// Super-admin API for the "Rozliczenia" module — read-only over data
// produced by jobs/billing-run.js. Plan assignment to a tenant lives in
// admin-tenants.js (PUT /:id/subscription) — this file is invoices + the
// plan catalog only.
//
// GET  /api/admin/billing/plans              — list billing plan catalog
// GET  /api/admin/billing/seller-config       — CRMtree's own legal/seller data
// PUT  /api/admin/billing/seller-config       — update it (singleton row)
// GET  /api/admin/billing/invoices           — list invoices (filter + paginate)
// GET  /api/admin/billing/invoices/:id/pdf   — download invoice PDF
// POST /api/admin/billing/invoices/test-generate — manually generate one invoice
//      for local QA of the PDF layout. Reuses billing-run.js's own
//      generateInvoice() (same insert/PDF/audit path as the automatic batch)
//      instead of duplicating that logic — see jobs/billing-run.js.
// PUT  /api/admin/billing/invoices/:id/void  — void a wrongly-issued invoice
//      (reason required, never a physical delete/edit — see below). Voiding
//      frees its (tenant, period) up so a corrected invoice can be generated.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { param, query, body } = require('express-validator');
const db      = require('../config/database');
const storage = require('../services/storageService');
const logger  = require('../utils/logger');
const audit   = require('../services/auditService');
const billingRun = require('../jobs/billing-run');
const billing     = require('../services/billingService');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');

router.use(requireAuth, requireSuperAdmin);

router.get('/plans', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, code, name, price_monthly_eur, price_annual_eur, is_custom_pricing, is_active
       FROM billing_plans
       ORDER BY code`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/seller-config', async (req, res, next) => {
  try {
    res.json(await billing.getSellerConfig());
  } catch (err) { next(err); }
});

router.put('/seller-config',
  [
    body('company_name').optional({ nullable: true }).isString().trim().isLength({ max: 255 }),
    body('nip').optional({ nullable: true }).isString().trim().isLength({ max: 20 }),
    body('address').optional({ nullable: true }).isString().trim(),
    body('bank_account_number').optional({ nullable: true }).isString().trim().isLength({ max: 64 }),
    body('payment_term_days').optional().isInt({ min: 0, max: 365 }).toInt(),
  ], validate,
  async (req, res, next) => {
    try {
      const fields = ['company_name', 'nip', 'address', 'bank_account_number', 'payment_term_days'];
      const sets = [];
      const params = [];
      let p = 1;
      for (const f of fields) {
        if (req.body[f] !== undefined) { sets.push(`${f} = $${p++}`); params.push(req.body[f] || null); }
      }
      sets.push(`updated_at = NOW()`, `updated_by = $${p++}`);
      params.push(req.user.id);

      const { rows } = await db.query(
        `UPDATE billing_seller_config SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
        params
      );
      logger.info('Super admin updated billing seller config', { by: req.user.email });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.get('/invoices',
  [
    query('tenant_id').optional().isUUID(),
    query('billing_cycle').optional().isIn(['monthly', 'annual']),
    query('status').optional().isIn(['issued', 'void']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ], validate,
  async (req, res, next) => {
    try {
      const {
        tenant_id, billing_cycle, status,
        page = 1, limit = 50,
      } = req.query;

      const conditions = [];
      const params = [];
      let p = 1;

      if (tenant_id)     { conditions.push(`i.tenant_id = $${p++}`);     params.push(tenant_id); }
      if (billing_cycle) { conditions.push(`i.billing_cycle = $${p++}`); params.push(billing_cycle); }
      if (status)        { conditions.push(`i.status = $${p++}`);        params.push(status); }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const offset = (page - 1) * limit;

      const [dataResult, countResult] = await Promise.all([
        db.query(
          `SELECT
             i.id, i.invoice_number, i.billing_cycle, i.period_start, i.period_end,
             i.active_user_count, i.unit_price_eur, i.total_amount_eur, i.currency,
             i.status, i.pdf_blob_path, i.generated_at, i.due_date, i.void_reason, i.voided_at, i.vat_rate, i.vat_amount_eur,
             t.id AS tenant_id, t.name AS tenant_name,
             bp.code AS plan_code, bp.name AS plan_name
           FROM invoices i
           JOIN tenants t       ON t.id = i.tenant_id
           JOIN billing_plans bp ON bp.id = i.plan_id
           ${where}
           ORDER BY i.generated_at DESC
           LIMIT $${p} OFFSET $${p + 1}`,
          [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM invoices i ${where}`, params),
      ]);

      res.json({
        data: dataResult.rows,
        total: parseInt(countResult.rows[0].count, 10),
        page,
        limit,
        pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / limit),
      });
    } catch (err) { next(err); }
  }
);

// Manual invoice generation for local PDF QA — superadmin only (router-wide
// middleware above). Uses the tenant's saved plan/cycle and the most recently
// closed billing period, and inserts a normal invoices row via the same
// generateInvoice() the batch uses, so the resulting row/PDF is
// indistinguishable from a real one — including whether the PDF still shows
// the draft banner (see isInvoiceComplete() in invoicePdfService.js: drops
// once seller-config + this tenant's billing details are both filled in).
router.post('/invoices/test-generate',
  [body('tenant_id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const tenant = await billingRun.fetchBillableTenant(req.body.tenant_id);
      if (!tenant) {
        return res.status(400).json({ error: 'Tenant nie ma przypisanego planu lub jest nieaktywny.' });
      }
      if (tenant.is_custom_pricing && tenant.custom_price_eur == null) {
        return res.status(400).json({
          error: 'Plan Professional wymaga ustawienia indywidualnej kwoty (zakładka Plan) przed wygenerowaniem faktury.',
        });
      }

      const today = billingRun.getToday();
      const duePeriods = tenant.billing_cycle === 'monthly'
        ? billing.getDueMonthlyPeriods(tenant.started_at, today)
        : billing.getDueAnnualPeriods(tenant.started_at, today);
      const period = duePeriods[duePeriods.length - 1];
      if (!period) {
        return res.status(400).json({ error: 'Brak jeszcze zamkniętego okresu rozliczeniowego dla tego tenanta.' });
      }

      if (await billingRun.invoiceExists(tenant.tenant_id, period.start, period.end)) {
        return res.status(409).json({ error: 'Faktura za ostatni zamknięty okres już istnieje — zobacz listę faktur.' });
      }

      const invoice = await billingRun.generateInvoice(tenant, tenant.billing_cycle, period);
      if (!invoice) {
        return res.status(400).json({ error: 'Nie udało się wygenerować faktury — plan nie ma automatycznego cennika dla tego cyklu.' });
      }

      const { rows } = await db.query(
        `SELECT
           i.id, i.invoice_number, i.billing_cycle, i.period_start, i.period_end,
           i.active_user_count, i.unit_price_eur, i.total_amount_eur, i.currency,
           i.status, i.pdf_blob_path, i.generated_at, i.due_date, i.void_reason, i.voided_at, i.vat_rate, i.vat_amount_eur,
           t.id AS tenant_id, t.name AS tenant_name,
           bp.code AS plan_code, bp.name AS plan_name
         FROM invoices i
         JOIN tenants t        ON t.id = i.tenant_id
         JOIN billing_plans bp ON bp.id = i.plan_id
         WHERE i.id = $1`,
        [invoice.id]
      );

      logger.info('Super admin generated test invoice', {
        tenantId: tenant.tenant_id, invoiceId: invoice.id, by: req.user.email,
      });
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.get('/invoices/:id/pdf',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT invoice_number, pdf_blob_path FROM invoices WHERE id = $1`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
      const invoice = rows[0];
      if (!invoice.pdf_blob_path) return res.status(404).json({ error: 'PDF not generated yet' });

      const { buffer, contentType } = await storage.downloadDocument(invoice.pdf_blob_path);
      res.set({
        'Content-Type': contentType || 'application/pdf',
        'Content-Disposition': `attachment; filename="${invoice.invoice_number}.pdf"`,
      });
      res.send(buffer);
    } catch (err) { next(err); }
  }
);

// Void a wrongly-issued invoice — never a physical delete or edit of the
// financial fields (no such route exists). A reason is required and frozen
// onto the row alongside who/when, plus a full audit_logs entry. The invoice
// stays in the list forever with status 'void' — voiding just frees its
// (tenant, period) slot (partial unique index, migration 0240) so a
// corrected invoice can be generated for the same period. Correction
// invoices (KSeF "faktura korygująca") are out of scope for now.
router.put('/invoices/:id/void',
  [
    param('id').isUUID(),
    body('reason').isString().trim().isLength({ min: 3, max: 1000 }).withMessage('Podaj powód anulowania (min. 3 znaki).'),
  ], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE invoices
         SET status = 'void', void_reason = $2, voided_by = $3, voided_at = NOW()
         WHERE id = $1 AND status = 'issued'
         RETURNING *`,
        [req.params.id, req.body.reason, req.user.id]
      );
      if (!rows.length) {
        const { rows: existing } = await db.query(`SELECT id, status FROM invoices WHERE id = $1`, [req.params.id]);
        if (!existing.length) return res.status(404).json({ error: 'Invoice not found' });
        return res.status(409).json({ error: 'Faktura jest już anulowana.' });
      }
      const invoice = rows[0];

      await audit.log({
        user:        req.user,
        action:      'invoice_voided',
        beforeState: { status: 'issued' },
        afterState:  { status: 'void', reason: req.body.reason },
        metadata:    { invoice_id: invoice.id, tenant_id: invoice.tenant_id, invoice_number: invoice.invoice_number },
        ipAddress:   req.auditContext?.ipAddress,
      });

      logger.info('Super admin voided invoice', {
        invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, reason: req.body.reason, by: req.user.email,
      });
      res.json(invoice);
    } catch (err) { next(err); }
  }
);

module.exports = router;
