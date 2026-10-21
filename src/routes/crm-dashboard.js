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
const leadStageSvc = require('../services/leadStageService');

router.use(requireAuth, injectAuditContext, crmAuth, loadCrmScope, crmScope);

// GET /api/crm/dashboard — pipeline leads
router.get('/', async (req, res, next) => {
  try {
    // Kolejność etapów i kod archiwum są konfigurowalne per tenant.
    const stageConfig = await leadStageSvc.getStageConfig(req.tenantId);

    const params = [req.tenantId];
    const scopeLeads = req.scopeFilter('l', 'assigned_to', params);
    const userId = req.user.id;

    const raParams = [req.tenantId];
    const raLeads    = req.scopeFilter('l', 'assigned_to', raParams);
    const raPartners = req.scopeFilter('p', 'manager_id',  raParams);
    raParams.push(req.user.id);
    const raUserId = `$${raParams.length}`;

    const sPipeline = leadStageSvc.stageRefs(params, stageConfig);
    const sRecent   = leadStageSvc.stageRefs(params, stageConfig);

    const [pipeline, recentLeads, recentActivities] = await Promise.all([
      db.query(`
        SELECT stage,
          COUNT(*)::int                                      AS count,
          COALESCE(SUM(value_pln),0)                        AS total_value,
          COALESCE(SUM(value_pln * probability / 100.0), 0) AS weighted_value
        FROM crm_leads l
        WHERE l.tenant_id = $1 AND converted_at IS NULL AND NOT hold_active
          AND stage IS DISTINCT FROM ${sPipeline.archived()} ${scopeLeads}
        GROUP BY stage
        ORDER BY array_position(${sPipeline.order()}, stage), stage
      `, [...params, ...sPipeline.values]),

      db.query(`
        SELECT l.id, l.company, l.stage, l.value_pln, l.hot, l.updated_at,
               l.hold_active, l.hold_reason, l.hold_until,
               u.display_name AS assigned_to_name
        FROM crm_leads l
        LEFT JOIN users u ON u.id = l.assigned_to AND u.tenant_id = $1
        WHERE l.tenant_id = $1 AND l.converted_at IS NULL
          AND l.stage IS DISTINCT FROM ${sRecent.archived()} ${scopeLeads}
        ORDER BY l.updated_at DESC LIMIT 10
      `, [...params, ...sRecent.values]),

      db.query(`
        SELECT 'la_' || a.id::text AS uid, COALESCE(a.type,'note') AS type,
               a.title, a.body, a.status, 'lead' AS source_type,
               l.id::text AS source_id, l.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_lead_activities a
        JOIN crm_leads l ON l.id = a.lead_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, l.assigned_to) AND au.tenant_id = $1
        WHERE a.tenant_id = $1 AND a.type != 'email' ${raLeads}
        UNION ALL
        SELECT 'la_' || a.id::text AS uid, 'email' AS type,
               a.title, NULL::text AS body, a.status, 'lead' AS source_type,
               l.id::text AS source_id, l.company AS source_name,
               a.activity_at, a.updated_at, NULL::text AS assigned_to_name
        FROM crm_lead_activities a
        JOIN crm_leads l ON l.id = a.lead_id
        WHERE a.tenant_id = $1 AND a.type = 'email' AND a.is_read = false ${raLeads}
        UNION ALL
        SELECT 'pa_' || a.id::text AS uid, COALESCE(a.type,'note') AS type,
               a.title, a.body, a.status, 'partner' AS source_type,
               p.id::text AS source_id, p.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, p.manager_id) AND au.tenant_id = $1
        WHERE a.tenant_id = $1 AND a.type != 'email' ${raPartners}
        UNION ALL
        SELECT 'pa_' || a.id::text AS uid, 'email' AS type,
               a.title, NULL::text AS body, a.status, 'partner' AS source_type,
               p.id::text AS source_id, p.company AS source_name,
               a.activity_at, a.updated_at, NULL::text AS assigned_to_name
        FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        WHERE a.tenant_id = $1 AND a.type = 'email' AND a.is_read = false ${raPartners}
        UNION ALL
        SELECT 'onb_' || t.id::text AS uid, t.type AS type,
               t.title, t.body, 'closed' AS status, 'onboarding' AS source_type,
               p.id::text AS source_id, p.company AS source_name,
               t.done_at AS activity_at, COALESCE(t.updated_at, t.created_at) AS updated_at,
               au.display_name AS assigned_to_name
        FROM crm_onboarding_tasks t
        JOIN crm_partners p ON p.id = t.partner_id
        LEFT JOIN users au ON au.id = t.assigned_to AND au.tenant_id = $1
        WHERE t.done = true AND p.tenant_id = $1 ${raPartners}
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
    const params = [req.tenantId];
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
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, l.assigned_to) AND au.tenant_id = $1
        WHERE a.tenant_id = $1 AND a.type IN ('meeting','task') AND a.status != 'closed' ${taskScopeLeads}

        UNION ALL

        SELECT 'la_em_' || a.id::text AS uid, a.id,
               'email' AS type, a.title, a.body, 'open' AS status,
               'lead' AS source_type, l.id::text AS source_id, l.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_lead_activities a
        JOIN crm_leads l ON l.id = a.lead_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, l.assigned_to) AND au.tenant_id = $1
        WHERE a.tenant_id = $1 AND a.type = 'email' AND a.is_read = false ${taskScopeLeads}

        UNION ALL

        SELECT 'pa_' || a.id::text AS uid, a.id,
               COALESCE(a.type,'task') AS type, a.title, a.body, a.status,
               'partner' AS source_type, p.id::text AS source_id, p.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, p.manager_id) AND au.tenant_id = $1
        WHERE a.tenant_id = $1 AND a.type IN ('meeting','task') AND a.status != 'closed' ${taskScopePartners}

        UNION ALL

        SELECT 'pa_em_' || a.id::text AS uid, a.id,
               'email' AS type, a.title, a.body, 'open' AS status,
               'partner' AS source_type, p.id::text AS source_id, p.company AS source_name,
               a.activity_at, a.updated_at, au.display_name AS assigned_to_name
        FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, p.manager_id) AND au.tenant_id = $1
        WHERE a.tenant_id = $1 AND a.type = 'email' AND a.is_read = false ${taskScopePartners}

        UNION ALL

        SELECT 'onb_' || t.id::text AS uid, NULL::int AS id,
               t.type, t.title, t.body,
               CASE WHEN t.done THEN 'closed' ELSE 'open' END AS status,
               'onboarding' AS source_type, p.id::text AS source_id, p.company AS source_name,
               t.due_date::timestamptz AS activity_at, COALESCE(t.updated_at, t.created_at) AS updated_at,
               au.display_name AS assigned_to_name
        FROM crm_onboarding_tasks t
        JOIN crm_partners p ON p.id = t.partner_id
        LEFT JOIN users au ON au.id = t.assigned_to AND au.tenant_id = $1
        WHERE t.done = false AND p.tenant_id = $1 AND t.assigned_to = ${$userId}

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

      const params = [req.tenantId];
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
          WHERE p.tenant_id = $1 ${scopePartners}
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
               AND t.tenant_id = p.tenant_id
               AND t.transaction_date >= ${dateFilter}
               AND t.status = 'confirmed') AS period_revenue,
            (SELECT COUNT(o.id)::int FROM crm_opportunities o
             WHERE o.partner_id = p.id AND o.tenant_id = p.tenant_id AND o.status = 'open') AS open_opp_count,
            (SELECT COALESCE(SUM(o.value_pln),0) FROM crm_opportunities o
             WHERE o.partner_id = p.id AND o.tenant_id = p.tenant_id AND o.status = 'open') AS open_opp_value
          FROM crm_partners p
          LEFT JOIN crm_partner_groups g ON g.id = p.group_id
          LEFT JOIN users u ON u.id = p.manager_id AND u.tenant_id = $1
          WHERE p.tenant_id = $1 ${scopePartners}
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
          WHERE t.tenant_id = $1
            AND t.transaction_date >= NOW() - INTERVAL '12 months'
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
          WHERE t.tenant_id = $1
            AND t.transaction_date >= ${dateFilter}
            AND t.status = 'confirmed'
            ${scopePartners}
          GROUP BY pr.product_type
          ORDER BY total_gross DESC
        `, params),

        db.query(`
          SELECT o.*, p.company AS partner_company, p.arr AS partner_arr
          FROM crm_opportunities o
          JOIN crm_partners p ON p.id = o.partner_id
          WHERE o.tenant_id = $1 AND o.status = 'open' ${scopePartners}
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
    query('assigned_to').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const offset = parseInt(req.query.offset) || 0;
      const limit  = Math.min(parseInt(req.query.limit) || 20, 50);

      const raParams = [req.tenantId];
      const raLeads    = req.scopeFilter('l', 'assigned_to', raParams);
      const raPartners = req.scopeFilter('p', 'manager_id',  raParams);
      raParams.push(req.user.id);
      const raUserId = `$${raParams.length}`;
      raParams.push(limit);
      const $limit  = `$${raParams.length}`;
      raParams.push(offset);
      const $offset = `$${raParams.length}`;
      // The mobile dashboard narrows the feed to one salesperson; the scope
      // above still decides what may be seen at all.
      raParams.push(req.query.assigned_to || null);
      const $owner = `$${raParams.length}`;

      const { rows } = await db.query(`
        SELECT uid, type, title, status, source_type, source_id, source_name,
               activity_at, updated_at, assigned_to_name
        FROM (
          SELECT 'la_' || a.id::text AS uid, COALESCE(a.type,'note') AS type,
                 a.title, a.status, 'lead' AS source_type,
                 l.id::text AS source_id, l.company AS source_name,
                 a.activity_at, a.updated_at, au.display_name AS assigned_to_name,
                 COALESCE(a.assigned_to, l.assigned_to) AS owner_id
          FROM crm_lead_activities a
          JOIN crm_leads l ON l.id = a.lead_id
          LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, l.assigned_to) AND au.tenant_id = $1
          WHERE a.tenant_id = $1 AND a.type != 'email' ${raLeads}
          UNION ALL
          SELECT 'la_' || a.id::text AS uid, 'email' AS type,
                 a.title, a.status, 'lead' AS source_type,
                 l.id::text AS source_id, l.company AS source_name,
                 a.activity_at, a.updated_at, NULL::text AS assigned_to_name,
                 COALESCE(a.assigned_to, l.assigned_to) AS owner_id
          FROM crm_lead_activities a
          JOIN crm_leads l ON l.id = a.lead_id
          WHERE a.tenant_id = $1 AND a.type = 'email' AND a.is_read = false ${raLeads}
          UNION ALL
          SELECT 'pa_' || a.id::text AS uid, COALESCE(a.type,'note') AS type,
                 a.title, a.status, 'partner' AS source_type,
                 p.id::text AS source_id, p.company AS source_name,
                 a.activity_at, a.updated_at, au.display_name AS assigned_to_name,
                 COALESCE(a.assigned_to, p.manager_id) AS owner_id
          FROM crm_partner_activities a
          JOIN crm_partners p ON p.id = a.partner_id
          LEFT JOIN users au ON au.id = COALESCE(a.assigned_to, p.manager_id) AND au.tenant_id = $1
          WHERE a.tenant_id = $1 AND a.type != 'email' ${raPartners}
          UNION ALL
          SELECT 'pa_' || a.id::text AS uid, 'email' AS type,
                 a.title, a.status, 'partner' AS source_type,
                 p.id::text AS source_id, p.company AS source_name,
                 a.activity_at, a.updated_at, NULL::text AS assigned_to_name,
                 COALESCE(a.assigned_to, p.manager_id) AS owner_id
          FROM crm_partner_activities a
          JOIN crm_partners p ON p.id = a.partner_id
          WHERE a.tenant_id = $1 AND a.type = 'email' AND a.is_read = false ${raPartners}
          UNION ALL
          SELECT 'onb_' || t.id::text AS uid, t.type AS type,
                 t.title, 'closed' AS status, 'onboarding' AS source_type,
                 p.id::text AS source_id, p.company AS source_name,
                 t.done_at AS activity_at, COALESCE(t.updated_at, t.created_at) AS updated_at,
                 au.display_name AS assigned_to_name, t.assigned_to AS owner_id
          FROM crm_onboarding_tasks t
          JOIN crm_partners p ON p.id = t.partner_id
          LEFT JOIN users au ON au.id = t.assigned_to AND au.tenant_id = $1
          WHERE t.done = true AND p.tenant_id = $1 ${raPartners}
          UNION ALL
          SELECT 'doc_' || wt.id::text AS uid, 'task' AS type,
                 COALESCE(wt.message, d.name) AS title, 'closed' AS status, 'document' AS source_type,
                 d.id::text AS source_id, d.name AS source_name,
                 wt.completed_at AS activity_at, wt.updated_at,
                 NULL::text AS assigned_to_name, wt.assigned_to AS owner_id
          FROM workflow_tasks wt
          JOIN documents d ON d.id = wt.document_id
          WHERE wt.task_status = 'completed' AND wt.assigned_to = ${raUserId}
        ) sub
        WHERE (${$owner}::uuid IS NULL OR owner_id = ${$owner}::uuid)
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
    const params = [req.tenantId];
    const scope = req.scopeFilter('p', 'manager_id', params);
    const { rows } = await db.query(`
      SELECT p.id, p.company, p.contract_expires, p.contract_value, p.arr, p.status,
        p.active_users, p.license_count, u.display_name AS manager_name,
        CASE WHEN p.license_count > 0
             THEN ROUND((p.active_users::numeric / p.license_count)*100) ELSE 0
        END AS adoption_pct,
        (p.contract_expires - CURRENT_DATE) AS days_until_expiry
      FROM crm_partners p
      LEFT JOIN users u ON u.id = p.manager_id AND u.tenant_id = $1
      WHERE p.tenant_id = $1
        AND p.contract_expires IS NOT NULL
        AND p.status IN ('active','onboarding')
        AND p.contract_expires <= CURRENT_DATE + INTERVAL '180 days'
        ${scope}
      ORDER BY p.contract_expires ASC
    `, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/crm/dashboard/my-calls — the signed-in user's own calls ──
// Feeds the sales dashboard's "My phone calls" panel and the "Calls today" medal
// (ported 1:1 from WorkTrips).
function myCallsPeriodRange(period) {
  const now = new Date();
  const dow  = now.getDay();
  const diff = (dow + 6) % 7; // days since Monday
  switch (period) {
    case 'prev_w': {
      const thisMon = new Date(now); thisMon.setHours(0,0,0,0); thisMon.setDate(now.getDate() - diff);
      const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7);
      const lastSun = new Date(thisMon); lastSun.setDate(thisMon.getDate() - 1); lastSun.setHours(23,59,59,999);
      return { from: lastMon.toISOString(), to: lastSun.toISOString() };
    }
    case 'cm': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to   = new Date(now); to.setHours(23,59,59,999);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case 'prev_1m': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case 'prev_q': {
      const q  = Math.floor(now.getMonth() / 3);
      const pq = q === 0 ? 3 : q - 1;
      const py = q === 0 ? now.getFullYear() - 1 : now.getFullYear();
      const from = new Date(py, pq * 3, 1);
      const to   = new Date(py, pq * 3 + 3, 0, 23, 59, 59, 999);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case 'prev_year': {
      const y = now.getFullYear() - 1;
      return { from: new Date(y, 0, 1).toISOString(), to: new Date(y, 11, 31, 23, 59, 59, 999).toISOString() };
    }
    default: { // 'cw' — current week
      const mon = new Date(now); mon.setHours(0,0,0,0); mon.setDate(now.getDate() - diff);
      const to  = new Date(now); to.setHours(23,59,59,999);
      return { from: mon.toISOString(), to: to.toISOString() };
    }
  }
}

// Custom-range bound: 'YYYY-MM' means the whole month, 'YYYY-MM-DD' a single day.
// The shared period-filter emits 'YYYY-MM' since it uses <input type="month">.
// `isEnd` selects end-of-period; boundaries stay in server-local time to match
// myCallsPeriodRange above. Returns null when the string is not one of those shapes.
function parseMyCallsBound(raw, isEnd) {
  const m = typeof raw === 'string' && raw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const mon  = Number(m[2]) - 1;
  if (m[3]) {
    const day = Number(m[3]);
    return isEnd ? new Date(year, mon, day, 23, 59, 59, 999)
                 : new Date(year, mon, day, 0, 0, 0, 0);
  }
  return isEnd ? new Date(year, mon + 1, 0, 23, 59, 59, 999)
               : new Date(year, mon, 1, 0, 0, 0, 0);
}

router.get('/my-calls',
  [
    query('period').optional().isString(),
    query('from_date').optional().isISO8601(),
    query('to_date').optional().isISO8601(),
    query('min_duration_sec').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const period = String(req.query.period || 'cw');
      const params = [req.user.id, req.tenantId];
      let dateSQL;

      if (period === 'today') {
        // Daily counter: the day is Europe/Warsaw regardless of the Node server's
        // and the DB session's time zone (explicit zone name).
        dateSQL = `started_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Warsaw') AT TIME ZONE 'Europe/Warsaw'
          AND started_at < (date_trunc('day', now() AT TIME ZONE 'Europe/Warsaw') + interval '1 day') AT TIME ZONE 'Europe/Warsaw'`;
      } else {
        let from, to;
        if (period === 'custom') {
          const start = parseMyCallsBound(req.query.from_date, false);
          const end   = parseMyCallsBound(req.query.to_date, true);
          if (!start || !end || start > end) {
            return res.status(400).json({
              error: 'Custom range needs valid dates (YYYY-MM or YYYY-MM-DD) with from <= to.',
            });
          }
          from = start.toISOString();
          to   = end.toISOString();
        } else {
          ({ from, to } = myCallsPeriodRange(period));
        }
        params.push(from, to);
        dateSQL = `started_at BETWEEN $3 AND $4`;
      }

      const where = [];

      if (req.query.min_duration_sec > 0) {
        params.push(req.query.min_duration_sec);
        where.push(`duration_sec >= $${params.length}`);
      }

      const whereSQL = where.length ? `AND ${where.join(' AND ')}` : '';

      const { rows } = await db.query(`
        SELECT direction, status, COUNT(*) AS count
        FROM pbx_call_log
        WHERE user_id = $1
          AND tenant_id = $2
          AND ${dateSQL}
          ${whereSQL}
        GROUP BY direction, status
        ORDER BY direction, status
      `, params);
      res.json(rows);
    } catch (err) { next(err); }
  }
);

module.exports = router;
