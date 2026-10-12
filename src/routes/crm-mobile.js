'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-mobile.js — endpoints shaped for the mobile app (ADR 001,
// backend change 8). The web endpoints return wide rows built for desktop
// tables; on a phone that is several requests and a lot of unused data per
// screen. These return exactly what one screen shows, in the contract of
// src/openapi/mobile-v1.yaml.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { query } = require('express-validator');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, loadCrmScope } = require('../middleware/crm-rbac');
const salesMetrics = require('../services/crmSalesMetricsService');
const leadStageSvc = require('../services/leadStageService');

router.use(requireAuth, injectAuditContext, crmAuth, loadCrmScope);

const AGENDA_TYPES = ['meeting', 'call', 'task'];
const OVERDUE_LIMIT = 50;
const ATTENTION_LIMIT = 50;

// One query for leads and one for partners, identical in shape. `source_id`
// is always text: a lead id is an integer and a partner id a uuid, and the
// app treats it as an opaque key.
function agendaQuery({ activityTable, parentTable, parentKey, ownerColumn, sourceType, timeCondition, order }) {
  return `
    SELECT a.id, a.type, a.title, a.body, a.activity_at, a.duration_min,
           a.meeting_location, COALESCE(a.status, 'new') AS status,
           '${sourceType}' AS source_type,
           p.id::text      AS source_id,
           p.company       AS source_name
      FROM ${activityTable} a
      JOIN ${parentTable} p ON p.id = a.${parentKey}
     WHERE p.tenant_id = $1
       AND a.type = ANY($2::text[])
       AND a.activity_at IS NOT NULL
       AND COALESCE(a.status, 'new') <> 'closed'
       AND COALESCE(a.assigned_to, p.${ownerColumn}) = ANY($3::uuid[])
       AND ${timeCondition}
     ORDER BY a.activity_at ${order}`;
}

const LEAD_AGENDA = { activityTable: 'crm_lead_activities', parentTable: 'crm_leads', parentKey: 'lead_id', ownerColumn: 'assigned_to', sourceType: 'lead' };
const PARTNER_AGENDA = { activityTable: 'crm_partner_activities', parentTable: 'crm_partners', parentKey: 'partner_id', ownerColumn: 'manager_id', sourceType: 'partner' };

