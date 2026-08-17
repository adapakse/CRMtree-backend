'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-prospects-dashboard.js
// Dashboard Prospekty — statystyki dla sales_manager
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { query } = require('express-validator');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, loadCrmScope, requireCrmManager } = require('../middleware/crm-rbac');

router.use(requireAuth, injectAuditContext, crmAuth, loadCrmScope, requireCrmManager);

// ── Helpers ────────────────────────────────────────────────────────

/** Zwraca zakres dat i granulację na podstawie wartości period */
function periodRange(period) {
  const now = new Date();
  let from, to, trunc;

  switch (period) {
    case 'this_week': {
      const dow = now.getDay(); // 0=Sun
      const diff = (dow + 6) % 7; // days since Monday
      from = new Date(now); from.setHours(0,0,0,0); from.setDate(now.getDate() - diff);
      to   = new Date(now); to.setHours(23,59,59,999);
      trunc = 'day';
      break;
    }
    case 'this_month': {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to   = new Date(now); to.setHours(23,59,59,999);
      trunc = 'week';
      break;
    }
    case 'ytd': {
      from = new Date(now.getFullYear(), 0, 1);
      to   = new Date(now); to.setHours(23,59,59,999);
      trunc = 'month';
      break;
    }
    case 'prev_month': {
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      trunc = 'month';
      break;
    }
    case 'prev_quarter': {
      const q = Math.floor(now.getMonth() / 3);
      from = new Date(now.getFullYear(), (q - 1) * 3, 1);
      to   = new Date(now.getFullYear(),  q      * 3, 0, 23, 59, 59, 999);
      trunc = 'month';
      break;
    }
    case 'prev_year': {
      from = new Date(now.getFullYear() - 1, 0, 1);
      to   = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
      trunc = 'month';
      break;
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3);
      from = new Date(now.getFullYear(), q * 3, 1);
      to   = new Date(now); to.setHours(23,59,59,999);
      trunc = 'month';
      break;
    }
    case 'prev_week': {
      const dow  = now.getDay();
      const diff = (dow + 6) % 7;
      const thisMonday = new Date(now); thisMonday.setHours(0,0,0,0); thisMonday.setDate(now.getDate() - diff);
      from = new Date(thisMonday); from.setDate(thisMonday.getDate() - 7);
      to   = new Date(thisMonday); to.setDate(thisMonday.getDate() - 1); to.setHours(23,59,59,999);
      trunc = 'day';
      break;
    }
    default: // this_week fallback
      return periodRange('this_week');
  }
  return { from: from.toISOString(), to: to.toISOString(), trunc };
}

/** Wyrażenie CASE mapujące score na przedział co 10, z pierwszym progiem = min_score */
function scoreBucketExpr(col, minScore) {
  const ms = parseInt(minScore, 10) || 45;
  return `
    CASE
      WHEN ${col} IS NULL              THEN 'brak'
      WHEN ${col} < ${ms}             THEN '< ${ms}'
      WHEN ${col} BETWEEN ${ms}  AND ${ms + 9}  THEN '${ms}–${ms + 9}'
      WHEN ${col} BETWEEN ${ms + 10} AND ${ms + 19} THEN '${ms + 10}–${ms + 19}'
      WHEN ${col} BETWEEN ${ms + 20} AND ${ms + 29} THEN '${ms + 20}–${ms + 29}'
      WHEN ${col} BETWEEN ${ms + 30} AND ${ms + 39} THEN '${ms + 30}–${ms + 39}'
      WHEN ${col} BETWEEN ${ms + 40} AND ${ms + 49} THEN '${ms + 40}–${ms + 49}'
      WHEN ${col} BETWEEN ${ms + 50} AND ${ms + 59} THEN '${ms + 50}–${ms + 59}'
      ELSE '≥ ${ms + 60}'
    END
  `;
}

async function getMinScore(tenantId) {
  const { rows } = await db.query(
    `SELECT value FROM app_settings WHERE key = 'prospect_lead_min_score' AND tenant_id = $1`,
    [tenantId]
  );
  return parseInt(rows[0]?.value ?? '45', 10);
}

/** Grupy (group_profiles.id) do których należy user — CRMtree ma model many-to-many
 * (user_group_roles), w przeciwieństwie do worktrips-doc gdzie user ma jeden group_id. */
async function getUserGroupIds(userId) {
  const { rows } = await db.query(
    `SELECT group_id FROM user_group_roles WHERE user_id = $1`,
    [userId]
  );
  return rows.map(r => r.group_id);
}

// ── #1 Leady per handlowiec / przedział score / okres ──────────────

