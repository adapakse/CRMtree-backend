'use strict';
// src/jobs/billing-run.js
//
// Cyclical billing batch — modeled on jobs/daily-scores.js (same polling +
// per-tenant run_time scheduler shape). Default run time configurable via
// app_settings key 'billing_run_time', but unlike daily-scores.js this batch
// does NOT rely on hitting that exact tick: for every active tenant it asks
// billingService for every closed period since the subscription started that
// doesn't have an invoice yet, and generates all of them. That means a
// missed tick, a downed server, or a fresh deploy self-heals on the next run
// instead of permanently skipping whatever period was due — a single-period
// "bill yesterday's month" design could otherwise silently skip a tenant
// forever if the exact day/time was missed once.
//
// startBillingRunJob() also runs one unconditional catch-up pass immediately
// on boot (ignoring run_time/lastRun) so a restart doesn't have to wait for
// the next scheduled tick to close a gap left by downtime.
//
// Idempotency: invoices has a partial UNIQUE index on
// (tenant_id, period_start, period_end) WHERE status = 'issued' — a
// missed/duplicate/overlapping run can never double-bill a period with two
// ISSUED invoices, but a superadmin voiding a wrong one frees that period up
// for a corrected regeneration (see migration 0240).

const db      = require('../config/database');
const logger  = require('../utils/logger');
const audit   = require('../services/auditService');
const storage = require('../services/storageService');
const billing = require('../services/billingService');
const { generateInvoicePdfBuffer } = require('../services/invoicePdfService');

const lastRun = new Map(); // tenantId → 'YYYY-MM-DD', prevents re-processing within the same day

