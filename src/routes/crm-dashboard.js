'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-dashboard.js
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { query } = require('express-validator');
const db = require('../config/database');
const { requireAuth }                  = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, loadCrmScope, crmScope } = require('../middleware/crm-rbac');

router.use(requireAuth, injectAuditContext, crmAuth, loadCrmScope, crmScope);

// GET /api/crm/dashboard — pipeline leads
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    const scopeLeads = req.scopeFilter('l', 'assigned_to', params);
    const userId = req.user.id;

    const raParams = [];
    const raLeads    = req.scopeFilter('l', 'assigned_to', raParams);
    const raPartners = req.scopeFilter('p', 'manager_id',  raParams);
    raParams.push(req.user.id);
    const raUserId = `$${raParams.length}`;

    const [pipeline, recentLeads, recentActivities] = await Promise.all([
      db.query(`
        SELECT stage,
          COUNT(*)::int                                      AS count,
          COALESCE(SUM(value_pln),0)                        AS total_value,
          COALESCE(SUM(value_pln * probability / 100.0), 0) AS weighted_value
        FROM crm_leads l
        WHERE converted_at IS NULL ${scopeLeads}
        GROUP BY stage
        ORDER BY CASE stage
          WHEN 'new' THEN 1 WHEN 'qualification' THEN 2 WHEN 'presentation' THEN 3
          WHEN 'offer' THEN 4 WHEN 'negotiation' THEN 5
          WHEN 'closed_won' THEN 6 WHEN 'closed_lost' THEN 7 END
      `, params),

      db.query(`
        SELECT l.id, l.company, l.stage, l.value_pln, l.hot, l.updated_at,
               u.display_name AS assigned_to_name
        FROM crm_leads l
        LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.converted_at IS NULL ${scopeLeads}
        ORDER BY l.updated_at DESC LIMIT 10
      `, params),

      db.query(`
        SELECT 'la_' || a.id::text AS uid, COALESCE(a.type,'note') AS type,
               a.title, a.body, a.status, 'lead' AS source_type,
               l.id::text AS source_id, l.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_lead_activities a
        JOIN crm_leads l ON l.id = a.lead_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, l.assigned_to)
        WHERE a.type != 'email' ${raLeads}
        UNION ALL
        SELECT 'la_' || a.id::text AS uid, 'email' AS type,
               a.title, NULL::text AS body, a.status, 'lead' AS source_type,
               l.id::text AS source_id, l.company AS source_name,
               a.activity_at, a.updated_at, NULL::text AS assigned_to_name
        FROM crm_lead_activities a
        JOIN crm_leads l ON l.id = a.lead_id
        WHERE a.type = 'email' AND a.is_read = false ${raLeads}
        UNION ALL
        SELECT 'pa_' || a.id::text AS uid, COALESCE(a.type,'note') AS type,
               a.title, a.body, a.status, 'partner' AS source_type,
               p.id::text AS source_id, p.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, p.manager_id)
        WHERE a.type != 'email' ${raPartners}
        UNION ALL
        SELECT 'pa_' || a.id::text AS uid, 'email' AS type,
               a.title, NULL::text AS body, a.status, 'partner' AS source_type,
               p.id::text AS source_id, p.company AS source_name,
               a.activity_at, a.updated_at, NULL::text AS assigned_to_name
        FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        WHERE a.type = 'email' AND a.is_read = false ${raPartners}
        UNION ALL
        SELECT 'onb_' || t.id::text AS uid, t.type AS type,
               t.title, t.body, 'closed' AS status, 'onboarding' AS source_type,
               p.id::text AS source_id, p.company AS source_name,
               t.done_at AS activity_at, COALESCE(t.updated_at, t.created_at) AS updated_at,
               au.display_name AS assigned_to_name
        FROM crm_onboarding_tasks t
        JOIN crm_partners p ON p.id = t.partner_id
        LEFT JOIN users au ON au.id = t.assigned_to
        WHERE t.done = true ${raPartners}
        UNION ALL
        SELECT 'doc_' || wt.id::text AS uid, 'task' AS type,
               COALESCE(wt.message, d.name) AS title, NULL::text AS body,
               'closed' AS status, 'document' AS source_type,
               d.id::text AS source_id, d.name AS source_name,
               wt.completed_at AS activity_at, wt.updated_at,
               NULL::text AS assigned_to_name
        FROM workflow_tasks wt
        JOIN documents d ON d.id = wt.document_id
        WHERE wt.task_status = 'completed' AND wt.assigned_to = ${raUserId}
        ORDER BY updated_at DESC NULLS LAST LIMIT 15
      `, raParams),
    ]);

    res.json({
      pipeline:           pipeline.rows,
      recent_leads:       recentLeads.rows,
      recent_activities:  recentActivities.rows,
    });
  } catch (err) { next(err); }
});

