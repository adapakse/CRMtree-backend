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

const db     = require('../config/database');
const logger = require('../utils/logger');

function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

// ── Monthly periods: every full calendar month since the subscription
//    started, up to (not including) the month refDate falls in. The first
//    period runs from the actual started_at (not the 1st) through the end
//    of that calendar month if the subscription began mid-month — per the
//    2026-08 meeting, that partial first month is still billed in full
//    (no price proration), just with active-user counting starting at the
//    real start date instead of the 1st ─────────────────────────────────
//
// cancelledAt (tenant_subscriptions.cancelled_at, Date or ISO string):
// per the 2026-08 cancellation rule, the calendar month cancellation falls
// into is STILL billed in full once it closes (no proration) — but no month
// after it. Modeled as capping the effective refDate at the 1st of the
// month following cancellation, whichever is earlier than the real refDate:
// while today is still within the cancellation month, that cap is later
// than "today" and has no effect yet (period isn't due); once today moves
// past it, the cap freezes refDate there forever, so a re-run months later
// never produces additional periods.
function getDueMonthlyPeriods(startedAtStr, refDate, cancelledAt = null) {
  const started = new Date(`${startedAtStr}T00:00:00Z`);
  const periods = [];

  let effectiveRef = refDate;
  if (cancelledAt) {
    const cancelled = new Date(cancelledAt);
    const boundary = new Date(Date.UTC(cancelled.getUTCFullYear(), cancelled.getUTCMonth() + 1, 1));
    if (boundary.getTime() < effectiveRef.getTime()) effectiveRef = boundary;
  }

  let y = started.getUTCFullYear();
  let m = started.getUTCMonth();
  const refY = effectiveRef.getUTCFullYear();
  const refM = effectiveRef.getUTCMonth();
  let isFirstPeriod = true;

  while (y < refY || (y === refY && m < refM)) {
    const end = new Date(Date.UTC(y, m + 1, 0)); // last day of month m
    const start = isFirstPeriod ? startedAtStr : toDateStr(new Date(Date.UTC(y, m, 1)));
    periods.push({ start, end: toDateStr(end) });
    isFirstPeriod = false;

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

function getDueAnnualPeriods(startedAtStr, refDate, cancelledAt = null) {
  const started = new Date(`${startedAtStr}T00:00:00Z`);
  const periods = [];

  // Same capping idea as getDueMonthlyPeriods: find the first subscription
  // anniversary strictly after cancellation — that's when the annual period
  // containing the cancellation closes — and never generate anything past it.
  let effectiveRef = refDate;
  if (cancelledAt) {
    const cancelled = new Date(cancelledAt);
    let cn = 1;
    while (addYearsUTC(started, cn).getTime() <= cancelled.getTime()) cn++;
    const boundary = addYearsUTC(started, cn);
    if (boundary.getTime() < effectiveRef.getTime()) effectiveRef = boundary;
  }

  let n = 1;
  while (true) {
    const anniversary = addYearsUTC(started, n);
    if (anniversary.getTime() > effectiveRef.getTime()) break;

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
// plan, which may have changed since. Returns null when no history row
// covers periodStart (e.g. a data gap) — the caller MUST treat that as
// "cannot bill this period", never silently substitute the tenant's
// current plan, or a plan change could get invoiced onto a period it
// didn't apply to.
async function getPlanForPeriod(tenantId, periodStart) {
  const { rows } = await db.query(
    // Compared at day granularity, not instant — periods/started_at are DATE
    // values, but effective_from/effective_to are TIMESTAMPTZ (set to the
    // exact moment a superadmin clicked "Zapisz plan"). Comparing the raw
    // timestamp would make a plan's own first day fail to cover itself
    // whenever it was assigned after midnight — e.g. a subscription started
    // 2026-08-06 14:00 would not "cover" its own first period.start of
    // 2026-08-06. The whole calendar day of a plan change belongs to the
    // new plan.
    //
    // No LIMIT here on purpose — every row covering periodStart is fetched
    // so more-than-one can be detected and rejected below, instead of
    // silently picking the most recent one. The app's own PUT /subscription
    // always closes the old row before opening the new one atomically, so
    // this should never happen through normal use — but if it ever does
    // (bad data, manual DB edit), guessing which row is "right" risks
    // invoicing a period at a plan/price that never applied to it, which is
    // exactly what this whole history mechanism exists to prevent.
    `SELECT bp.id, bp.code, bp.name, bp.price_monthly_eur, bp.price_annual_eur, bp.is_custom_pricing,
            h.custom_price_eur, h.effective_from, h.effective_to
     FROM tenant_subscription_history h
     JOIN billing_plans bp ON bp.id = h.plan_id
     WHERE h.tenant_id = $1
       AND h.effective_from::date <= $2::date
       AND (h.effective_to IS NULL OR h.effective_to::date > $2::date)
     ORDER BY h.effective_from DESC`,
    [tenantId, periodStart]
  );
  if (rows.length > 1) {
    logger.error('[billingService] Ambiguous subscription history — more than one row covers periodStart, refusing to guess', {
      tenantId, periodStart,
      matches: rows.map(r => ({ planCode: r.code, customPriceEur: r.custom_price_eur, effectiveFrom: r.effective_from, effectiveTo: r.effective_to })),
    });
    return null;
  }
  return rows[0] || null;
}

// Standard Polish VAT rate for services (SaaS access included) — confirmed
// 2026-08-07. All prices configured in the system (plan rates, Professional
// custom quotes) are NET; VAT is added on top for the invoice total, never
// baked into the configured price itself.
const VAT_RATE_PERCENT = 23;

// A per-tenant custom_price_eur (set on tenant_subscriptions) always bills as
// a flat quote for the period — NOT multiplied by active_user_count. For
// Professional it's mandatory (billing_plans never carries a catalog price
// for it). For Lite/Standard it's an optional override — absent, it falls
// back to the catalog's per-user price below.
function calculateInvoiceAmount(plan, billingCycle, activeUserCount) {
  let unitPriceEur, totalAmountEur;
  if (plan.custom_price_eur != null) {
    unitPriceEur = Number(plan.custom_price_eur);
    totalAmountEur = unitPriceEur;
  } else {
    if (plan.is_custom_pricing) return null; // Professional assigned but no quote set yet
    const unitPrice = billingCycle === 'annual' ? plan.price_annual_eur : plan.price_monthly_eur;
    if (unitPrice == null) return null;
    unitPriceEur = Number(unitPrice);
    totalAmountEur = Math.round(unitPriceEur * activeUserCount * 100) / 100;
  }
  const vatAmountEur = Math.round(totalAmountEur * VAT_RATE_PERCENT) / 100;
  return { unitPriceEur, totalAmountEur, vatRatePercent: VAT_RATE_PERCENT, vatAmountEur };
}

// Buyer's legal country, matched against the common ways "Poland" gets typed
// into tenant_billing_details.country — a plain free-text input, not an
// ISO-code dropdown (see admin-tenants.js). Domestic (or not-yet-filled-in)
// buyers get the standard 23% rate, unchanged from before. Anything else is
// deliberately NOT auto-classified as EU reverse-charge vs. non-EU
// out-of-scope — doing that from free text (e.g. "Niemcy" vs "Germany" vs
// "DE") risks picking the wrong VAT treatment, which has real legal
// consequences. generateInvoice() refuses instead of guessing, the same way
// it already refuses on ambiguous subscription history.
const DOMESTIC_COUNTRY_ALIASES = new Set(['polska', 'poland', 'pl', 'rzeczpospolita polska']);
function isDomesticBuyerCountry(country) {
  if (!country) return true;
  return DOMESTIC_COUNTRY_ALIASES.has(String(country).trim().toLowerCase());
}

// CRMtree's own seller data (singleton row) — never hardcoded, filled in by
// a superadmin via PUT /admin/billing/seller-config. Always returns a row
// (the migration inserts id=1), individual fields may still be null until
// configured.
async function getSellerConfig() {
  const { rows } = await db.query(`SELECT * FROM billing_seller_config WHERE id = 1`);
  return rows[0];
}

// Legal buyer data for a tenant (company name/NIP/structured address/invoice
// email) — separate from tenants.name, which is just the CRM display name.
// Returns null if the tenant hasn't had this filled in yet (a valid, common
// state).
async function getTenantBillingDetails(tenantId) {
  const { rows } = await db.query(
    `SELECT company_name, nip, street, postal_code, city, country, invoice_email
     FROM tenant_billing_details WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

module.exports = {
  getDueMonthlyPeriods,
  getDueAnnualPeriods,
  countActiveUsers,
  getPlanForPeriod,
  calculateInvoiceAmount,
  isDomesticBuyerCountry,
  getSellerConfig,
  getTenantBillingDetails,
};
