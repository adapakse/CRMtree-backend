'use strict';
// src/jobs/daily-scores.js
//
// Codzienne przeliczenie churn + health score dla wszystkich tenantów.
// Godzina uruchomienia konfigurowalna per-tenant przez app_settings: churn_daily_run_time (HH:MM).
// Uruchamiane przez src/server.js po starcie.

const db     = require('../config/database');
const logger = require('../utils/logger');
const { sendCrmActivityAssigned } = require('../utils/email');

// Śledzenie ostatniego uruchomienia per tenant (nie duplikuj w ramach jednego dnia)
const lastRun = new Map(); // tenantId → 'YYYY-MM-DD'

// ── Domyślne parametry ─────────────────────────────────────────────────────────
const CHURN_DEFAULTS = {
  days_t1_min: 10, days_t1_max: 20, days_t1_pts: 10,
  days_t2_min: 21, days_t2_max: 30, days_t2_pts: 20,
  days_t3_pts: 50,
  sales_t1_pct: 30, sales_t2_pct: 51,
  sales_t1_pts: 30, sales_t2_pts: 50,
  risk_critical: 91, risk_high: 71, risk_medium: 51, risk_low: 21,
};
const HEALTH_DEFAULTS = {
  act_t1_max_days: 20, act_t1_pts: 10,
  act_t2_min_days: 5,  act_t2_max_days: 10, act_t2_pts: 20,
  act_t3_min_orders: 2, act_t4_min_orders: 5,
  act_t3_pts: 30, act_t4_pts: 50,
  rev_t1_pct: 20, rev_t1_pts: 20,
  rev_t2_pct: 30, rev_t2_pts: 30,
  rev_t3_pct: 41, rev_t3_pts: 40,
  rev_t4_pct: 51, rev_t4_pts: 50,
  good_min: 61, warn_min: 21,
};

