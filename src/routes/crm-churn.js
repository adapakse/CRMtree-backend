'use strict';
// src/routes/crm-churn.js
//
// GET  /api/crm/churn          – lista partnerów z ryzykiem churn (z filtrami)
// POST /api/crm/churn/compute  – przelicza churn+health i zapisuje do crm_partner_scores
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

// ─── Health Score defaults + settings loader ───────────────────────────────────
const HEALTH_DEFAULTS = {
  act_t1_max_days: 20, act_t1_pts: 10,
  act_t2_min_days: 5,  act_t2_max_days: 10, act_t2_pts: 20,
  act_t3_min_orders: 2, act_t4_min_orders: 5,
  act_t3_pts: 30, act_t4_pts: 50,
  rev_t1_pct: 20, rev_t1_pts: 20,
  rev_t2_pct: 30, rev_t2_pts: 30,
  rev_t3_pct: 41, rev_t3_pts: 40,
  rev_t4_pct: 51, rev_t4_pts: 50,
  good_min: 61,   warn_min: 21,
};

async function loadHealthSettings(tenantId) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM app_settings WHERE key LIKE 'health_%' AND tenant_id = $1`,
      [tenantId]
    );
    const hs = { ...HEALTH_DEFAULTS };
    for (const r of rows) {
      const k = r.key.replace('health_', '');
      if (k in hs) { const v = parseFloat(r.value); if (!isNaN(v)) hs[k] = v; }
    }
    return hs;
  } catch { return { ...HEALTH_DEFAULTS }; }
}

// ─── Połączone zapytanie: churn + health dla wszystkich aktywnych partnerów ─────
// Używa danych względem MAX(sale_date) — nie CURRENT_DATE — żeby poprawnie
// działać niezależnie od świeżości importu DWH.
function buildCombinedScoreQuery(pfx, s, hs) {
  return `
    WITH
    ref_date AS (
      SELECT MAX(sale_date)::date AS ref FROM dwh.${pfx}_sales
    ),
    m1 AS (
      SELECT partner_id, SUM(gross_sales_value_pln) AS sales
      FROM dwh.${pfx}_sales, ref_date
      WHERE TO_CHAR(sale_date,'YYYY-MM') = TO_CHAR(ref - INTERVAL '0 month','YYYY-MM')
      GROUP BY partner_id
    ),
    m2 AS (
      SELECT partner_id, SUM(gross_sales_value_pln) AS sales
      FROM dwh.${pfx}_sales, ref_date
      WHERE TO_CHAR(sale_date,'YYYY-MM') = TO_CHAR(ref - INTERVAL '1 month','YYYY-MM')
      GROUP BY partner_id
    ),
    last_ord AS (
      SELECT partner_id, MAX(sale_date)::date AS last_date
      FROM dwh.${pfx}_sales
      GROUP BY partner_id
    ),
    recent AS (
      SELECT partner_id,
             COUNT(*)::int        AS orders_cnt,
             MAX(sale_date)::date AS last_date
      FROM dwh.${pfx}_sales, ref_date
      WHERE sale_date >= ref - ${hs.act_t1_max_days}
      GROUP BY partner_id
    )
    SELECT
      p.id        AS partner_id,
      p.tenant_id,
      -- Churn: dni bez zamówienia (względem ref_date)
      CASE
        WHEN lo.last_date IS NULL THEN ${s.days_t3_pts}
        WHEN (r.ref - lo.last_date) BETWEEN ${s.days_t1_min} AND ${s.days_t1_max} THEN ${s.days_t1_pts}
        WHEN (r.ref - lo.last_date) BETWEEN ${s.days_t2_min} AND ${s.days_t2_max} THEN ${s.days_t2_pts}
        WHEN (r.ref - lo.last_date) > ${s.days_t2_max}                             THEN ${s.days_t3_pts}
        ELSE 0
      END AS days_score,
      -- Churn: spadek sprzedaży M-2→M-1
      CASE
        WHEN m2.sales > 0
         AND ((m2.sales - COALESCE(m1.sales,0)) / m2.sales * 100) >= ${s.sales_t2_pct} THEN ${s.sales_t2_pts}
        WHEN m2.sales > 0
         AND ((m2.sales - COALESCE(m1.sales,0)) / m2.sales * 100) >= ${s.sales_t1_pct} THEN ${s.sales_t1_pts}
        ELSE 0
      END AS sales_score,
      -- Health: aktywność (względem ref_date)
      CASE
        WHEN COALESCE(rc.orders_cnt, 0) > ${hs.act_t4_min_orders}                  THEN ${hs.act_t4_pts}
        WHEN COALESCE(rc.orders_cnt, 0) BETWEEN ${hs.act_t3_min_orders} AND ${hs.act_t4_min_orders} THEN ${hs.act_t3_pts}
        WHEN COALESCE(rc.orders_cnt, 0) = 1
             AND (r.ref - rc.last_date) BETWEEN ${hs.act_t2_min_days} AND ${hs.act_t2_max_days} THEN ${hs.act_t2_pts}
        WHEN rc.last_date IS NOT NULL AND (r.ref - rc.last_date) <= ${hs.act_t1_max_days}       THEN ${hs.act_t1_pts}
        ELSE 0
      END AS activity_score,
      -- Health: wzrost przychodów M-2→M-1
      CASE
        WHEN m2.sales > 0
         AND (COALESCE(m1.sales,0) - m2.sales) / m2.sales * 100 >= ${hs.rev_t4_pct} THEN ${hs.rev_t4_pts}
        WHEN m2.sales > 0
         AND (COALESCE(m1.sales,0) - m2.sales) / m2.sales * 100 >= ${hs.rev_t3_pct} THEN ${hs.rev_t3_pts}
        WHEN m2.sales > 0
         AND (COALESCE(m1.sales,0) - m2.sales) / m2.sales * 100 >= ${hs.rev_t2_pct} THEN ${hs.rev_t2_pts}
        WHEN m2.sales > 0
         AND (COALESCE(m1.sales,0) - m2.sales) / m2.sales * 100 >= ${hs.rev_t1_pct} THEN ${hs.rev_t1_pts}
        ELSE 0
      END AS growth_score,
      -- Meta
      (r.ref - lo.last_date)::int                                          AS days_since_order,
      COALESCE(m1.sales, 0)::numeric(14,2)                                 AS sales_m1,
      COALESCE(m2.sales, 0)::numeric(14,2)                                 AS sales_m2,
      CASE
        WHEN m2.sales > 0
        THEN ROUND(((m2.sales - COALESCE(m1.sales,0)) / m2.sales * 100)::numeric, 1)
        ELSE 0
      END AS sales_drop_pct
    FROM crm_partners p
    CROSS JOIN ref_date r
    LEFT JOIN last_ord lo ON lo.partner_id = p.dwh_partner_id
    LEFT JOIN recent   rc ON rc.partner_id = p.dwh_partner_id
    LEFT JOIN m1 ON m1.partner_id = p.dwh_partner_id
    LEFT JOIN m2 ON m2.partner_id = p.dwh_partner_id
    WHERE p.tenant_id = $1
      AND p.status = 'active'
      AND p.dwh_partner_id IS NOT NULL
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
      params.push(req.query.partner_id);
      filters.push(`partner_id::text = $${params.length}`);
    }

    const cte = buildChurnCte(pfx, s);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `SELECT * FROM (${cte}) churn ${where} ORDER BY total_score DESC`;

    const { rows } = await db.query(sql, params);
    res.json({ rows, settings: s });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// POST /compute – przelicza churn + health i zapisuje do crm_partner_scores
