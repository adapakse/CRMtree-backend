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
// Idempotency: invoices has UNIQUE(tenant_id, period_start, period_end) — a
// missed/duplicate/overlapping run can never double-bill a period.

const db      = require('../config/database');
const logger  = require('../utils/logger');
const audit   = require('../services/auditService');
const storage = require('../services/storageService');
const billing = require('../services/billingService');
const { generateInvoicePdfBuffer } = require('../services/invoicePdfService');

const lastRun = new Map(); // tenantId → 'YYYY-MM-DD', prevents re-processing within the same day

async function invoiceExists(tenantId, periodStart, periodEnd) {
  const { rows } = await db.query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3`,
    [tenantId, periodStart, periodEnd]
  );
  return rows.length > 0;
}

async function generateInvoice(tenant, billingCycle, period) {
  // Plan/price in effect for THIS period, not whatever's on the tenant right
  // now — a plan change since this period closed must not change its price.
  const currentPlan = {
    id: tenant.plan_id, code: tenant.plan_code, name: tenant.plan_name,
    price_monthly_eur: tenant.price_monthly_eur, price_annual_eur: tenant.price_annual_eur,
    is_custom_pricing: tenant.is_custom_pricing,
  };
  const plan = await billing.getPlanForPeriod(tenant.tenant_id, period.start, currentPlan);
  if (plan.is_custom_pricing) return; // was Professional during this period — manual invoicing only

  const activeUserCount = await billing.countActiveUsers(tenant.tenant_id, period.start, period.end);
  const amount = billing.calculateInvoiceAmount(plan, billingCycle, activeUserCount);
  if (!amount) {
    logger.info('[billing-run] Skipping — plan has no automatic pricing', {
      tenantId: tenant.tenant_id, planCode: plan.code, period,
    });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO invoices
       (tenant_id, plan_id, billing_cycle, period_start, period_end,
        active_user_count, unit_price_eur, total_amount_eur)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, period_start, period_end) DO NOTHING
     RETURNING *`,
    [tenant.tenant_id, plan.id, billingCycle, period.start, period.end,
     activeUserCount, amount.unitPriceEur, amount.totalAmountEur]
  );
  if (!rows.length) return; // raced with another insert for the same period
  const invoice = rows[0];

  try {
    const pdfBuffer = await generateInvoicePdfBuffer({
      invoice,
      tenant: { name: tenant.tenant_name },
      plan: { name: plan.name },
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
}

// Generates invoices for every closed, not-yet-invoiced period for one
// tenant — may be more than one if runs were missed.
async function catchUpTenant(tenant, today) {
  if (tenant.is_custom_pricing) return; // Professional — manual invoicing only, unchanged from before

  const duePeriods = tenant.billing_cycle === 'monthly'
    ? billing.getDueMonthlyPeriods(tenant.started_at, today)
    : billing.getDueAnnualPeriods(tenant.started_at, today);

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

async function fetchBillableTenants() {
  const { rows } = await db.query(`
    SELECT
      t.id AS tenant_id, t.name AS tenant_name,
      COALESCE(s.value, '02:00') AS run_time,
      ts.plan_id, ts.billing_cycle, ts.started_at,
      bp.code AS plan_code, bp.name AS plan_name,
      bp.price_monthly_eur, bp.price_annual_eur, bp.is_custom_pricing
    FROM tenants t
    JOIN tenant_subscriptions ts ON ts.tenant_id = t.id
    JOIN billing_plans bp        ON bp.id = ts.plan_id
    LEFT JOIN app_settings s     ON s.tenant_id = t.id AND s.key = 'billing_run_time'
    WHERE t.deleted_at IS NULL AND t.is_active = true
  `);
  return rows;
}

const TZ = 'Europe/Warsaw';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

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

module.exports = { startBillingRunJob };