async function loadChurnSettings(tenantId) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM app_settings WHERE key LIKE 'churn_%' AND tenant_id = $1`,
      [tenantId]
    );
    const s = { ...CHURN_DEFAULTS };
    for (const r of rows) {
      const k = r.key.replace('churn_', '');
      if (k in s) { const v = parseFloat(r.value); if (!isNaN(v)) s[k] = v; }
    }
    return s;
  } catch { return { ...CHURN_DEFAULTS }; }
}

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

// ── Połączone zapytanie churn + health (ref_date = MAX(sale_date) z DWH) ──────
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
      CASE
        WHEN lo.last_date IS NULL THEN ${s.days_t3_pts}
        WHEN (r.ref - lo.last_date) BETWEEN ${s.days_t1_min} AND ${s.days_t1_max} THEN ${s.days_t1_pts}
        WHEN (r.ref - lo.last_date) BETWEEN ${s.days_t2_min} AND ${s.days_t2_max} THEN ${s.days_t2_pts}
        WHEN (r.ref - lo.last_date) > ${s.days_t2_max}                             THEN ${s.days_t3_pts}
        ELSE 0
      END AS days_score,
      CASE
        WHEN m2.sales > 0
         AND ((m2.sales - COALESCE(m1.sales,0)) / m2.sales * 100) >= ${s.sales_t2_pct} THEN ${s.sales_t2_pts}
        WHEN m2.sales > 0
         AND ((m2.sales - COALESCE(m1.sales,0)) / m2.sales * 100) >= ${s.sales_t1_pct} THEN ${s.sales_t1_pts}
        ELSE 0
      END AS sales_score,
      CASE
        WHEN COALESCE(rc.orders_cnt, 0) > ${hs.act_t4_min_orders}                  THEN ${hs.act_t4_pts}
        WHEN COALESCE(rc.orders_cnt, 0) BETWEEN ${hs.act_t3_min_orders} AND ${hs.act_t4_min_orders} THEN ${hs.act_t3_pts}
        WHEN COALESCE(rc.orders_cnt, 0) = 1
             AND (r.ref - rc.last_date) BETWEEN ${hs.act_t2_min_days} AND ${hs.act_t2_max_days} THEN ${hs.act_t2_pts}
        WHEN rc.last_date IS NOT NULL AND (r.ref - rc.last_date) <= ${hs.act_t1_max_days}       THEN ${hs.act_t1_pts}
        ELSE 0
      END AS activity_score,
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

// ── Krok 1: przelicz i zapisz wyniki ──────────────────────────────────────────
async function computeAndStore(tenantId, pfx, s, hs) {
  const sql    = buildCombinedScoreQuery(pfx, s, hs);
  const { rows } = await db.query(sql, [tenantId]);
  if (!rows.length) return 0;

  const placeholders = [];
  const params = [];
  rows.forEach((row, i) => {
    const churnScore  = (row.days_score || 0) + (row.sales_score || 0);
    const healthScore = (row.activity_score || 0) + (row.growth_score || 0);
    const churnLevel  = churnScore >= s.risk_critical ? 'critical'
                      : churnScore >= s.risk_high     ? 'high'
                      : churnScore >= s.risk_medium   ? 'medium'
                      : churnScore >= s.risk_low      ? 'low'
                      : 'none';
    const healthLevel = healthScore >= hs.good_min ? 'good'
                      : healthScore >= hs.warn_min  ? 'warning'
                      : 'risk';
    const o = i * 12;
    params.push(
      row.tenant_id, row.partner_id,
      churnScore, churnLevel, row.days_since_order,
      row.sales_m1, row.sales_m2, row.sales_drop_pct,
      row.activity_score, row.growth_score, healthScore, healthLevel,
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

  return rows.length;
}

// ── Krok 2: generuj zadania + maile dla partnerów z ryzykiem churn ────────────
async function generateAlerts(tenantId, pfx, s) {
  const { rows: atRisk } = await db.query(`
    SELECT
      sc.partner_id,
      sc.churn_score,
      sc.churn_level,
      sc.days_since_order,
      sc.sales_drop_pct,
      p.manager_id,
      u.display_name  AS salesperson_name,
      u.email         AS salesperson_email,
      COALESCE(dm.company_name, dm.name, p.company, 'Partner') AS display_name
    FROM crm_partner_scores sc
    JOIN crm_partners p   ON p.id = sc.partner_id AND p.tenant_id = $1
    LEFT JOIN dwh.${pfx}_partner dm ON dm.partner_id = p.dwh_partner_id
    LEFT JOIN users u     ON u.id = p.manager_id AND u.tenant_id = $1
    WHERE sc.tenant_id = $1
      AND sc.churn_level IN ('critical', 'high', 'medium')
    ORDER BY sc.churn_score DESC
  `, [tenantId]);

  let created = 0, skipped = 0;

  for (const p of atRisk) {
    try {
      const { rows: existing } = await db.query(
        `SELECT id FROM crm_partner_activities
         WHERE partner_id = $1 AND tenant_id = $2
           AND type = 'task' AND title LIKE 'Churn:%'
           AND status IN ('new', 'open')
         LIMIT 1`,
        [p.partner_id, tenantId]
      );
      if (existing.length) { skipped++; continue; }

      const daysAhead  = p.churn_level === 'critical' ? 0 : p.churn_level === 'high' ? 3 : 7;
      const activityAt = new Date();
      activityAt.setDate(activityAt.getDate() + daysAhead);

      const riskLabel = { critical: 'Krytyczne', high: 'Wysokie', medium: 'Średnie' }[p.churn_level] || p.churn_level;
      const title = `Churn: ${p.display_name} [${riskLabel}]`;
      const body  = `Wskaźnik churn: ${p.churn_score} pkt | Dni bez zamówienia: ${p.days_since_order ?? '—'} | Spadek M-2→M-1: ${p.sales_drop_pct ?? 0}%`;

      await db.query(
        `INSERT INTO crm_partner_activities
         (partner_id, type, title, body, activity_at, assigned_to, status, created_by, tenant_id)
         VALUES ($1,'task',$2,$3,$4,$5,'new',NULL,$6)`,
        [p.partner_id, title, body, activityAt, p.manager_id, tenantId]
      );
      created++;

      if (p.salesperson_email && ['critical', 'high'].includes(p.churn_level)) {
        await sendCrmActivityAssigned({
          to:            p.salesperson_email,
          assigneeName:  p.salesperson_name,
          assignerName:  'CRMtree (automatyczny)',
          activityType:  'task',
          activityTitle: title,
          activityAt,
          sourceName:    p.display_name,
          sourceType:    'partner',
          sourceId:      p.partner_id,
        });
      }
    } catch (err) {
      logger.error(`[daily-scores] Alert error for partner ${p.partner_id}`, { error: err.message });
    }
  }

  return { created, skipped, total: atRisk.length };
}

// ── Pełne uruchomienie dla jednego tenanta ────────────────────────────────────
async function runForTenant(tenantId, pfx) {
  logger.info(`[daily-scores] Start for tenant ${tenantId} (dwh: ${pfx})`);
  try {
    const s  = await loadChurnSettings(tenantId);
    const hs = await loadHealthSettings(tenantId);

    const computed = await computeAndStore(tenantId, pfx, s, hs);
    logger.info(`[daily-scores] Computed ${computed} partner scores`, { tenantId });

    const { created, skipped, total } = await generateAlerts(tenantId, pfx, s);
    logger.info(`[daily-scores] Alerts: ${created} created, ${skipped} skipped / ${total} at-risk`, { tenantId });
  } catch (err) {
    logger.error(`[daily-scores] Failed for tenant ${tenantId}`, { error: err.message });
  }
}

// ── Scheduler: sprawdza co minutę czy czas uruchomienia się zgadza ────────────
const TZ = 'Europe/Warsaw';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

function startDailyScoresJob() {
  setInterval(async () => {
    const now   = new Date();
    const hhmm  = timeFmt.format(now);   // "HH:MM" w strefie Europe/Warsaw
    const today = dateFmt.format(now);   // "YYYY-MM-DD" w strefie Europe/Warsaw

    try {
      const { rows: tenants } = await db.query(`
        SELECT t.id AS tenant_id,
               t.dwh_schema_prefix AS dwh_prefix,
               COALESCE(s.value, '06:00') AS run_time
        FROM tenants t
        LEFT JOIN app_settings s ON s.tenant_id = t.id AND s.key = 'churn_daily_run_time'
        WHERE t.dwh_schema_prefix IS NOT NULL
          AND t.dwh_schema_prefix <> ''
      `);

      for (const tenant of tenants) {
        if (tenant.run_time !== hhmm)                    continue;
        if (lastRun.get(tenant.tenant_id) === today)     continue;
        lastRun.set(tenant.tenant_id, today);
        runForTenant(tenant.tenant_id, tenant.dwh_prefix); // fire-and-forget
      }
    } catch (err) {
      logger.error('[daily-scores] Scheduler tick error', { error: err.message });
    }
  }, 60_000);

  logger.info('[daily-scores] Daily scores job started (polling every minute)');
}

module.exports = { startDailyScoresJob };
