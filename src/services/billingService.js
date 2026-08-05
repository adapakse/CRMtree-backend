'use strict';
// src/services/billingService.js
//
// Billing period math + active-user counting for the billing-run batch.
// "Active user" (2026-08-03 meeting): a user with at least one login during
// the billing period. Reused directly from audit_logs (action='user_login')
// — no separate login-history table, last_login_at only tracks the most
// recent login and can't answer "did they log in during period X".
//
// Period functions return EVERY closed period since the subscription started
// that hasn't happened yet as of refDate, not just "the previous one" — the
// batch calls invoiceExists() per period and only creates the missing ones,
// so a restart or a missed tick self-heals instead of permanently skipping
// whatever period(s) were due while nothing was running.

const db = require('../config/database');

function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

// ── Monthly periods: every full calendar month since the subscription's
//    first full month, up to (not including) the month refDate falls in ─────
function getDueMonthlyPeriods(startedAtStr, refDate) {
  const started = new Date(`${startedAtStr}T00:00:00Z`);
  const periods = [];

  let y = started.getUTCFullYear();
  let m = started.getUTCMonth();
  const refY = refDate.getUTCFullYear();
  const refM = refDate.getUTCMonth();

  while (y < refY || (y === refY && m < refM)) {
    const start = new Date(Date.UTC(y, m, 1));
    const end   = new Date(Date.UTC(y, m + 1, 0)); // last day of month m
    const startStr = toDateStr(start);
    if (startStr >= startedAtStr) periods.push({ start: startStr, end: toDateStr(end) });

    m++;
    if (m > 11) { m = 0; y++; }
  }
  return periods;
}

// ── Annual periods: every closed 12-month period anchored on the
//    subscription's started_at anniversary, up to refDate ──────────────────
function addYearsUTC(date, years) {
  const d = new Date(date.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

function getDueAnnualPeriods(startedAtStr, refDate) {
  const started = new Date(`${startedAtStr}T00:00:00Z`);
  const periods = [];

  let n = 1;
  while (true) {
    const anniversary = addYearsUTC(started, n);
    if (anniversary.getTime() > refDate.getTime()) break;

    const end = new Date(anniversary.getTime());
    end.setUTCDate(end.getUTCDate() - 1);
    const start = addYearsUTC(started, n - 1);
    periods.push({ start: toDateStr(start), end: toDateStr(end) });
    n++;
  }
  return periods;
}

async function countActiveUsers(tenantId, periodStart, periodEnd) {
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT user_id)::int AS count
     FROM audit_logs
     WHERE tenant_id = $1
       AND action = 'user_login'
       AND created_at >= $2::date
       AND created_at < ($3::date + INTERVAL '1 day')`,
    [tenantId, periodStart, periodEnd]
  );
  return rows[0].count;
}

// Plan (and its price columns) that was actually in effect at periodStart,
// per tenant_subscription_history — NOT necessarily the tenant's current
// plan, which may have changed since. Falls back to the current plan if a
// tenant somehow has no history row covering that date (shouldn't happen
// after the 0237 backfill, but keeps the batch from crashing on it).
async function getPlanForPeriod(tenantId, periodStart, currentPlan) {
  const { rows } = await db.query(
    `SELECT bp.id, bp.code, bp.name, bp.price_monthly_eur, bp.price_annual_eur, bp.is_custom_pricing
     FROM tenant_subscription_history h
     JOIN billing_plans bp ON bp.id = h.plan_id
     WHERE h.tenant_id = $1
       AND h.effective_from <= $2::date
       AND (h.effective_to IS NULL OR h.effective_to > $2::date)
     ORDER BY h.effective_from DESC
     LIMIT 1`,
    [tenantId, periodStart]
  );
  return rows[0] || currentPlan;
}

function calculateInvoiceAmount(plan, billingCycle, activeUserCount) {
  const unitPrice = billingCycle === 'annual' ? plan.price_annual_eur : plan.price_monthly_eur;
  if (unitPrice == null) return null; // custom pricing (Professional) — not auto-billable
  const unit = Number(unitPrice);
  return {
    unitPriceEur: unit,
    totalAmountEur: Math.round(unit * activeUserCount * 100) / 100,
  };
}

module.exports = {
  getDueMonthlyPeriods,
  getDueAnnualPeriods,
  countActiveUsers,
  getPlanForPeriod,
  calculateInvoiceAmount,
};