// Only an ISSUED invoice counts as "this period is billed" — a voided one
// doesn't, so a superadmin voiding a wrong invoice lets the next run (or a
// manual test-generate) produce a corrected one for the same period. Matches
// the partial unique index on (tenant_id, period_start, period_end) WHERE
// status = 'issued' (migration 0240).
async function invoiceExists(tenantId, periodStart, periodEnd) {
  const { rows } = await db.query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3 AND status = 'issued'`,
    [tenantId, periodStart, periodEnd]
  );
  return rows.length > 0;
}

async function generateInvoice(tenant, billingCycle, period) {
  // Plan/price in effect for THIS period, not whatever's on the tenant right
  // now — a plan change since this period closed must not change its price.
  const plan = await billing.getPlanForPeriod(tenant.tenant_id, period.start);
  if (!plan) {
    // Either no tenant_subscription_history row covers period.start, or more
    // than one does (ambiguous — billingService already logged which rows
    // conflict). Either way, billing which plan applied would mean guessing,
    // and guessing risks invoicing a plan change (e.g. Standard→Professional)
    // onto a period it never applied to. Refuse to generate; this period
    // stays uninvoiced until the history gap/conflict is fixed, and the next
    // batch run will pick it up automatically.
    logger.error('[billing-run] Skipping — cannot unambiguously determine the plan for period start (no coverage or conflicting history rows)', {
      tenantId: tenant.tenant_id, period,
    });
    return null;
  }

  // Freeze seller/buyer legal data + due date onto the invoice row at
  // generation time — a later edit to CRMtree's seller config or the
  // tenant's NIP/address must not retroactively change an already-issued
  // invoice. Either side may still be incomplete (null fields) at this
  // point; the PDF renders placeholders and keeps a draft banner for that.
  const [sellerConfig, buyerDetails] = await Promise.all([
    billing.getSellerConfig(),
    billing.getTenantBillingDetails(tenant.tenant_id),
  ]);

  if (!billing.isDomesticBuyerCountry(buyerDetails?.country)) {
    // Buyer's country doesn't match a recognized "Poland" spelling — VAT
    // treatment (23% domestic vs. EU reverse-charge vs. non-EU out-of-scope)
    // can't be safely auto-determined from a free-text field. Refuse rather
    // than guess (see isDomesticBuyerCountry's comment); a superadmin has to
    // resolve this manually before the period can be billed.
    logger.error('[billing-run] Skipping — buyer country is not recognized as domestic (Poland); VAT treatment must be reviewed manually before invoicing', {
      tenantId: tenant.tenant_id, buyerCountry: buyerDetails?.country, period,
    });
    return null;
  }

  // active_user_count is still recorded for Professional (informational —
  // shown on the invoice) even though calculateInvoiceAmount below doesn't
  // use it to price a custom-pricing plan.
  const activeUserCount = await billing.countActiveUsers(tenant.tenant_id, period.start, period.end);
  const amount = billing.calculateInvoiceAmount(plan, billingCycle, activeUserCount);
  if (!amount) {
    logger.info('[billing-run] Skipping — plan has no automatic pricing', {
      tenantId: tenant.tenant_id, planCode: plan.code, period,
    });
    return null;
  }

  const paymentTermDays = sellerConfig?.payment_term_days ?? 14;
  const dueDate = new Date(getToday().getTime() + paymentTermDays * 24 * 3600 * 1000);

  const { rows } = await db.query(
    `INSERT INTO invoices
       (tenant_id, plan_id, billing_cycle, period_start, period_end,
        active_user_count, unit_price_eur, total_amount_eur, vat_rate, vat_amount_eur, due_date,
        seller_name, seller_nip, seller_address, seller_bank_account,
        buyer_name, buyer_nip, buyer_street, buyer_postal_code, buyer_city, buyer_country, buyer_invoice_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (tenant_id, period_start, period_end) WHERE status = 'issued' DO NOTHING
     RETURNING *`,
    [tenant.tenant_id, plan.id, billingCycle, period.start, period.end,
     activeUserCount, amount.unitPriceEur, amount.totalAmountEur, amount.vatRatePercent, amount.vatAmountEur, dueDate.toISOString().slice(0, 10),
     sellerConfig?.company_name ?? null, sellerConfig?.nip ?? null,
     sellerConfig?.address ?? null, sellerConfig?.bank_account_number ?? null,
     buyerDetails?.company_name ?? tenant.tenant_name, buyerDetails?.nip ?? null,
     buyerDetails?.street ?? null, buyerDetails?.postal_code ?? null,
     buyerDetails?.city ?? null, buyerDetails?.country ?? null, buyerDetails?.invoice_email ?? null]
  );
  if (!rows.length) return null; // raced with another insert for the same period
  const invoice = rows[0];

  try {
    const pdfBuffer = await generateInvoicePdfBuffer({
      invoice,
      plan: { name: plan.name, is_custom_pricing: plan.is_custom_pricing },
    });
    const blobPath = `invoices/${tenant.tenant_id}/${invoice.invoice_number}.pdf`;
    await storage.uploadBuffer(blobPath, pdfBuffer, 'application/pdf');
    await db.query(`UPDATE invoices SET pdf_blob_path = $1 WHERE id = $2`, [blobPath, invoice.id]);
  } catch (err) {
    logger.error('[billing-run] PDF generation/upload failed — invoice row kept without PDF', {
      invoiceId: invoice.id, error: err.message,
    });
  }

  await audit.log({
    user: { tenant_id: tenant.tenant_id },
    action: 'invoice_generated',
    afterState: {
      invoiceNumber: invoice.invoice_number,
      planCode: plan.code,
      periodStart: period.start,
      periodEnd: period.end,
      activeUserCount,
      totalAmountEur: amount.totalAmountEur,
    },
  });

  logger.info('[billing-run] Invoice generated', {
    tenantId: tenant.tenant_id, invoiceNumber: invoice.invoice_number,
    planCode: plan.code, period, activeUserCount, totalAmountEur: amount.totalAmountEur,
  });

  return invoice;
}

// Generates invoices for every closed, not-yet-invoiced period for one
// tenant — may be more than one if runs were missed. Professional (custom
// pricing) tenants go through the same due-period math as Lite/Standard;
// generateInvoice() -> calculateInvoiceAmount() is what actually decides
// whether there's a price to bill (skips silently if no quote is set yet).
async function catchUpTenant(tenant, today) {
  const duePeriods = tenant.billing_cycle === 'monthly'
    ? billing.getDueMonthlyPeriods(tenant.started_at, today, tenant.cancelled_at)
    : billing.getDueAnnualPeriods(tenant.started_at, today, tenant.cancelled_at);

  for (const period of duePeriods) {
    if (await invoiceExists(tenant.tenant_id, period.start, period.end)) continue;
    try {
      await generateInvoice(tenant, tenant.billing_cycle, period);
    } catch (err) {
      logger.error('[billing-run] Failed to generate invoice', {
        tenantId: tenant.tenant_id, period, error: err.message,
      });
    }
  }
}

// Deliberately does NOT filter on t.is_active — that flag is toggled for
// reasons unrelated to billing (e.g. suspension) and, per the 2026-08
// cancellation rule, must never be read as "this subscription ended". The
// only billing-authoritative end-of-subscription signal is
// tenant_subscriptions.cancelled_at, which getDueMonthlyPeriods/
// getDueAnnualPeriods use to cap how far catchUpTenant() generates periods.
// A hard-deleted tenant (t.deleted_at) is still excluded — that's a
// different, stronger lifecycle event out of scope here.
async function fetchBillableTenants(tenantId = null) {
  const { rows } = await db.query(`
    SELECT
      t.id AS tenant_id, t.name AS tenant_name,
      COALESCE(s.value, '02:00') AS run_time,
      ts.plan_id, ts.billing_cycle, ts.started_at, ts.custom_price_eur, ts.cancelled_at,
      bp.is_custom_pricing
    FROM tenants t
    JOIN tenant_subscriptions ts ON ts.tenant_id = t.id
    JOIN billing_plans bp        ON bp.id = ts.plan_id
    LEFT JOIN app_settings s     ON s.tenant_id = t.id AND s.key = 'billing_run_time'
    WHERE t.deleted_at IS NULL
      ${tenantId ? 'AND t.id = $1' : ''}
  `, tenantId ? [tenantId] : []);
  return rows;
}

// Single-tenant lookup for the manual "test invoice" endpoint — same shape/
// eligibility rules as the batch (must have a subscription, be active) so
// generateInvoice() below behaves identically whether called from the batch
// or on demand.
async function fetchBillableTenant(tenantId) {
  const rows = await fetchBillableTenants(tenantId);
  return rows[0] || null;
}

const TZ = 'Europe/Warsaw';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

// "Today" per the same Europe/Warsaw day boundary the batch uses to decide
// which periods are closed — reused by the manual test-invoice endpoint so
// "last closed period" means the same thing there as it does in the batch.
function getToday() {
  return new Date(`${dateFmt.format(new Date())}T00:00:00Z`);
}

function startBillingRunJob() {
  // Unconditional catch-up on boot — closes any gap left by downtime without
  // waiting for the next tick that happens to match a tenant's run_time.
  (async () => {
    try {
      const today = new Date(`${dateFmt.format(new Date())}T00:00:00Z`);
      const tenants = await fetchBillableTenants();
      for (const tenant of tenants) await catchUpTenant(tenant, today);
      logger.info('[billing-run] Startup catch-up complete', { tenantsChecked: tenants.length });
    } catch (err) {
      logger.error('[billing-run] Startup catch-up failed', { error: err.message });
    }
  })();

  setInterval(async () => {
    const now      = new Date();
    const hhmm     = timeFmt.format(now);
    const todayStr = dateFmt.format(now); // "YYYY-MM-DD" in Europe/Warsaw

    try {
      const tenants = await fetchBillableTenants();
      const today = new Date(`${todayStr}T00:00:00Z`);
      for (const tenant of tenants) {
        if (tenant.run_time !== hhmm)                  continue;
        if (lastRun.get(tenant.tenant_id) === todayStr) continue;
        lastRun.set(tenant.tenant_id, todayStr);
        catchUpTenant(tenant, today); // fire-and-forget, errors handled inside
      }
    } catch (err) {
      logger.error('[billing-run] Scheduler tick error', { error: err.message });
    }
  }, 60_000);

  logger.info('[billing-run] Billing run job started (catch-up on boot, then polling every minute)');
}

module.exports = {
  startBillingRunJob,
  // Exported for the superadmin "generate test invoice" endpoint
  // (admin-billing.js) — reuses the exact same insert/PDF/audit logic as the
  // batch instead of duplicating it. Does not change batch behavior.
  generateInvoice,
  invoiceExists,
  fetchBillableTenant,
  getToday,
  // Exported for tests exercising the full catch-up loop (cancellation
  // capping, re-run idempotency) without duplicating its period-iteration
  // logic in the test file.
  catchUpTenant,
};
