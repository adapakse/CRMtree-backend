'use strict';
// src/routes/crm-sales-data.js
//
// Dane sprzedażowe czytane wyłącznie z dwh.sales (read-only, DWH → CRM).
// Import CSV usunięty — dane zasilane tylko przez DWH.
//
// GET  /api/crm/sales-data                 – surowe wiersze
// GET  /api/crm/sales-data/summary         – agregacja miesięczna
// GET  /api/crm/sales-data/by-partner      – agregacja per partner
// GET  /api/crm/sales-data/by-salesperson  – agregacja per handlowiec
// GET  /api/crm/sales-data/by-product      – agregacja per typ produktu / kategoria
// GET  /api/crm/sales-data/partners        – lista partnerów z danych DWH
// GET  /api/crm/sales-data/report          – kompleksowy raport KPI + trend

const express = require('express');
const db      = require('../config/database');
const { requireAuth }                = require('../middleware/auth');
const { crmAuth, requireCrmManager, loadCrmScope, requireFeature } = require('../middleware/crm-rbac');

const router = express.Router();

// Wszystkie endpointy tego routera wymagają aktywnej flagi dwh_integration
router.use(requireAuth, crmAuth, requireFeature('dwh_integration'));

// ── Wspólne aliasy kolumn DWH → nazwy używane przez frontend ─────────────────
// Zapytania SELECT-ują pod nazwami kompatybilnymi z poprzednią tabelą
// crm_sales_transactions, żeby frontend nie wymagał zmian.
const DWH_FIN_SELECT = `
  SUM(s.gross_sales_value_pln)::numeric(14,2)  AS gross_turnover_pln,
  SUM(s.net_sales_value_pln)::numeric(14,2)    AS net_turnover_pln,
  SUM(s.gross_fee_value_pln)::numeric(14,2)    AS fees_pln,
  SUM(s.gross_margin_value_pln)::numeric(14,2) AS revenue_pln,
  SUM(s.number_of_products)::int               AS transactions_count,
  0                                             AS pax_count`;

// JOIN partnerów CRM przez klucz DWH (zawiera też dwh.partner dla filtrów)
const DWH_JOIN_PARTNERS = `
  LEFT JOIN crm_partners p ON p.dwh_partner_id = s.partner_id
  LEFT JOIN users u ON u.id = p.manager_id
  LEFT JOIN crm_partner_groups g ON g.id = p.group_id
  LEFT JOIN dwh.partner dm ON dm.partner_id = s.partner_id`;

// Zawsze wykluczaj konta testowe z DWH
const EXCLUDE_TEST = "COALESCE(dm.is_test_account, false) = false";

// Filtr okresu z daty (pole sale_date → format YYYY-MM)
function addPeriodFilters(where, params, pfrom, pto, alias = 's') {
  if (pfrom) { params.push(pfrom); where.push(`TO_CHAR(${alias}.sale_date, 'YYYY-MM') >= $${params.length}`); }
  if (pto)   { params.push(pto);   where.push(`TO_CHAR(${alias}.sale_date, 'YYYY-MM') <= $${params.length}`); }
}

