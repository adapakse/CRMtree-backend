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

  const [leads, budget] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE l.stage NOT IN ('new','closed_won','closed_lost') AND NOT l.hold_active)::int AS active_leads,
        COALESCE(ROUND(SUM(${valuePln}) FILTER (WHERE l.stage NOT IN ('new','closed_won','closed_lost') AND NOT l.hold_active)), 0)::float AS pipeline_value_pln,
        COALESCE(ROUND(SUM(${valuePln}) FILTER (WHERE l.stage = 'closed_won' AND l.updated_at >= $3 AND l.updated_at < $4)), 0)::float AS month_won_value_pln
        FROM crm_leads l
       WHERE l.tenant_id = $1 AND l.assigned_to = $2 AND l.stage <> 'archived'`,
      [tenantId, userId, monthStart, monthEnd]),
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
             WHERE l.tenant_id = $1 AND l.assigned_to = ANY($2::uuid[]) AND l.stage <> 'archived'
          ) waiting
          WHERE new_email_count + unread_sms_count + unread_whatsapp_count + missed_call_count > 0
          ORDER BY updated_at DESC
          LIMIT ${ATTENTION_LIMIT}`, [req.tenantId, ownerIds]),
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

module.exports = router;