// GET /api/crm/tasks — unified task feed (all sources, open only)
router.get('/tasks', async (req, res, next) => {
  try {
    const params = [];
    const scopeLeads    = req.scopeFilter('l', 'assigned_to', params);
    const scopePartners = req.scopeFilter('p', 'manager_id',  params);
    params.push(req.user.id);
    const $userId = `$${params.length}`;

    // Dla filtrowania zadań używamy COALESCE(a.assigned_to, owner) zamiast samego ownera
    const taskScopeLeads    = scopeLeads.replace('l.assigned_to',  'COALESCE(a.assigned_to, l.assigned_to)');
    const taskScopePartners = scopePartners.replace('p.manager_id', 'COALESCE(a.assigned_to, p.manager_id)');

    const { rows } = await db.query(`
      SELECT * FROM (
        SELECT 'la_' || a.id::text AS uid, a.id,
               COALESCE(a.type,'task') AS type, a.title, a.body, a.status,
               'lead' AS source_type, l.id::text AS source_id, l.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_lead_activities a
        JOIN crm_leads l ON l.id = a.lead_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, l.assigned_to)
        WHERE a.type != 'email' AND a.status != 'closed' ${taskScopeLeads}

        UNION ALL

        SELECT 'la_em_' || a.id::text AS uid, a.id,
               'email' AS type, a.title, a.body, 'open' AS status,
               'lead' AS source_type, l.id::text AS source_id, l.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_lead_activities a
        JOIN crm_leads l ON l.id = a.lead_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, l.assigned_to)
        WHERE a.type = 'email' AND a.is_read = false ${taskScopeLeads}

        UNION ALL

        SELECT 'pa_' || a.id::text AS uid, a.id,
               COALESCE(a.type,'task') AS type, a.title, a.body, a.status,
               'partner' AS source_type, p.id::text AS source_id, p.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, p.manager_id)
        WHERE a.type != 'email' AND a.status != 'closed' ${taskScopePartners}

        UNION ALL

        SELECT 'pa_em_' || a.id::text AS uid, a.id,
               'email' AS type, a.title, a.body, 'open' AS status,
               'partner' AS source_type, p.id::text AS source_id, p.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, p.manager_id)
        WHERE a.type = 'email' AND a.is_read = false ${taskScopePartners}

        UNION ALL

        SELECT 'onb_' || t.id::text AS uid, NULL::int AS id,
               t.type, t.title, t.body,
               CASE WHEN t.done THEN 'closed' ELSE 'open' END AS status,
               'onboarding' AS source_type, p.id::text AS source_id, p.company AS source_name,
               t.due_date::timestamptz AS activity_at, COALESCE(t.updated_at, t.created_at) AS updated_at,
               au.display_name AS assigned_to_name
        FROM crm_onboarding_tasks t
        JOIN crm_partners p ON p.id = t.partner_id
        LEFT JOIN users au ON au.id = t.assigned_to
        WHERE t.done = false AND t.assigned_to = ${$userId}

        UNION ALL

        SELECT 'doc_' || wt.id::text AS uid, NULL::int AS id,
               'task' AS type, COALESCE(wt.message, d.name) AS title, NULL::text AS body,
               'open' AS status,
               'document' AS source_type, d.id::text AS source_id, d.name AS source_name,
               wt.due_date::timestamptz AS activity_at, wt.updated_at,
               NULL::text AS assigned_to_name
        FROM workflow_tasks wt
        JOIN documents d ON d.id = wt.document_id
        WHERE wt.task_status = 'pending' AND wt.assigned_to = ${$userId}
      ) t
      ORDER BY
        CASE WHEN t.activity_at IS NULL THEN 1 ELSE 0 END,
        t.activity_at ASC
    `, params);

    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/crm/dashboard/partner-performance
router.get('/partner-performance',
  [query('period').optional().isIn(['30d','90d','12m','ytd'])],
  validate,
  async (req, res, next) => {
    try {
      const period = req.query.period || '12m';
      const dateFilter = {
        '30d': `NOW() - INTERVAL '30 days'`,
        '90d': `NOW() - INTERVAL '90 days'`,
        '12m': `NOW() - INTERVAL '12 months'`,
        'ytd': `DATE_TRUNC('year', NOW())`,
      }[period];

      const params = [];
      const scopePartners = req.scopeFilter('p', 'manager_id', params);

      const [kpis, scores, trend, productMix, opportunities] = await Promise.all([
        db.query(`
          SELECT
            COUNT(*) FILTER (WHERE p.status = 'active')::int        AS active_partners,
            COUNT(*) FILTER (WHERE p.onboarding_step = 3)::int      AS onboarding_complete,
            COUNT(*) FILTER (WHERE p.status = 'onboarding')::int    AS in_onboarding,
            COALESCE(SUM(p.arr) FILTER (WHERE p.status='active'), 0) AS total_arr,
            COALESCE(AVG(p.arr) FILTER (WHERE p.status='active' AND p.arr IS NOT NULL), 0) AS avg_arr,
            COUNT(DISTINCT p.group_id) FILTER (WHERE p.group_id IS NOT NULL)::int AS group_count
          FROM crm_partners p
          WHERE 1=1 ${scopePartners}
        `, params),

        db.query(`
          SELECT p.id, p.company, p.status, p.arr, p.license_count, p.active_users,
            p.onboarding_step, p.group_id, g.name AS group_name,
            u.display_name AS manager_name,
            CASE WHEN p.license_count > 0
                 THEN ROUND((p.active_users::numeric / p.license_count) * 100) ELSE 0
            END AS adoption_pct,
            (SELECT COALESCE(SUM(t.total_gross),0) FROM crm_transactions t
             WHERE t.partner_id = p.id
               AND t.transaction_date >= ${dateFilter}
               AND t.status = 'confirmed') AS period_revenue,
            (SELECT COUNT(o.id)::int FROM crm_opportunities o
             WHERE o.partner_id = p.id AND o.status = 'open') AS open_opp_count,
            (SELECT COALESCE(SUM(o.value_pln),0) FROM crm_opportunities o
             WHERE o.partner_id = p.id AND o.status = 'open') AS open_opp_value
          FROM crm_partners p
          LEFT JOIN crm_partner_groups g ON g.id = p.group_id
          LEFT JOIN users u ON u.id = p.manager_id
          WHERE 1=1 ${scopePartners}
          ORDER BY p.arr DESC NULLS LAST
        `, params),

        db.query(`
          SELECT
            TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM') AS month,
            COALESCE(SUM(t.total_gross),0)       AS gross,
            COALESCE(SUM(t.total_net),0)          AS net,
            COALESCE(SUM(t.total_commission),0)   AS commission,
            COALESCE(SUM(t.total_margin),0)       AS margin,
            COUNT(DISTINCT t.partner_id)::int     AS partner_count
          FROM crm_transactions t
          JOIN crm_partners p ON p.id = t.partner_id
          WHERE t.transaction_date >= NOW() - INTERVAL '12 months'
            AND t.status = 'confirmed'
            ${scopePartners.replace(/p\.manager_id/, 'p.manager_id')}
          GROUP BY 1 ORDER BY 1
        `, params),

        db.query(`
          SELECT
            pr.product_type,
            COUNT(*)::int           AS count,
            SUM(pr.gross_cost)      AS total_gross,
            SUM(pr.margin_amt)      AS total_margin,
            ROUND(AVG(pr.commission_pct)*100, 2) AS avg_commission_pct
          FROM crm_transaction_products pr
          JOIN crm_transactions t ON t.id = pr.transaction_id
          JOIN crm_partners p ON p.id = t.partner_id
          WHERE t.transaction_date >= ${dateFilter}
            AND t.status = 'confirmed'
            ${scopePartners}
          GROUP BY pr.product_type
          ORDER BY total_gross DESC
        `, params),

        db.query(`
          SELECT o.*, p.company AS partner_company, p.arr AS partner_arr
          FROM crm_opportunities o
          JOIN crm_partners p ON p.id = o.partner_id
          WHERE o.status = 'open' ${scopePartners}
          ORDER BY o.value_pln DESC NULLS LAST
        `, params),
      ]);

      res.json({
        kpis:           kpis.rows[0],
        partner_scores: scores.rows,
        revenue_trend:  trend.rows,
        product_mix:    productMix.rows,
        opportunities:  opportunities.rows,
      });
    } catch (err) { next(err); }
  }
);

// GET /api/crm/dashboard/activities — paginated activity feed
router.get('/activities',
  [
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const offset = parseInt(req.query.offset) || 0;
      const limit  = Math.min(parseInt(req.query.limit) || 20, 50);

      const raParams = [];
      const raLeads    = req.scopeFilter('l', 'assigned_to', raParams);
      const raPartners = req.scopeFilter('p', 'manager_id',  raParams);
      raParams.push(req.user.id);
      const raUserId = `$${raParams.length}`;
      raParams.push(limit);
      const $limit  = `$${raParams.length}`;
      raParams.push(offset);
      const $offset = `$${raParams.length}`;

      const { rows } = await db.query(`
        SELECT uid, type, title, status, source_type, source_id, source_name,
               activity_at, updated_at, assigned_to_name
        FROM (
          SELECT 'la_' || a.id::text AS uid, COALESCE(a.type,'note') AS type,
                 a.title, a.status, 'lead' AS source_type,
                 l.id::text AS source_id, l.company AS source_name,
                 a.activity_at, a.updated_at, au.display_name AS assigned_to_name
          FROM crm_lead_activities a
          JOIN crm_leads l ON l.id = a.lead_id
          LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, l.assigned_to)
          WHERE a.type != 'email' ${raLeads}
          UNION ALL
          SELECT 'la_' || a.id::text AS uid, 'email' AS type,
                 a.title, a.status, 'lead' AS source_type,
                 l.id::text AS source_id, l.company AS source_name,
                 a.activity_at, a.updated_at, NULL::text AS assigned_to_name
          FROM crm_lead_activities a
          JOIN crm_leads l ON l.id = a.lead_id
          WHERE a.type = 'email' AND a.is_read = false ${raLeads}
          UNION ALL
          SELECT 'pa_' || a.id::text AS uid, COALESCE(a.type,'note') AS type,
                 a.title, a.status, 'partner' AS source_type,
                 p.id::text AS source_id, p.company AS source_name,
                 a.activity_at, a.updated_at, au.display_name AS assigned_to_name
          FROM crm_partner_activities a
          JOIN crm_partners p ON p.id = a.partner_id
          LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, p.manager_id)
          WHERE a.type != 'email' ${raPartners}
          UNION ALL
          SELECT 'pa_' || a.id::text AS uid, 'email' AS type,
                 a.title, a.status, 'partner' AS source_type,
                 p.id::text AS source_id, p.company AS source_name,
                 a.activity_at, a.updated_at, NULL::text AS assigned_to_name
          FROM crm_partner_activities a
          JOIN crm_partners p ON p.id = a.partner_id
          WHERE a.type = 'email' AND a.is_read = false ${raPartners}
          UNION ALL
          SELECT 'onb_' || t.id::text AS uid, t.type AS type,
                 t.title, 'closed' AS status, 'onboarding' AS source_type,
                 p.id::text AS source_id, p.company AS source_name,
                 t.done_at AS activity_at, COALESCE(t.updated_at, t.created_at) AS updated_at,
                 au.display_name AS assigned_to_name
          FROM crm_onboarding_tasks t
          JOIN crm_partners p ON p.id = t.partner_id
          LEFT JOIN users au ON au.id = t.assigned_to
          WHERE t.done = true ${raPartners}
          UNION ALL
          SELECT 'doc_' || wt.id::text AS uid, 'task' AS type,
                 COALESCE(wt.message, d.name) AS title, 'closed' AS status, 'document' AS source_type,
                 d.id::text AS source_id, d.name AS source_name,
                 wt.completed_at AS activity_at, wt.updated_at,
                 NULL::text AS assigned_to_name
          FROM workflow_tasks wt
          JOIN documents d ON d.id = wt.document_id
          WHERE wt.task_status = 'completed' AND wt.assigned_to = ${raUserId}
        ) sub
        ORDER BY updated_at DESC NULLS LAST
        LIMIT ${$limit} OFFSET ${$offset}
      `, raParams);

      res.json(rows);
    } catch (err) { next(err); }
  }
);

// GET /api/crm/dashboard/renewals
router.get('/renewals', async (req, res, next) => {
  try {
    const params = [];
    const scope = req.scopeFilter('p', 'manager_id', params);
    const { rows } = await db.query(`
      SELECT p.id, p.company, p.contract_expires, p.contract_value, p.arr, p.status,
        p.active_users, p.license_count, u.display_name AS manager_name,
        CASE WHEN p.license_count > 0
             THEN ROUND((p.active_users::numeric / p.license_count)*100) ELSE 0
        END AS adoption_pct,
        (p.contract_expires - CURRENT_DATE) AS days_until_expiry
      FROM crm_partners p
      LEFT JOIN users u ON u.id = p.manager_id
      WHERE p.contract_expires IS NOT NULL
        AND p.status IN ('active','onboarding')
        AND p.contract_expires <= CURRENT_DATE + INTERVAL '180 days'
        ${scope}
      ORDER BY p.contract_expires ASC
    `, params);
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
