'use strict';
// src/routes/crm-churn.js
//
// GET  /api/crm/churn          – lista partnerów z ryzykiem churn (z filtrami)
// POST /api/crm/churn/generate – tworzy zadania i wysyła emaile

const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth }                            = require('../middleware/auth');
const { crmAuth, requireCrmManager, loadCrmScope, requireFeature } = require('../middleware/crm-rbac');
const { sendCrmActivityAssigned }                = require('../utils/email');

router.use(requireAuth, crmAuth, requireFeature('dwh_integration'));

// ─── Domyślne parametry algorytmu ─────────────────────────────────────────────
const DEFAULTS = {
  days_t1_min:   10,
  days_t1_max:   20,
  days_t1_pts:   10,
  days_t2_min:   21,
  days_t2_max:   30,
  days_t2_pts:   20,
  days_t3_pts:   50,
  sales_t1_pct:  30,
  sales_t2_pct:  51,
  sales_t1_pts:  30,
  sales_t2_pts:  50,
  risk_critical: 91,
  risk_high:     71,
  risk_medium:   51,
  risk_low:      21,
};

async function loadSettings(tenantId) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM app_settings WHERE key LIKE 'churn_%' AND tenant_id = $1`,
      [tenantId]
    );
    const s = { ...DEFAULTS };
    for (const r of rows) {
      const k = r.key.replace('churn_', '');
      if (k in s) {
        const v = parseFloat(r.value);
        if (!isNaN(v)) s[k] = v;
      }
    }
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

// ─── SQL CTE z obliczaniem wskaźnika churn ─────────────────────────────────────
// Uwaga: wartości s.* są liczbami całkowitymi z app_settings (trusted source),
// nie z inputu użytkownika — bezpieczne do interpolacji w SQL.
function buildChurnCte(pfx, s) {
  return `
    WITH
    m1 AS (
      SELECT partner_id,
             SUM(gross_sales_value_pln) AS sales
      FROM dwh.${pfx}_sales
      WHERE TO_CHAR(sale_date, 'YYYY-MM') = TO_CHAR(CURRENT_DATE - INTERVAL '1 month', 'YYYY-MM')
      GROUP BY partner_id
    ),
    m2 AS (
      SELECT partner_id,
             SUM(gross_sales_value_pln) AS sales
      FROM dwh.${pfx}_sales
      WHERE TO_CHAR(sale_date, 'YYYY-MM') = TO_CHAR(CURRENT_DATE - INTERVAL '2 months', 'YYYY-MM')
      GROUP BY partner_id
    ),
    last_ord AS (
      SELECT partner_id,
             MAX(sale_date) AS last_date
      FROM dwh.${pfx}_sales
      GROUP BY partner_id
    ),
    scored AS (
      SELECT
        p.id                                                        AS partner_id,
        p.company,
        COALESCE(dm.company_name, dm.name, p.company)              AS display_name,
        p.manager_id,
        u.id                                                        AS salesperson_id,
        u.display_name                                              AS salesperson_name,
        u.email                                                     AS salesperson_email,
        lo.last_date,
        (CURRENT_DATE - lo.last_date::date)::int                   AS days_since_order,
        COALESCE(m1.sales, 0)::numeric(14,2)                       AS sales_m1,
        COALESCE(m2.sales, 0)::numeric(14,2)                       AS sales_m2,
        CASE
          WHEN m2.sales > 0
          THEN ROUND(((m2.sales - COALESCE(m1.sales, 0)) / m2.sales * 100)::numeric, 1)
          ELSE 0
        END                                                         AS sales_drop_pct,
        -- punkty za dni bez zamówienia
        CASE
          WHEN (CURRENT_DATE - lo.last_date::date)
               BETWEEN ${s.days_t1_min} AND ${s.days_t1_max}       THEN ${s.days_t1_pts}
          WHEN (CURRENT_DATE - lo.last_date::date)
               BETWEEN ${s.days_t2_min} AND ${s.days_t2_max}       THEN ${s.days_t2_pts}
          WHEN (CURRENT_DATE - lo.last_date::date) > ${s.days_t2_max} THEN ${s.days_t3_pts}
          ELSE 0
        END                                                         AS days_score,
        -- punkty za spadek sprzedaży M-2 → M-1
        CASE
          WHEN m2.sales > 0
           AND ((m2.sales - COALESCE(m1.sales, 0)) / m2.sales * 100) >= ${s.sales_t2_pct}
                                                                    THEN ${s.sales_t2_pts}
          WHEN m2.sales > 0
           AND ((m2.sales - COALESCE(m1.sales, 0)) / m2.sales * 100) >= ${s.sales_t1_pct}
                                                                    THEN ${s.sales_t1_pts}
          ELSE 0
        END                                                         AS sales_score
      FROM crm_partners p
      LEFT JOIN users u
        ON u.id = p.manager_id AND u.tenant_id = $1
      LEFT JOIN dwh.${pfx}_partner dm
        ON dm.partner_id = p.dwh_partner_id
      LEFT JOIN last_ord lo
        ON lo.partner_id = p.dwh_partner_id
      LEFT JOIN m1 ON m1.partner_id = p.dwh_partner_id
      LEFT JOIN m2 ON m2.partner_id = p.dwh_partner_id
      WHERE p.tenant_id = $1
        AND p.status = 'active'
        AND p.dwh_partner_id IS NOT NULL
        AND COALESCE(dm.is_test_account, false) = false
    )
    SELECT *,
      (days_score + sales_score) AS total_score,
      CASE
        WHEN (days_score + sales_score) >= ${s.risk_critical} THEN 'critical'
        WHEN (days_score + sales_score) >= ${s.risk_high}     THEN 'high'
        WHEN (days_score + sales_score) >= ${s.risk_medium}   THEN 'medium'
        WHEN (days_score + sales_score) >= ${s.risk_low}      THEN 'low'
        ELSE 'none'
      END AS risk_level
    FROM scored
    WHERE (days_score + sales_score) >= ${s.risk_low}
  `;
}

// ─────────────────────────────────────────────────────────────────
// GET / – lista partnerów z ryzykiem churn
// query: partner_name, salesperson_id, risk_level
// ─────────────────────────────────────────────────────────────────
router.get('/', loadCrmScope, async (req, res, next) => {
  try {
    const s   = await loadSettings(req.tenantId);
    const pfx = req.dwhPrefix;
    const params = [req.tenantId];
    const filters = [];

    // RBAC: handlowiec widzi tylko swoje
    if (!req.isCrmManager && !req.crmGlobalRead) {
      params.push(req.user.id);
      filters.push(`manager_id = $${params.length}`);
    }

    // Filtry z query
    if (req.query.partner_name) {
      params.push(`%${req.query.partner_name}%`);
      filters.push(`display_name ILIKE $${params.length}`);
    }
    if (req.query.salesperson_id) {
      params.push(req.query.salesperson_id);
      filters.push(`salesperson_id = $${params.length}`);
    }
    if (req.query.risk_level) {
      params.push(req.query.risk_level);
      filters.push(`risk_level = $${params.length}`);
    }
    if (req.query.partner_id) {
      const pid = parseInt(req.query.partner_id, 10);
      if (!isNaN(pid)) {
        params.push(pid);
        filters.push(`partner_id = $${params.length}`);
      }
    }

    const cte = buildChurnCte(pfx, s);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `SELECT * FROM (${cte}) churn ${where} ORDER BY total_score DESC`;

    const { rows } = await db.query(sql, params);
    res.json({ rows, settings: s });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// POST /generate – tworzy zadania + wysyła emaile dla critical/high
// Tylko sales_manager lub admin.
// ─────────────────────────────────────────────────────────────────
router.post('/generate', requireCrmManager, async (req, res, next) => {
  try {
    const s   = await loadSettings(req.tenantId);
    const pfx = req.dwhPrefix;

    const cte = buildChurnCte(pfx, s);
    const { rows: allAtRisk } = await db.query(
      `SELECT * FROM (${cte}) churn
       WHERE risk_level IN ('critical', 'high', 'medium')
       ORDER BY total_score DESC`,
      [req.tenantId]
    );

    let created = 0;
    let skipped = 0;
    const errors = [];

    for (const p of allAtRisk) {
      try {
        // Pomiń jeśli istnieje już otwarte zadanie churn dla tego partnera
        const { rows: existing } = await db.query(
          `SELECT id FROM crm_partner_activities
           WHERE partner_id = $1 AND tenant_id = $2
             AND type = 'task' AND title LIKE 'Churn:%'
             AND status IN ('new', 'open')
           LIMIT 1`,
          [p.partner_id, req.tenantId]
        );
        if (existing.length) { skipped++; continue; }

        // Termin zadania zależny od poziomu ryzyka
        const daysAhead = p.risk_level === 'critical' ? 0
                        : p.risk_level === 'high'     ? 3
                        : 7; // medium
        const activityAt = new Date();
        activityAt.setDate(activityAt.getDate() + daysAhead);

        const riskLabel = ({ critical: 'Krytyczne', high: 'Wysokie', medium: 'Średnie' })[p.risk_level] || p.risk_level;
        const title = `Churn: ${p.display_name} [${riskLabel}]`;
        const body  = `Wskaźnik churn: ${p.total_score} pkt | Dni bez zamówienia: ${p.days_since_order ?? '—'} | Spadek M-2→M-1: ${p.sales_drop_pct ?? 0}%`;

        await db.query(
          `INSERT INTO crm_partner_activities
           (partner_id, type, title, body, activity_at, assigned_to, status, created_by, tenant_id)
           VALUES ($1, 'task', $2, $3, $4, $5, 'new', $6, $7)`,
          [p.partner_id, title, body, activityAt, p.manager_id, req.user.id, req.tenantId]
        );
        created++;

        // Email dla critical i high
        if (p.salesperson_email && ['critical', 'high'].includes(p.risk_level)) {
          await sendCrmActivityAssigned({
            to:            p.salesperson_email,
            assigneeName:  p.salesperson_name,
            assignerName:  req.user.display_name,
            activityType:  'task',
            activityTitle: title,
            activityAt,
            sourceName:    p.display_name,
            sourceType:    'partner',
            sourceId:      p.partner_id,
          });
        }
      } catch (e) {
        errors.push({ partner_id: p.partner_id, error: e.message });
      }
    }

    res.json({
      created,
      skipped,
      total: allAtRisk.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) { next(err); }
});

module.exports = router;