router.get('/leads-by-salesperson',
  [
    query('period').optional().isString(),
    query('from_date').optional().isISO8601(),
    query('to_date').optional().isISO8601(),
    query('stage').optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const period = req.query.period || 'this_week';
      let from, to;
      if (period === 'custom' && req.query.from_date && req.query.to_date) {
        from = new Date(req.query.from_date).toISOString();
        to   = new Date(req.query.to_date + 'T23:59:59.999Z').toISOString();
      } else {
        ({ from, to } = periodRange(period === 'custom' ? 'this_month' : period));
      }

      const minScore = await getMinScore(req.user.tenant_id);
      const bucket = scoreBucketExpr('p.travel_potential_score', minScore);

      const params = [from, to, req.user.tenant_id];
      let scopeClause = '';
      if (!req.user.is_admin && req.crmScopeUserIds?.length) {
        params.push(req.crmScopeUserIds);
        scopeClause = ` AND l.assigned_to = ANY($${params.length}::uuid[])`;
      }
      let stageClause = '';
      if (req.query.stage) {
        params.push(req.query.stage);
        stageClause = ` AND l.stage = $${params.length}`;
      }

      const sql = `
        SELECT
          u.id            AS user_id,
          u.display_name,
          ${bucket}       AS score_range,
          COUNT(*)        AS count
        FROM crm_leads l
        JOIN users u               ON l.assigned_to = u.id
        JOIN prospect_companies p  ON p.crm_lead_id = l.id AND p.tenant_id = l.tenant_id
        WHERE l.created_at BETWEEN $1 AND $2
          AND l.tenant_id = $3
          ${scopeClause}
          ${stageClause}
        GROUP BY u.id, u.display_name, score_range
        ORDER BY u.display_name, score_range
      `;

      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  }
);

// ── #2 Aktualna ilość prospektów wg punktów i statusu ──────────────

router.get('/prospects-by-score',
  [
    query('status').optional().isString(),
    query('db').optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const minScore = await getMinScore(req.user.tenant_id);
      const bucket = scoreBucketExpr('travel_potential_score', minScore);

      const params = [req.user.tenant_id];
      const where = ['tenant_id = $1'];

      if (req.query.status) {
        switch (req.query.status) {
          case 'lead':
            where.push(`crm_lead_id IS NOT NULL`); break;
          case 'hold':
            where.push(`enrichment_status = 'hold'`); break;
          case 'archive':
            where.push(`enrichment_status = 'archived'`); break;
          case 'prospect':
          default:
            where.push(`crm_lead_id IS NULL AND enrichment_status NOT IN ('hold','archived')`);
        }
      }

      // Izolacja grupy — user może należeć do kilku grup naraz (user_group_roles)
      const userGroupIds = req.user.is_admin ? [] : await getUserGroupIds(req.user.id);
      if (!req.user.is_admin && userGroupIds.length) {
        params.push(userGroupIds);
        where.push(`group_id = ANY($${params.length}::uuid[])`);
      }

      const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const sql = `
        SELECT
          CASE
            WHEN enrichment_status = 'hold'     THEN 'hold'
            WHEN enrichment_status = 'archived' THEN 'archive'
            WHEN crm_lead_id IS NOT NULL        THEN 'lead'
            ELSE 'prospect'
          END                                          AS status,
          ${bucket}                                    AS score_range,
          COALESCE(source_database, '(brak bazy)')     AS source_database,
          COUNT(*)                                     AS count
        FROM prospect_companies
        ${whereSQL}
        GROUP BY status, score_range, source_database
        ORDER BY status, score_range, source_database
      `;

      const { rows } = await db.query(sql, params);

      // Pobierz też listę baz dla filtra
      const dbParams = [req.user.tenant_id];
      let dbWhere = 'WHERE tenant_id = $1';
      if (!req.user.is_admin && userGroupIds.length) {
        dbParams.push(userGroupIds);
        dbWhere += ` AND group_id = ANY($${dbParams.length}::uuid[])`;
      }
      const { rows: databases } = await db.query(
        `SELECT DISTINCT source_database FROM prospect_companies ${dbWhere} ORDER BY source_database`,
        dbParams
      );

      res.json({ data: rows, databases: databases.map(r => r.source_database).filter(Boolean) });
    } catch (e) { next(e); }
  }
);

// ── #3 Leady wg tagu AI ────────────────────────────────────────────