// "Moje wyniki" on the start screen, for the phone's current calendar month.
// Same definitions as the web sales report: the pipeline is every active lead
// (past "new", not closed, not on hold) and the budget is met by leads won in
// the month. Only the person's own leads count, never the team's.
async function loadMonthKpis({ tenantId, userId, monthStart, monthEnd }) {
  const rates = await salesMetrics.loadExchangeRates();
  const valuePln = salesMetrics.leadValuePlnSql(rates);
  // The middle of the range is inside the month in every time zone.
  const midMonth = new Date((new Date(monthStart).getTime() + new Date(monthEnd).getTime()) / 2);
  const year = midMonth.getUTCFullYear();
  const month = midMonth.getUTCMonth();

  // Etapy są konfigurowalne per tenant — ekran mobilny czyta te same kody co raport.
  const stageConfig = await leadStageSvc.getStageConfig(tenantId);
  const kpiParams = [tenantId, userId, monthStart, monthEnd];
  const s = leadStageSvc.stageRefs(kpiParams, stageConfig);

  const [leads, budget] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE l.stage = ANY(${s.pipeline()}) AND NOT l.hold_active)::int AS active_leads,
        COALESCE(ROUND(SUM(${valuePln}) FILTER (WHERE l.stage = ANY(${s.pipeline()}) AND NOT l.hold_active)), 0)::float AS pipeline_value_pln,
        COALESCE(ROUND(SUM(${valuePln}) FILTER (WHERE l.stage = ${s.won()} AND l.updated_at >= $3 AND l.updated_at < $4)), 0)::float AS month_won_value_pln
        FROM crm_leads l
       WHERE l.tenant_id = $1 AND l.assigned_to = $2
         AND l.stage IS DISTINCT FROM ${s.archived()}`,
      [...kpiParams, ...s.values]),
    salesMetrics.plannedBudgetTotal({
      tenantId, userId, year,
      dateFrom: new Date(year, month, 1),
      dateTo: new Date(year, month + 1, 0),
    }),
  ]);
  return { ...leads.rows[0], month_budget_pln: Math.round(budget) };
}

const byActivityTime = (a, b) => new Date(a.activity_at).getTime() - new Date(b.activity_at).getTime();

// ── GET /api/crm/mobile/today ─────────────────────────────────────
// Everything the "Dziś" screen shows, for the signed-in person only (plus
// anyone they currently substitute for) — a manager's team view belongs to
// the calendar, not to "my day". The app sends the bounds of its local day
// and month, so the server never has to guess the phone's time zone.
router.get('/today',
  [
    query('day_start').isISO8601(),
    query('day_end').isISO8601(),
    query('month_start').isISO8601(),
    query('month_end').isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const ownerIds = [req.user.id, ...(req.crmSubstituteForIds || [])];
      const base = [req.tenantId, AGENDA_TYPES, ownerIds];
      const today = { timeCondition: 'a.activity_at >= $4 AND a.activity_at < $5', order: 'ASC' };
      const overdue = { timeCondition: 'a.activity_at < $4', order: `DESC LIMIT ${OVERDUE_LIMIT}` };
      const dayBounds = [req.query.day_start, req.query.day_end];

      const { month_start: monthStart, month_end: monthEnd } = req.query;

      // Kod etapu archiwum jest konfigurowalny (nazwę tenant może zmienić).
      const attentionStageConfig = await leadStageSvc.getStageConfig(req.tenantId);

      const [leadToday, partnerToday, leadOverdue, partnerOverdue, attention, kpis] = await Promise.all([
        db.query(agendaQuery({ ...LEAD_AGENDA, ...today }), [...base, ...dayBounds]),
        db.query(agendaQuery({ ...PARTNER_AGENDA, ...today }), [...base, ...dayBounds]),
        db.query(agendaQuery({ ...LEAD_AGENDA, ...overdue }), [...base, req.query.day_start]),
        db.query(agendaQuery({ ...PARTNER_AGENDA, ...overdue }), [...base, req.query.day_start]),
        db.query(`
          SELECT * FROM (
            SELECT l.id::text AS lead_id, l.company, l.updated_at, l.logo_url, l.website,
              (SELECT COUNT(*) FROM crm_lead_activities
                WHERE lead_id = l.id AND tenant_id = l.tenant_id AND type = 'email' AND is_read = false)::int AS new_email_count,
              (SELECT COUNT(*) FROM sms_messages
                WHERE lead_id = l.id AND tenant_id = l.tenant_id AND direction = 'inbound' AND is_read = false)::int AS unread_sms_count,
              (SELECT COUNT(*) FROM whatsapp_messages
                WHERE lead_id = l.id AND tenant_id = l.tenant_id AND direction = 'incoming' AND is_read = false)::int AS unread_whatsapp_count,
              (SELECT COUNT(*) FROM pbx_call_log c
                WHERE c.lead_id = l.id AND c.tenant_id = l.tenant_id AND c.status IN ('missed','not_answered')
                  AND NOT EXISTS (
                    SELECT 1 FROM pbx_call_log c2
                     WHERE c2.lead_id = c.lead_id AND c2.tenant_id = c.tenant_id
                       AND c2.status = 'answered' AND c2.started_at > c.started_at
                  ))::int AS missed_call_count
              FROM crm_leads l
             WHERE l.tenant_id = $1 AND l.assigned_to = ANY($2::uuid[])
               AND l.stage IS DISTINCT FROM $3::text
          ) waiting
          WHERE new_email_count + unread_sms_count + unread_whatsapp_count + missed_call_count > 0
          ORDER BY updated_at DESC
          LIMIT ${ATTENTION_LIMIT}`, [req.tenantId, ownerIds, attentionStageConfig.archivedKey]),
        loadMonthKpis({ tenantId: req.tenantId, userId: req.user.id, monthStart, monthEnd }),
      ]);

      res.json({
        agenda: [...leadToday.rows, ...partnerToday.rows].sort(byActivityTime),
        // Oldest first reads as a to-do list; the query took the newest
        // OVERDUE_LIMIT from each source so a long backlog can't flood the phone.
        overdue: [...leadOverdue.rows, ...partnerOverdue.rows].sort(byActivityTime),
        attention: attention.rows.map(({ updated_at: _updatedAt, ...lead }) => lead),
        kpis,
      });
    } catch (err) { next(err); }
  },
);

const DASHBOARD_PERIOD_DAYS = [7, 30, 90];
const DAY_MS = 86400000;

// Whose leads the dashboard counts: everyone the person may see (their own
// for a salesperson, the team for a manager, null = the whole company for an
// admin), or the one salesperson it was narrowed to. A manager may name any
// salesperson, as in the web lists (crmScope); for anyone else undefined
// when that salesperson is outside their scope.
function dashboardOwnerIds(req) {
  const scope = req.crmScopeUserIds;
  const requested = req.query.assigned_to;
  if (!requested) return scope;
  const isManager = req.user.crm_role === 'sales_manager';
  if (scope && !scope.includes(requested) && !isManager) return undefined;
  return [requested];
}

// ── GET /api/crm/mobile/dashboard ─────────────────────────────────
// The sales dashboard: figures, the funnel and the sales chart, all counted
// here so the phone never downloads the lead list to add it up. Definitions
// follow "Moje wyniki" above: values in PLN at today's rates, a lead on hold
// is not in the pipeline, and a lead is won on the day it was last changed
// in the "won" stage. The app sends the bounds of its local week, month and
// chart period.
router.get('/dashboard',
  [
    query('week_start').isISO8601(),
    query('week_end').isISO8601(),
    query('month_start').isISO8601(),
    query('month_end').isISO8601(),
    query('period_end').isISO8601(),
    query('period_days').isIn(DASHBOARD_PERIOD_DAYS.map(String)),
    query('assigned_to').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const ownerIds = dashboardOwnerIds(req);
      if (ownerIds === undefined) return res.status(403).json({ error: 'Brak dostępu do danych tego handlowca.' });

      const periodDays = Number(req.query.period_days);
      const rates = await salesMetrics.loadExchangeRates();
      const valuePln = salesMetrics.leadValuePlnSql(rates);

      // Etapy są konfigurowalne per tenant, więc lejek, „aktywne" i „wygrane"
      // czytamy z jego konfiguracji. Każde zapytanie ma własną instancję
      // stageRefs i własną bazę parametrów (patrz leadStageService.stageRefs).
      const stageConfig = await leadStageSvc.getStageConfig(req.tenantId);
      const funnelStages = stageConfig.stages.filter(s => s.active && s.kind === 'open').map(s => s.key);

      const base = [req.tenantId, ownerIds];
      const kpiParams = [...base, req.query.week_start, req.query.week_end, req.query.month_start, req.query.month_end];
      const sKpi = leadStageSvc.stageRefs(kpiParams, stageConfig);
      const thisWeek = 'l.created_at >= $3 AND l.created_at < $4';
      const previousWeek = "l.created_at >= $3::timestamptz - INTERVAL '7 days' AND l.created_at < $3";
      const active = `l.stage = ANY(${sKpi.pipeline()}) AND NOT l.hold_active`;
      const wonInMonth = `l.stage = ${sKpi.won()} AND l.updated_at >= $5 AND l.updated_at < $6`;
      const mineKpi = `l.tenant_id = $1 AND ($2::uuid[] IS NULL OR l.assigned_to = ANY($2::uuid[])) AND l.stage IS DISTINCT FROM ${sKpi.archived()}`;

      const funnelParams = [...base, funnelStages];
      const sFunnel = leadStageSvc.stageRefs(funnelParams, stageConfig);
      const mineFunnel = `l.tenant_id = $1 AND ($2::uuid[] IS NULL OR l.assigned_to = ANY($2::uuid[])) AND l.stage IS DISTINCT FROM ${sFunnel.archived()}`;

      const wonParams = [...base, req.query.period_end,
        new Date(new Date(req.query.period_end).getTime() - 2 * periodDays * DAY_MS).toISOString()];
      const sWon = leadStageSvc.stageRefs(wonParams, stageConfig);
      const mineWon = `l.tenant_id = $1 AND ($2::uuid[] IS NULL OR l.assigned_to = ANY($2::uuid[])) AND l.stage IS DISTINCT FROM ${sWon.archived()}`;

      const [kpis, funnel, won] = await Promise.all([
        db.query(`
          SELECT
            COUNT(*) FILTER (WHERE ${thisWeek})::int                                        AS new_leads,
            COUNT(*) FILTER (WHERE ${previousWeek})::int                                    AS new_leads_previous,
            COALESCE(ROUND(SUM(${valuePln}) FILTER (WHERE ${thisWeek})), 0)::float          AS new_leads_value_pln,
            COALESCE(ROUND(SUM(${valuePln}) FILTER (WHERE ${previousWeek})), 0)::float      AS new_leads_value_previous_pln,
            COUNT(*) FILTER (WHERE ${active})::int                                          AS active_leads,
            COALESCE(ROUND(SUM(${valuePln}) FILTER (WHERE ${active})), 0)::float            AS pipeline_value_pln,
            COUNT(*) FILTER (WHERE ${wonInMonth})::int                                      AS month_won_count,
            COALESCE(ROUND(SUM(${valuePln}) FILTER (WHERE ${wonInMonth})), 0)::float        AS month_won_value_pln
            FROM crm_leads l
           WHERE ${mineKpi}`,
          [...kpiParams, ...sKpi.values]),
        db.query(`
          SELECT l.stage, COUNT(*)::int AS count, COALESCE(ROUND(SUM(${valuePln})), 0)::float AS value_pln
            FROM crm_leads l
           WHERE ${mineFunnel} AND l.stage = ANY($3::text[]) AND NOT l.hold_active AND l.converted_at IS NULL
           GROUP BY l.stage`,
          [...funnelParams, ...sFunnel.values]),
        // Whole days back from the end of the period; twice the period, so
        // the one before it can be compared.
        db.query(`
          SELECT FLOOR(EXTRACT(EPOCH FROM ($3::timestamptz - l.updated_at)) / 86400)::int AS days_back,
                 COALESCE(ROUND(SUM(${valuePln})), 0)::float AS value_pln
            FROM crm_leads l
           WHERE ${mineWon} AND l.stage = ${sWon.won()}
             AND l.updated_at < $3 AND l.updated_at >= $4
           GROUP BY 1`,
          [...wonParams, ...sWon.values]),
      ]);

      const funnelByStage = new Map(funnel.rows.map((row) => [row.stage, row]));
      const wonByDaysBack = new Map(won.rows.map((row) => [row.days_back, row.value_pln]));
      let total = 0;
      const points = [];
      for (let daysBack = periodDays - 1; daysBack >= 0; daysBack--) {
        total += wonByDaysBack.get(daysBack) || 0;
        points.push(total);
      }
      let previousTotal = 0;
      for (let daysBack = periodDays; daysBack < 2 * periodDays; daysBack++) {
        previousTotal += wonByDaysBack.get(daysBack) || 0;
      }

      res.json({
        kpis: kpis.rows[0],
        funnel: funnelStages.map((stage) => ({
          stage,
          count: funnelByStage.get(stage)?.count || 0,
          value_pln: funnelByStage.get(stage)?.value_pln || 0,
        })),
        chart: { period_days: periodDays, total_pln: total, previous_total_pln: previousTotal, points },
      });
    } catch (err) { next(err); }
  },
);

module.exports = router;