// Tylko sales_manager lub admin.
// ─────────────────────────────────────────────────────────────────
router.post('/compute', requireCrmManager, async (req, res, next) => {
  try {
    const s   = await loadSettings(req.tenantId);
    const hs  = await loadHealthSettings(req.tenantId);
    const pfx = req.dwhPrefix;
    if (!pfx) return res.json({ computed: 0, message: 'Brak DWH prefix dla tego tenanta' });

    const sql  = buildCombinedScoreQuery(pfx, s, hs);
    const { rows } = await db.query(sql, [req.tenantId]);
    if (!rows.length) return res.json({ computed: 0 });

    // Upsert wyników w jednym zapytaniu VALUES(...)
    const vals = rows.map(r => {
      const churnScore  = (r.days_score || 0) + (r.sales_score || 0);
      const healthScore = (r.activity_score || 0) + (r.growth_score || 0);
      const churnLevel  = churnScore >= s.risk_critical ? 'critical'
                        : churnScore >= s.risk_high     ? 'high'
                        : churnScore >= s.risk_medium   ? 'medium'
                        : churnScore >= s.risk_low      ? 'low'
                        : 'none';
      const healthLevel = healthScore >= hs.good_min ? 'good'
                        : healthScore >= hs.warn_min  ? 'warning'
                        : 'risk';
      return { ...r, churnScore, churnLevel, healthScore, healthLevel };
    });

    // Buduj VALUES dla bulk upsert
    const placeholders = [];
    const params = [];
    vals.forEach((v, i) => {
      const o = i * 12;
      params.push(
        v.tenant_id, v.partner_id,
        v.churnScore, v.churnLevel, v.days_since_order,
        v.sales_m1, v.sales_m2, v.sales_drop_pct,
        v.activity_score, v.growth_score, v.healthScore, v.healthLevel,
      );
      placeholders.push(
        `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9},$${o+10},$${o+11},$${o+12},NOW())`
      );
    });

    await db.query(`
      INSERT INTO crm_partner_scores
        (tenant_id, partner_id, churn_score, churn_level, days_since_order,
         sales_m1, sales_m2, sales_drop_pct,
         activity_score, growth_score, health_score, health_level, computed_at)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (tenant_id, partner_id) DO UPDATE SET
        churn_score      = EXCLUDED.churn_score,
        churn_level      = EXCLUDED.churn_level,
        days_since_order = EXCLUDED.days_since_order,
        sales_m1         = EXCLUDED.sales_m1,
        sales_m2         = EXCLUDED.sales_m2,
        sales_drop_pct   = EXCLUDED.sales_drop_pct,
        activity_score   = EXCLUDED.activity_score,
        growth_score     = EXCLUDED.growth_score,
        health_score     = EXCLUDED.health_score,
        health_level     = EXCLUDED.health_level,
        computed_at      = NOW()
    `, params);

    res.json({ computed: rows.length });
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
