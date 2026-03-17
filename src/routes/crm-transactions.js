'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-transactions.js
//
// API platformy transakcyjnej (autentykacja kluczem API):
//   POST /api/crm/transactions           — push pojedynczej transakcji
//   POST /api/crm/transactions/batch     — push do 500 transakcji
//
// Endpointy wewnętrzne (autentykacja JWT):
//   GET  /api/crm/transactions           — lista z filtrami
//   GET  /api/crm/transactions/:id       — detail z produktami
//   PATCH /api/crm/transactions/:id/status
//   GET  /api/crm/transactions/report/summary
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const db    = require('../config/database');
const audit = require('../services/auditService');
const { requireAuth }                  = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, crmScope }            = require('../middleware/crm-rbac');

// ── API Key middleware ────────────────────────────────────────────
async function apiKeyAuth(req, res, next) {
  const key = req.headers['x-crm-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!key) return res.status(401).json({ error: 'Missing X-CRM-API-Key header' });

  try {
    const { rows } = await db.query(
      "SELECT value FROM app_settings WHERE key='crm_platform_api_key'", []
    );
    if (!rows.length || !rows[0].value || rows[0].value !== key) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    // Update last used timestamp (best effort)
    db.query("UPDATE app_settings SET updated_at=now() WHERE key='crm_platform_api_key'")
      .catch(() => {});
    next();
  } catch (err) { next(err); }
}

// ── Helper: upsert transaction + products ─────────────────────────
async function upsertTransaction(client, data) {
  const {
    external_id, partner_id, booking_ref, transaction_date,
    traveler_name, traveler_email, currency = 'PLN', status = 'confirmed',
    products = [],
  } = data;

  const totalNet        = products.reduce((s,p) => s + (parseFloat(p.net_cost)       || 0), 0);
  const totalGross      = products.reduce((s,p) => s + (parseFloat(p.gross_cost)      || 0), 0);
  const totalCommission = products.reduce((s,p) => s + (parseFloat(p.commission_amt)  || 0), 0);
  const totalMargin     = products.reduce((s,p) => s + (parseFloat(p.margin_amt)      || 0), 0);

  const { rows } = await client.query(`
    INSERT INTO crm_transactions
      (external_id, partner_id, booking_ref, transaction_date, traveler_name,
       traveler_email, total_net, total_gross, total_commission, total_margin,
       currency, status, raw_payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (external_id) DO UPDATE SET
      status           = EXCLUDED.status,
      total_net        = EXCLUDED.total_net,
      total_gross      = EXCLUDED.total_gross,
      total_commission = EXCLUDED.total_commission,
      total_margin     = EXCLUDED.total_margin,
      raw_payload      = EXCLUDED.raw_payload,
      updated_at       = now()
    RETURNING id
  `, [
    external_id, partner_id||null, booking_ref||null, transaction_date,
    traveler_name||null, traveler_email||null,
    totalNet, totalGross, totalCommission, totalMargin,
    currency, status, JSON.stringify(data),
  ]);

  const txnId = rows[0].id;

  await client.query('DELETE FROM crm_transaction_products WHERE transaction_id=$1', [txnId]);

  for (const p of products) {
    await client.query(`
      INSERT INTO crm_transaction_products (
        transaction_id, product_type, product_name, supplier, booking_ref,
        departure_at, arrival_at, origin_city, origin_country,
        destination_city, destination_country, duration_nights,
        hotel_name, hotel_stars, room_type, check_in, check_out,
        flight_number, airline, cabin_class, seat,
        car_category, pickup_location, dropoff_location,
        net_cost, gross_cost, commission_pct, commission_amt, margin_amt,
        currency, pax_count, notes
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
      )
    `, [
      txnId,
      p.product_type, p.product_name||null, p.supplier||null, p.booking_ref||null,
      p.departure_at||null, p.arrival_at||null,
      p.origin_city||null, p.origin_country||null,
      p.destination_city||null, p.destination_country||null, p.duration_nights||null,
      p.hotel_name||null, p.hotel_stars||null, p.room_type||null,
      p.check_in||null, p.check_out||null,
      p.flight_number||null, p.airline||null, p.cabin_class||null, p.seat||null,
      p.car_category||null, p.pickup_location||null, p.dropoff_location||null,
      parseFloat(p.net_cost)||0, parseFloat(p.gross_cost)||0,
      p.commission_pct != null ? parseFloat(p.commission_pct) : null,
      p.commission_amt != null ? parseFloat(p.commission_amt) : null,
      p.margin_amt     != null ? parseFloat(p.margin_amt)     : null,
      p.currency||'PLN', p.pax_count||1, p.notes||null,
    ]);
  }

  return txnId;
}

// ── POST /api/crm/transactions (platform push) ────────────────────
router.post('/',
  apiKeyAuth,
  [
    body('external_id').notEmpty().trim(),
    body('transaction_date').isISO8601(),
    body('partner_id').optional({ nullable: true }).isInt(),
    body('products').isArray({ min: 1 }),
    body('products.*.product_type').notEmpty().isIn([
      'hotel','transport_flight','transport_train','transport_bus','transport_ferry',
      'car_rental','transfer','travel_insurance','visa','other',
    ]),
    body('products.*.net_cost').isFloat({ min: 0 }),
    body('products.*.gross_cost').isFloat({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const txnId = await upsertTransaction(client, req.body);
      await client.query('COMMIT');
      res.status(201).json({ ok: true, id: txnId, external_id: req.body.external_id });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally { client.release(); }
  }
);

// ── POST /api/crm/transactions/batch ─────────────────────────────
router.post('/batch',
  apiKeyAuth,
  async (req, res, next) => {
    if (!Array.isArray(req.body) || req.body.length === 0) {
      return res.status(422).json({ error: 'Wymagana tablica transakcji' });
    }
    if (req.body.length > 500) {
      return res.status(422).json({ error: 'Maksymalnie 500 transakcji w jednej partii' });
    }

    const results = [];
    for (const txn of req.body) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const id = await upsertTransaction(client, txn);
        await client.query('COMMIT');
        results.push({ external_id: txn.external_id, ok: true, id });
      } catch (e) {
        await client.query('ROLLBACK');
        results.push({ external_id: txn.external_id, ok: false, error: e.message });
      } finally { client.release(); }
    }

    const failed = results.filter(r => !r.ok).length;
    res.status(failed === 0 ? 201 : 207).json({
      total: results.length,
      imported: results.filter(r => r.ok).length,
      failed,
      results,
    });
  }
);

// ── GET /api/crm/transactions ─────────────────────────────────────
router.get('/',
  requireAuth, injectAuditContext, crmAuth, crmScope,
  [
    query('partner_id').optional({ nullable: true }).isInt().toInt(),
    query('date_from').optional().isDate(),
    query('date_to').optional().isDate(),
    query('status').optional().isIn(['confirmed','cancelled','refunded']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const page   = req.query.page  || 1;
      const limit  = req.query.limit || 50;
      const offset = (page - 1) * limit;

      const params = [];
      let where = 'WHERE 1=1';

      if (!req.isCrmManager) {
        params.push(req.user.id);
        where += ` AND EXISTS (SELECT 1 FROM crm_partners p WHERE p.id = t.partner_id AND p.manager_id = $${params.length})`;
      }
      if (req.query.partner_id) { params.push(req.query.partner_id); where += ` AND t.partner_id = $${params.length}`; }
      if (req.query.date_from)  { params.push(req.query.date_from);  where += ` AND t.transaction_date >= $${params.length}`; }
      if (req.query.date_to)    { params.push(req.query.date_to);    where += ` AND t.transaction_date <= $${params.length}`; }
      if (req.query.status)     { params.push(req.query.status);     where += ` AND t.status = $${params.length}`; }

      const countParams = [...params];
      params.push(limit, offset);

      const [cnt, rows] = await Promise.all([
        db.query(`SELECT COUNT(*) FROM crm_transactions t ${where}`, countParams),
        db.query(`
          SELECT t.*, p.company AS partner_company,
            (SELECT json_agg(jsonb_build_object(
              'product_type',pr.product_type,'product_name',pr.product_name,
              'origin_city',pr.origin_city,'destination_city',pr.destination_city,
              'departure_at',pr.departure_at,'arrival_at',pr.arrival_at,
              'check_in',pr.check_in,'check_out',pr.check_out,
              'hotel_name',pr.hotel_name,'hotel_stars',pr.hotel_stars,'room_type',pr.room_type,
              'flight_number',pr.flight_number,'airline',pr.airline,'cabin_class',pr.cabin_class,
              'car_category',pr.car_category,'supplier',pr.supplier,
              'net_cost',pr.net_cost,'gross_cost',pr.gross_cost,
              'commission_pct',pr.commission_pct,'commission_amt',pr.commission_amt,
              'margin_amt',pr.margin_amt,'currency',pr.currency,'pax_count',pr.pax_count
            )) FROM crm_transaction_products pr WHERE pr.transaction_id = t.id) AS products
          FROM crm_transactions t
          LEFT JOIN crm_partners p ON p.id = t.partner_id
          ${where}
          ORDER BY t.transaction_date DESC
          LIMIT $${params.length-1} OFFSET $${params.length}
        `, params),
      ]);

      res.json({
        data:  rows.rows,
        total: parseInt(cnt.rows[0].count),
        page, limit,
        pages: Math.ceil(parseInt(cnt.rows[0].count) / limit),
      });
    } catch (err) { next(err); }
  }
);

// ── GET /api/crm/transactions/report/summary ──────────────────────
router.get('/report/summary',
  requireAuth, injectAuditContext, crmAuth, crmScope,
  [query('date_from').optional().isDate(), query('date_to').optional().isDate()],
  validate,
  async (req, res, next) => {
    try {
      const params = [];
      let where = "WHERE t.status='confirmed'";
      if (!req.isCrmManager) {
        params.push(req.user.id);
        where += ` AND EXISTS (SELECT 1 FROM crm_partners p WHERE p.id=t.partner_id AND p.manager_id=$${params.length})`;
      }
      if (req.query.date_from) { params.push(req.query.date_from); where += ` AND t.transaction_date>=$${params.length}`; }
      if (req.query.date_to)   { params.push(req.query.date_to);   where += ` AND t.transaction_date<=$${params.length}`; }

      const [summary, byPartner, byType, monthly] = await Promise.all([
        db.query(`
          SELECT
            COUNT(*)::int                              AS transaction_count,
            COALESCE(SUM(t.total_net),0)               AS total_net,
            COALESCE(SUM(t.total_gross),0)             AS total_gross,
            COALESCE(SUM(t.total_commission),0)        AS total_commission,
            COALESCE(SUM(t.total_margin),0)            AS total_margin,
            ROUND(AVG(t.total_gross),2)                AS avg_transaction_value,
            CASE WHEN SUM(t.total_gross) > 0
                 THEN ROUND(SUM(t.total_margin)/SUM(t.total_gross)*100, 2)
                 ELSE 0 END                            AS margin_pct
          FROM crm_transactions t ${where}
        `, params),
        db.query(`
          SELECT p.company, t.partner_id,
            COUNT(t.id)::int          AS txn_count,
            SUM(t.total_gross)        AS total_gross,
            SUM(t.total_margin)       AS total_margin,
            ROUND(SUM(t.total_margin)/NULLIF(SUM(t.total_gross),0)*100,2) AS margin_pct
          FROM crm_transactions t
          JOIN crm_partners p ON p.id = t.partner_id
          ${where} GROUP BY p.company, t.partner_id ORDER BY total_gross DESC
        `, params),
        db.query(`
          SELECT pr.product_type,
            COUNT(pr.id)::int            AS count,
            SUM(pr.gross_cost)           AS total_gross,
            SUM(pr.margin_amt)           AS total_margin,
            ROUND(AVG(pr.commission_pct)*100,2) AS avg_commission_pct
          FROM crm_transaction_products pr
          JOIN crm_transactions t ON t.id=pr.transaction_id
          ${where} GROUP BY pr.product_type ORDER BY total_gross DESC
        `, params),
        db.query(`
          SELECT TO_CHAR(DATE_TRUNC('month',t.transaction_date),'YYYY-MM') AS month,
            COUNT(t.id)::int  AS txn_count,
            SUM(t.total_gross) AS total_gross,
            SUM(t.total_margin) AS total_margin
          FROM crm_transactions t ${where}
          GROUP BY 1 ORDER BY 1
        `, params),
      ]);

      res.json({
        summary:          summary.rows[0],
        by_partner:       byPartner.rows,
        by_product_type:  byType.rows,
        monthly_trend:    monthly.rows,
      });
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/crm/transactions/:id/status ────────────────────────
router.patch('/:id/status',
  requireAuth, injectAuditContext, crmAuth,
  [param('id').isInt(), body('status').isIn(['confirmed','cancelled','refunded'])],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE crm_transactions SET status=$1, updated_at=now() WHERE id=$2 RETURNING *`,
        [req.body.status, parseInt(req.params.id)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Transakcja nie znaleziona' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

module.exports = router;