router.get('/leads-by-ai-tag',
  [query('stage').optional().isString()],
  validate,
  async (req, res, next) => {
    try {
      const params = [req.user.tenant_id];
      const stageConds = [];
      let scopeClause = '';

      if (req.query.stage) {
        params.push(req.query.stage);
        stageConds.push(`l.stage = $${params.length}`);
      }
      if (!req.user.is_admin && req.crmScopeUserIds?.length) {
        params.push(req.crmScopeUserIds);
        scopeClause = ` AND l.assigned_to = ANY($${params.length}::uuid[])`;
      }
      const stageClause = stageConds.length ? ` AND ${stageConds.join(' AND ')}` : '';

      const sql = `
        SELECT tag, l.stage, COUNT(*) AS count
        FROM crm_leads l,
             UNNEST(l.tags) AS tag
        WHERE l.tenant_id = $1
          AND tag ~ '^AI\\d+%$'
          ${stageClause}
          ${scopeClause}
        GROUP BY tag, l.stage

        UNION ALL

        SELECT 'bez taga AI' AS tag, l.stage, COUNT(*) AS count
        FROM crm_leads l
        WHERE l.tenant_id = $1
          AND EXISTS (SELECT 1 FROM prospect_companies pc WHERE pc.crm_lead_id = l.id AND pc.tenant_id = l.tenant_id)
          AND NOT EXISTS (SELECT 1 FROM unnest(l.tags) AS t WHERE t ~ '^AI\\d+%$')
          ${stageClause}
          ${scopeClause}
        GROUP BY l.stage

        ORDER BY tag, stage
      `;

      const { rows } = await db.query(sql, params.length ? params : undefined);
      res.json(rows.map(r => ({ tag: r.tag, stage: r.stage, count: parseInt(r.count, 10) })));
    } catch (e) { next(e); }
  }
);

// ── #4 Wzbogacone prospekty per baza ──────────────────────────────

router.get('/enriched-by-database',
  async (req, res, next) => {
    try {
      const minScore = await getMinScore(req.user.tenant_id);
      const bucket   = scoreBucketExpr('travel_potential_score', minScore);

      const params = [req.user.tenant_id];
      let groupWhere = '';
      if (!req.user.is_admin) {
        const userGroupIds = await getUserGroupIds(req.user.id);
        if (userGroupIds.length) {
          params.push(userGroupIds);
          groupWhere = `AND group_id = ANY($${params.length}::uuid[])`;
        }
      }

      const whereClause = `WHERE tenant_id = $1 ${groupWhere}`;
      const sql = `
        SELECT
          COALESCE(source_database, '(brak bazy)') AS source_database,
          ${bucket}                                 AS score_range,
          COUNT(*)                                  AS count
        FROM prospect_companies
        ${whereClause}
        GROUP BY source_database, score_range
        ORDER BY source_database, score_range
      `;

      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  }
);

// ── #5 Połączenia per handlowiec / okres ──────────────────────────

router.get('/calls-by-salesperson',
  [
    query('period').optional().isString(),
    query('direction').optional().isIn(['inbound','outbound','']),
    query('status').optional().isString(),
    query('from_date').optional().isISO8601(),
    query('to_date').optional().isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const period = req.query.period || 'this_week';
      let from, to;
      if (period === 'custom' && req.query.from_date && req.query.to_date) {
        from = new Date(req.query.from_date).toISOString();
        to   = new Date(req.query.to_date + 'T23:59:59.999Z').toISOString();
      } else {
        ({ from, to } = periodRange(period === 'custom' ? 'this_month' : period));
      }

      const params = [from, to, req.user.tenant_id];
      const where  = [];

      if (req.query.direction) {
        params.push(req.query.direction);
        where.push(`c.direction = $${params.length}`);
      }

      if (req.query.status) {
        const statuses = req.query.status.split(',').filter(Boolean);
        if (statuses.length) {
          params.push(statuses);
          where.push(`c.status = ANY($${params.length}::text[])`);
        }
      }

      // Scope
      let scopeClause = '';
      if (!req.user.is_admin && req.crmScopeUserIds?.length) {
        params.push(req.crmScopeUserIds);
        scopeClause = ` AND c.user_id = ANY($${params.length}::uuid[])`;
      }

      const whereSQL = where.length ? `AND ${where.join(' AND ')}` : '';

      const sql = `
        SELECT
          u.id            AS user_id,
          u.display_name,
          c.direction,
          c.status,
          COUNT(*)        AS count
        FROM pbx_call_log c
        JOIN users u ON c.user_id = u.id
        WHERE c.started_at BETWEEN $1 AND $2
          AND c.tenant_id = $3
          ${whereSQL}
          ${scopeClause}
        GROUP BY u.id, u.display_name, c.direction, c.status
        ORDER BY u.display_name
      `;

      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  }
);

module.exports = router;