// ─────────────────────────────────────────────────────────
// GET /partners  – lista partnerów obecnych w danych DWH
// ─────────────────────────────────────────────────────────
router.get('/partners', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT
         COALESCE(p.company, dm.company_name, dm.name, 'Partner ' || s.partner_id::text) AS partner_name,
         p.id                                 AS partner_id,
         s.partner_id                         AS dwh_partner_id,
         u.display_name                       AS salesperson_name
       FROM dwh.sales s
       LEFT JOIN crm_partners p ON p.dwh_partner_id = s.partner_id
       LEFT JOIN dwh.partner dm ON dm.partner_id = s.partner_id
       LEFT JOIN users u ON u.id = p.manager_id
       WHERE COALESCE(dm.is_test_account, false) = false
       ORDER BY partner_name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /summary  – agregacja miesięczna
// query: period_from, period_to, partner_id (dwh), service_category
// ─────────────────────────────────────────────────────────
router.get('/summary', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { service_category, partner_id } = req.query;
    const where = [], params = [];
    addPeriodFilters(where, params, req.query.period_from, req.query.period_to);
    if (service_category) { params.push(service_category); where.push(`s.service_category = $${params.length}`); }
    if (partner_id)       { params.push(parseInt(partner_id)); where.push(`s.partner_id = $${params.length}`); }

    where.push(EXCLUDE_TEST);
    const { rows } = await db.query(
      `SELECT TO_CHAR(s.sale_date, 'YYYY-MM') AS period,
              ${DWH_FIN_SELECT}
       FROM dwh.sales s
       LEFT JOIN dwh.partner dm ON dm.partner_id = s.partner_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY TO_CHAR(s.sale_date, 'YYYY-MM')
       ORDER BY period DESC
       LIMIT 24`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /by-partner  – agregacja per partner + handlowiec z CRM
// query: period_from, period_to, service_category, salesperson_name
// ─────────────────────────────────────────────────────────
router.get('/by-partner', requireAuth, crmAuth, loadCrmScope, async (req, res, next) => {
  try {
    const { service_category, salesperson_name } = req.query;
    const where = [], params = [];

    addPeriodFilters(where, params, req.query.period_from, req.query.period_to);
    if (service_category)  { params.push(service_category);  where.push(`s.service_category = $${params.length}`); }
    if (salesperson_name)  { params.push(salesperson_name);  where.push(`u.display_name = $${params.length}`); }

    // Scope: salesperson widzi tylko swoich partnerów
    if (!req.isCrmManager && !req.crmGlobalRead) {
      params.push(req.user.id);
      where.push(`p.manager_id = $${params.length}`);
    }
    where.push(EXCLUDE_TEST);

    const { rows } = await db.query(
      `SELECT
         COALESCE(p.company, dm.company_name, dm.name, 'Partner ' || s.partner_id::text) AS partner_name,
         p.id           AS partner_id,
         s.partner_id   AS dwh_partner_id,
         u.display_name AS salesperson_name,
         u.id           AS salesperson_id,
         ${DWH_FIN_SELECT}
       FROM dwh.sales s
       ${DWH_JOIN_PARTNERS}
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY p.company, dm.company_name, dm.name, p.id, s.partner_id, u.display_name, u.id
       ORDER BY SUM(s.gross_sales_value_pln) DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /by-salesperson  – agregacja per handlowiec
// query: period_from, period_to, service_category
// ─────────────────────────────────────────────────────────
router.get('/by-salesperson', requireAuth, crmAuth, loadCrmScope, async (req, res, next) => {
  try {
    const { service_category } = req.query;
    const where = [], params = [];

    addPeriodFilters(where, params, req.query.period_from, req.query.period_to);
    if (service_category) { params.push(service_category); where.push(`s.service_category = $${params.length}`); }

    // Scope: salesperson widzi tylko siebie
    if (!req.isCrmManager && !req.crmGlobalRead) {
      params.push(req.user.id);
      where.push(`u.id = $${params.length}`);
    }
    where.push(EXCLUDE_TEST);

    const { rows } = await db.query(
      `SELECT
         COALESCE(u.display_name, '— brak opiekuna —') AS salesperson_name,
         u.id AS salesperson_id,
         COUNT(DISTINCT s.partner_id)::int              AS partners_count,
         ${DWH_FIN_SELECT}
       FROM dwh.sales s
       ${DWH_JOIN_PARTNERS}
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY u.display_name, u.id
       ORDER BY SUM(s.gross_sales_value_pln) DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /by-product  – agregacja per kategoria usługi
// query: period_from, period_to, partner_id (dwh)
// ─────────────────────────────────────────────────────────
router.get('/by-product', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { partner_id } = req.query;
    const where = [], params = [];
    addPeriodFilters(where, params, req.query.period_from, req.query.period_to);
    if (partner_id) { params.push(parseInt(partner_id)); where.push(`s.partner_id = $${params.length}`); }
    where.push(EXCLUDE_TEST);

    const { rows } = await db.query(
      `SELECT s.service_category AS product_type, ${DWH_FIN_SELECT}
       FROM dwh.sales s
       LEFT JOIN dwh.partner dm ON dm.partner_id = s.partner_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY s.service_category
       ORDER BY SUM(s.gross_sales_value_pln) DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /  – surowe wiersze (do podglądu / debugowania)
// ─────────────────────────────────────────────────────────
router.get('/', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { service_category, partner_id } = req.query;
    const where = [], params = [];
    addPeriodFilters(where, params, req.query.period_from, req.query.period_to);
    if (service_category) { params.push(service_category);  where.push(`s.service_category = $${params.length}`); }
    if (partner_id)       { params.push(parseInt(partner_id)); where.push(`s.partner_id = $${params.length}`); }

    where.push(EXCLUDE_TEST);
    params.push(parseInt(req.query.limit) || 500);
    const { rows } = await db.query(
      `SELECT
         s.partner_id                         AS dwh_partner_id,
         TO_CHAR(s.sale_date, 'YYYY-MM')      AS period,
         s.sale_date,
         s.service_category                   AS product_type,
         s.gross_sales_value_pln              AS gross_turnover_pln,
         s.net_sales_value_pln                AS net_turnover_pln,
         s.gross_fee_value_pln                AS fees_pln,
         s.gross_margin_value_pln             AS revenue_pln,
         s.number_of_products                 AS transactions_count,
         0                                    AS pax_count,
         COALESCE(p.company, COALESCE(dm.company_name, dm.name)) AS partner_name,
         p.id           AS partner_id,
         u.display_name AS salesperson_name,
         u.id           AS salesperson_id
       FROM dwh.sales s
       ${DWH_JOIN_PARTNERS}
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.sale_date DESC, s.partner_id, s.service_category
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/crm/sales-data/report  ──────────────────────────────────────────
// Kompleksowy raport partnerów: KPI, trend, per partner, per produkt, per handlowiec
router.get('/report', requireAuth, crmAuth, loadCrmScope, async (req, res, next) => {
  try {
    const { service_category, rep_id, partner_id, partner_name, group_name } = req.query;
    const pfrom = req.query.period_from || '';
    const pto   = req.query.period_to   || '';

    function buildConditions() {
      const w = [], p = [];
      addPeriodFilters(w, p, pfrom, pto);
      if (service_category) { p.push(service_category);   w.push(`s.service_category = $${p.length}`); }
      if (!req.isCrmManager && !req.crmGlobalRead) {
        p.push(req.user.id); w.push(`p.manager_id = $${p.length}`);
      } else if (rep_id) {
        p.push(rep_id); w.push(`p.manager_id = $${p.length}`);
      }
      if (partner_id)   { p.push(parseInt(partner_id)); w.push(`s.partner_id = $${p.length}`); }
      if (partner_name) { p.push(partner_name); w.push(`COALESCE(p.company, COALESCE(dm.company_name, dm.name)) = $${p.length}`); }
      if (group_name)   { p.push(group_name); w.push(`COALESCE(CASE WHEN dm.partner_group = 'Partner_basic' THEN NULL ELSE dm.partner_group END, g.name) = $${p.length}`); }
      w.push(EXCLUDE_TEST);
      return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
    }

    const base = buildConditions();
    const JOIN = DWH_JOIN_PARTNERS;

    const FIN = `
      SUM(s.gross_sales_value_pln)::numeric(14,2)  AS gross_turnover_pln,
      SUM(s.net_sales_value_pln)::numeric(14,2)    AS net_turnover_pln,
      SUM(s.gross_fee_value_pln)::numeric(14,2)    AS fees_pln,
      SUM(s.gross_margin_value_pln)::numeric(14,2) AS revenue_pln,
      SUM(s.number_of_products)::int               AS transactions_count,
      0                                            AS pax_count`;

    const [kpiRes, trendRes, byPartnerRes, byProductRes, byRepRes] = await Promise.all([

      // KPI zbiorcze
      db.query(`
        SELECT ${FIN},
          ROUND(100.0 * SUM(s.gross_margin_value_pln) / NULLIF(SUM(s.gross_sales_value_pln),0), 2) AS margin_pct,
          ROUND(100.0 * SUM(s.gross_fee_value_pln)    / NULLIF(SUM(s.gross_sales_value_pln),0), 2) AS fee_rate_pct,
          COUNT(DISTINCT s.partner_id)::int AS partners_count
        FROM dwh.sales s ${JOIN}
        ${base.where}
      `, base.params),

      // Trend miesięczny
      db.query(`
        SELECT TO_CHAR(s.sale_date, 'YYYY-MM')        AS period,
               SUM(s.gross_sales_value_pln)::numeric(14,2)  AS gross_turnover_pln,
               SUM(s.net_sales_value_pln)::numeric(14,2)    AS net_turnover_pln,
               SUM(s.gross_margin_value_pln)::numeric(14,2) AS revenue_pln,
               SUM(s.number_of_products)::int               AS transactions_count
        FROM dwh.sales s ${JOIN}
        ${base.where}
        GROUP BY TO_CHAR(s.sale_date, 'YYYY-MM')
        ORDER BY period ASC
      `, base.params),

      // Per partner
      db.query(`
        SELECT COALESCE(p.company, dm.company_name, dm.name, 'Partner ' || s.partner_id::text) AS partner_name,
               p.id AS partner_id,
               s.partner_id AS dwh_partner_id,
               u.display_name AS salesperson_name, u.id AS salesperson_id,
               ${FIN}
        FROM dwh.sales s ${JOIN}
        ${base.where}
        GROUP BY p.company, dm.company_name, dm.name, p.id, s.partner_id, u.display_name, u.id
        ORDER BY SUM(s.gross_sales_value_pln) DESC
      `, base.params),

      // Per kategoria (product_type)
      db.query(`
        SELECT s.service_category AS product_type, ${FIN}
        FROM dwh.sales s ${JOIN}
        ${base.where}
        GROUP BY s.service_category
        ORDER BY SUM(s.gross_sales_value_pln) DESC
      `, base.params),

      // Per handlowiec (tylko manager widzi wszystkich)
      (req.isCrmManager || req.crmGlobalRead)
        ? db.query(`
            SELECT COALESCE(u.display_name,'— brak opiekuna —') AS salesperson_name,
                   u.id AS salesperson_id,
                   COUNT(DISTINCT s.partner_id)::int AS partners_count,
                   ${FIN}
            FROM dwh.sales s ${JOIN}
            ${base.where}
            GROUP BY u.display_name, u.id
            ORDER BY SUM(s.gross_sales_value_pln) DESC
          `, base.params)
        : Promise.resolve({ rows: [] }),
    ]);

    // Poprzedni równoważny okres (do porównania) — arytmetyka miesięczna
    let prevKpi = null;
    if (pfrom && pto) {
      const fromYear  = parseInt(pfrom.substring(0, 4));
      const fromMonth = parseInt(pfrom.substring(5, 7)); // 1-12
      const toYear    = parseInt(pto.substring(0, 4));
      const toMonth   = parseInt(pto.substring(5, 7));
      const diffMonths = (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;

      // prevTo = miesiąc przed pfrom (0-based: fromMonth-2)
      const prevToDate   = new Date(fromYear, fromMonth - 2, 1);
      // prevFrom = diffMonths miesięcy przed prevTo
      const prevFromDate = new Date(prevToDate.getFullYear(), prevToDate.getMonth() - (diffMonths - 1), 1);
      const prevPFrom = prevFromDate.toISOString().substring(0, 7);
      const prevPTo   = prevToDate.toISOString().substring(0, 7);

      const prevW = [], prevP = [];
      addPeriodFilters(prevW, prevP, prevPFrom, prevPTo);
      if (service_category) { prevP.push(service_category); prevW.push(`s.service_category = $${prevP.length}`); }
      if (!req.isCrmManager && !req.crmGlobalRead) { prevP.push(req.user.id);  prevW.push(`p.manager_id = $${prevP.length}`); }
      else if (rep_id)       { prevP.push(rep_id);        prevW.push(`p.manager_id = $${prevP.length}`); }
      if (partner_id)        { prevP.push(parseInt(partner_id)); prevW.push(`s.partner_id = $${prevP.length}`); }
      if (partner_name)      { prevP.push(partner_name);  prevW.push(`COALESCE(p.company, COALESCE(dm.company_name, dm.name)) = $${prevP.length}`); }
      if (group_name)        { prevP.push(group_name); prevW.push(`COALESCE(dm.partner_group, g.name) = $${prevP.length}`); }
      prevW.push(EXCLUDE_TEST);

      const prevWhere = prevW.length ? 'WHERE ' + prevW.join(' AND ') : '';
      const prevRes = await db.query(`
        SELECT ${FIN},
          ROUND(100.0 * SUM(s.gross_margin_value_pln) / NULLIF(SUM(s.gross_sales_value_pln),0), 2) AS margin_pct
        FROM dwh.sales s ${JOIN}
        ${prevWhere}
      `, prevP);
      prevKpi = prevRes.rows[0] || null;
    }

    res.json({
      kpi:        kpiRes.rows[0] || {},
      prev_kpi:   prevKpi,
      trend:      trendRes.rows,
      by_partner: byPartnerRes.rows,
      by_product: byProductRes.rows,
      by_rep:     byRepRes.rows,
      period_from: pfrom,
      period_to:   pto,
    });
  } catch (err) { next(err); }
});

module.exports = router;
