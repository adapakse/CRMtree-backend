'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/admin-billing.js
//
// Super-admin API for the "Rozliczenia" module — read-only over data
// produced by jobs/billing-run.js. Plan assignment to a tenant lives in
// admin-tenants.js (PUT /:id/subscription) — this file is invoices + the
// plan catalog only.
//
// GET /api/admin/billing/plans              — list billing plan catalog
// GET /api/admin/billing/invoices           — list invoices (filter + paginate)
// GET /api/admin/billing/invoices/:id/pdf   — download invoice PDF
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { param, query } = require('express-validator');
const db      = require('../config/database');
const storage = require('../services/storageService');
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
             i.status, i.pdf_blob_path, i.generated_at,
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

module.exports = router;
