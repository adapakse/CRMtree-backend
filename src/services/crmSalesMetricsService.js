'use strict';
// ─────────────────────────────────────────────────────────────────
// services/crmSalesMetricsService.js — sales figures shared by the web
// reports and the mobile start screen, so both show the same numbers:
// lead values converted to PLN and the planned budget of a period.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');
const exchangeRateService = require('./exchangeRateService');

// Used only until the first NBP table is stored (fresh install, NBP unreachable).
const FALLBACK_RATES = { EUR: 4.25, USD: 3.90, GBP: 4.90, CHF: 4.20 };

/** Exchange rates to PLN for the sales reports: the newest NBP rates, the same for every tenant. */
async function loadExchangeRates() {
  const latestNbpRates = await exchangeRateService.getLatestRates();
  const rates = { ...FALLBACK_RATES };
  for (const currency of Object.keys(FALLBACK_RATES)) {
    if (latestNbpRates[currency]) rates[currency] = latestNbpRates[currency];
  }
  return rates;
}

/** SQL expression for a lead's value in PLN; `alias` is the crm_leads alias. */
function leadValuePlnSql(rates, alias = 'l') {
  return `(CASE COALESCE(${alias}.annual_turnover_currency,'PLN')
    WHEN 'EUR' THEN COALESCE(${alias}.value_pln,0) * ${Number(rates.EUR)}
    WHEN 'USD' THEN COALESCE(${alias}.value_pln,0) * ${Number(rates.USD)}
    WHEN 'GBP' THEN COALESCE(${alias}.value_pln,0) * ${Number(rates.GBP)}
    WHEN 'CHF' THEN COALESCE(${alias}.value_pln,0) * ${Number(rates.CHF)}
    ELSE COALESCE(${alias}.value_pln,0) END)`;
}

/**
 * Planned budget for a date range: every monthly or quarterly budget row
 * whose period overlaps the range counts in full (the rule the sales report
 * has always used). `userId` null means all salespeople of the tenant.
 */
async function plannedBudgetTotal({ tenantId, userId, year, dateFrom, dateTo }) {
  const params = [year, tenantId];
  let where = 'WHERE b.year = $1 AND b.tenant_id = $2';
  if (userId) { params.push(userId); where += ` AND b.user_id = $${params.length}`; }

  const { rows } = await db.query(
    `SELECT b.period_type, b.period_number, b.amount::float AS amount FROM crm_sales_budgets b ${where}`,
    params,
  );

  let total = 0;
  for (const row of rows) {
    const firstMonth = row.period_type === 'month' ? row.period_number - 1 : (row.period_number - 1) * 3;
    const monthCount = row.period_type === 'month' ? 1 : 3;
    const periodStart = new Date(year, firstMonth, 1);
    const periodEnd = new Date(year, firstMonth + monthCount, 0);
    if (periodStart <= dateTo && periodEnd >= dateFrom) total += Number(row.amount);
  }
  return total;
}

module.exports = { loadExchangeRates, leadValuePlnSql, plannedBudgetTotal };
