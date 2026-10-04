'use strict';
// ─────────────────────────────────────────────────────────────────
// services/crmSalesMetricsService.js — sales figures shared by the web
// reports and the mobile start screen, so both show the same numbers:
// lead values converted to PLN and the planned budget of a period.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');

const DEFAULT_RATES = { EUR: 4.25, USD: 3.90, GBP: 4.90, CHF: 4.20 };
const RATE_KEYS = {
  exchange_rate_eur: 'EUR',
  exchange_rate_usd: 'USD',
  exchange_rate_gbp: 'GBP',
  exchange_rate_chf: 'CHF',
};

/** Exchange rates to PLN: the tenant's own setting wins over the global one. */
async function loadExchangeRates(tenantId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (key) key, value::numeric AS rate FROM app_settings
      WHERE key = ANY($2::text[]) AND (tenant_id = $1 OR tenant_id IS NULL)
      ORDER BY key, (tenant_id IS NOT NULL) DESC`,
    [tenantId, Object.keys(RATE_KEYS)],
  );
  const rates = { ...DEFAULT_RATES };
  for (const row of rows) rates[RATE_KEYS[row.key]] = Number(row.rate);
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
