'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-budgets.js
// Planowane budżety sprzedażowe — CRUD
// Dostępne dla: sales_manager (CRUD) + salesperson (tylko GET własne)
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, requireCrmManager } = require('../middleware/crm-rbac');

router.use(requireAuth, injectAuditContext, crmAuth);

// ── GET /api/crm/budgets/total ─────────────────────────────────────────────
// Suma planowanego budżetu dla wybranego okresu i/lub handlowca.
// Używane przez Raporty Sprzedaży do wyświetlenia kafelka Planowany Budżet.
router.get('/total',
  [
    query('year').optional().isInt({ min: 2020, max: 2100 }).toInt(),
    query('date_from').optional().isDate(),
    query('date_to').optional().isDate(),
    query('assigned_to').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const now    = new Date();
      const year   = req.query.year || now.getFullYear();
      const userId = req.isCrmManager
        ? (req.query.assigned_to || null)
        : req.user.id;

      const dateFrom = req.query.date_from
        ? new Date(req.query.date_from)
        : new Date(year, 0, 1);
      const dateTo = req.query.date_to
        ? new Date(req.query.date_to)
        : new Date(year, 11, 31);

      const params = [year];
      let where = 'WHERE b.year = $1';
      if (userId) { params.push(userId); where += ` AND b.user_id = $${params.length}`; }

      const { rows } = await db.query(`
        SELECT b.period_type, b.period_number, b.amount::float AS amount
        FROM crm_sales_budgets b
        ${where}
      `, params);

      // Filtruj okresy które nakładają się z wybranym zakresem dat
      let total = 0;
      for (const row of rows) {
        let pStart, pEnd;
        if (row.period_type === 'month') {
          pStart = new Date(year, row.period_number - 1, 1);
          pEnd   = new Date(year, row.period_number, 0);
        } else {
          const qBase = (row.period_number - 1) * 3;
          pStart = new Date(year, qBase, 1);
          pEnd   = new Date(year, qBase + 3, 0);
        }
        if (pStart <= dateTo && pEnd >= dateFrom) {
          total += Number(row.amount);
        }
      }

      res.json({ total, year, currency: 'PLN' });
    } catch (err) { next(err); }
  }
);

// ── GET /api/crm/budgets ───────────────────────────────────────────────────
// Lista budżetów dla wybranego user_id + year.
router.get('/',
  [
    query('user_id').optional().isUUID(),
    query('year').optional().isInt({ min: 2020, max: 2100 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const year   = req.query.year || new Date().getFullYear();
      const userId = req.isCrmManager
        ? (req.query.user_id || null)
        : req.user.id;

      const params = [year];
      let where = 'WHERE b.year = $1';
      if (userId) { params.push(userId); where += ` AND b.user_id = $${params.length}`; }

      const { rows } = await db.query(`
        SELECT b.*, u.display_name AS user_name
        FROM crm_sales_budgets b
        JOIN users u ON u.id = b.user_id
        ${where}
        ORDER BY b.user_id, b.period_type, b.period_number
      `, params);

      res.json(rows);
    } catch (err) { next(err); }
  }
);

// ── POST /api/crm/budgets ─────────────────────────────────────────────────
// Utwórz lub zaktualizuj (upsert) wpis budżetowy.
router.post('/',
  requireCrmManager,
  [
    body('user_id').isUUID(),
    body('year').isInt({ min: 2020, max: 2100 }),
    body('period_type').isIn(['month', 'quarter']),
    body('period_number').isInt({ min: 1, max: 12 }),
    body('amount').isFloat({ min: 0 }),
    body('currency').optional().isString().isLength({ min: 3, max: 3 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { user_id, year, period_type, period_number, amount, currency = 'PLN' } = req.body;

      // Walidacja zakresu period_number
      if (period_type === 'quarter' && period_number > 4) {
        return res.status(400).json({ error: 'Kwartał musi być w zakresie 1-4' });
      }

      // Spójność: na dany rok/user może być tylko jeden typ okresu
      const { rows: existing } = await db.query(
        `SELECT DISTINCT period_type FROM crm_sales_budgets WHERE user_id=$1 AND year=$2 AND period_type != $3`,
        [user_id, year, period_type]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          error: `Na rok ${year} zdefiniowano już budżety w typie "${existing[0].period_type}". Usuń istniejące przed zmianą typu okresu.`,
          existing_type: existing[0].period_type,
        });
      }

      const { rows } = await db.query(`
        INSERT INTO crm_sales_budgets
          (user_id, year, period_type, period_number, amount, currency, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (user_id, year, period_type, period_number)
        DO UPDATE SET amount=$5, currency=$6, updated_at=NOW()
        RETURNING *
      `, [user_id, year, period_type, period_number, amount, currency, req.user.id]);

      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/crm/budgets/by-user ───────────────────────────────────────
// Usuń wszystkie budżety dla danego user/year (przy zmianie typu okresu).
router.delete('/by-user',
  requireCrmManager,
  [
    query('user_id').isUUID(),
    query('year').isInt({ min: 2020, max: 2100 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      await db.query(
        'DELETE FROM crm_sales_budgets WHERE user_id=$1 AND year=$2',
        [req.query.user_id, parseInt(req.query.year)]
      );
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/crm/budgets/:id ───────────────────────────────────────────
router.delete('/:id',
  requireCrmManager,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      await db.query('DELETE FROM crm_sales_budgets WHERE id=$1', [parseInt(req.params.id)]);
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
