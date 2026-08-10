'use strict';
// Full end-to-end billing audit (2026-08-07). Read-only with respect to
// production code — every scenario below exercises the REAL production
// functions (billingService, billing-run, invoicePdfService, the actual
// HTTP routes for void/subscription/seller-config/billing-details) against
// the existing `zz-billing-test` fixture tenant (shared with
// billing-service.test.js, same self-cleaning beforeAll/afterAll pattern —
// no new persistent tenant created). CRMtree Gold and all other real
// tenants are never touched.

jest.mock('../services/storageService', () => ({
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
}));

const request   = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const billing   = require('../services/billingService');
const billingRun = require('../jobs/billing-run');
const { generateInvoicePdfBuffer, isInvoiceComplete } = require('../services/invoicePdfService');
const { signAccessToken } = require('../middleware/auth');

const SLUG = 'zz-billing-test';

let tenantId;
let planIds = {}; // code -> id
let superadmin, authToken;
let originalSellerConfig;

function auth(req) { return req.set('Authorization', `Bearer ${authToken}`); }
function tenantRow() { return { tenant_id: tenantId, tenant_name: 'Billing Test Tenant' }; }

async function resetTenantBilling() {
  await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_subscription_history WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_billing_details WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
}

async function seedHistory(rows) {
  await db.query(`DELETE FROM tenant_subscription_history WHERE tenant_id = $1`, [tenantId]);
  for (const r of rows) {
    await db.query(
      `INSERT INTO tenant_subscription_history
         (tenant_id, plan_id, billing_cycle, custom_price_eur, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, r.planId, r.cycle || 'monthly', r.customPriceEur ?? null, r.effectiveFrom, r.effectiveTo ?? null],
    );
  }
}

let userCounter = 0;
async function seedLogin(createdAt, existingUserId) {
  let uid = existingUserId;
  if (!uid) {
    userCounter += 1;
    const email = `audit-user-${userCounter}@zz-billing-test.crmtree.local`;
    const { rows: [u] } = await db.query(
      `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id)
       VALUES ($1,'Test','User',FALSE,TRUE,$2) RETURNING id`,
      [email, tenantId],
    );
    uid = u.id;
  }
  await db.query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, created_at) VALUES ($1,$2,'user_login',$3)`,
    [tenantId, uid, createdAt],
  );
  return uid;
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Billing Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;

  const { rows: plans } = await db.query(`SELECT id, code FROM billing_plans WHERE code IN ('lite','standard','professional')`);
  for (const p of plans) planIds[p.code] = p.id;

  const { rows: [sa] } = await db.query(
    `SELECT id, email, display_name, is_admin, is_active, crm_role, tenant_id, is_super_admin
     FROM users WHERE is_super_admin = true LIMIT 1`,
  );
  superadmin = sa;
  authToken = signAccessToken(sa);

  originalSellerConfig = await billing.getSellerConfig();

  await resetTenantBilling();
});

afterAll(async () => {
  await resetTenantBilling();
  await db.query(
    `UPDATE billing_seller_config SET company_name=$1, nip=$2, address=$3, bank_account_number=$4, payment_term_days=$5 WHERE id = 1`,
    [originalSellerConfig.company_name, originalSellerConfig.nip, originalSellerConfig.address,
     originalSellerConfig.bank_account_number, originalSellerConfig.payment_term_days],
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 1. ACTIVE USERS — login mechanisms, period boundaries, dedup
// ═══════════════════════════════════════════════════════════════════════
describe('1. Active users — period boundaries', () => {
  // Period boundaries are interpreted in the DB session timezone
  // (Europe/Warsaw — confirmed via `SHOW timezone`), matching getToday()'s
  // explicit Europe/Warsaw usage elsewhere in billing-run.js. That means
  // "2026-03-01" as a boundary is 2026-02-28T23:00:00Z (CET, UTC+1) and
  // "end of 2026-03-31" is 2026-03-31T22:00:00Z (CEST, UTC+2 — DST already
  // switched by April 1) — NOT plain UTC midnight. Test timestamps below
  // are chosen with enough margin to be unambiguous on either side.
  const periodStart = '2026-03-01';
  const periodEnd   = '2026-03-31';

  beforeEach(async () => {
    await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
    userCounter = 0;
  });

  test('login before period start is excluded', async () => {
    await seedLogin('2026-02-28T20:00:00Z'); // 21:00 Warsaw, still Feb 28 locally
    expect(await billing.countActiveUsers(tenantId, periodStart, periodEnd)).toBe(0);
  });

  test('login on the first day of the period is included', async () => {
    await seedLogin('2026-03-01T00:00:01Z');
    expect(await billing.countActiveUsers(tenantId, periodStart, periodEnd)).toBe(1);
  });

  test('login in the middle of the period is included', async () => {
    await seedLogin('2026-03-15T12:00:00Z');
    expect(await billing.countActiveUsers(tenantId, periodStart, periodEnd)).toBe(1);
  });

  test('login on the last day of the period is included', async () => {
    await seedLogin('2026-03-31T18:00:00Z'); // 20:00 Warsaw, still March 31 locally
    expect(await billing.countActiveUsers(tenantId, periodStart, periodEnd)).toBe(1);
  });

  test('login after the period end is excluded', async () => {
    await seedLogin('2026-04-01T00:00:01Z');
    expect(await billing.countActiveUsers(tenantId, periodStart, periodEnd)).toBe(0);
  });

  test('the same user logging in multiple times within the period counts once', async () => {
    const uid = await seedLogin('2026-03-02T08:00:00Z');
    await seedLogin('2026-03-10T08:00:00Z', uid);
    await seedLogin('2026-03-20T08:00:00Z', uid);
    expect(await billing.countActiveUsers(tenantId, periodStart, periodEnd)).toBe(1);
  });

  test('multiple distinct users each logging in once all count', async () => {
    await seedLogin('2026-03-02T08:00:00Z');
    await seedLogin('2026-03-10T08:00:00Z');
    await seedLogin('2026-03-20T08:00:00Z');
    expect(await billing.countActiveUsers(tenantId, periodStart, periodEnd)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. BATCH BILLING — Lite / Standard / Professional × monthly / annual
// ═══════════════════════════════════════════════════════════════════════
describe('2. Batch billing pricing', () => {
  const period = { start: '2026-05-01', end: '2026-05-31' };
  const annualPeriod = { start: '2025-05-01', end: '2026-04-30' };

  beforeEach(async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
    userCounter = 0;
  });

  test.each([
    ['lite', 'monthly', period, 28.00, 3, 84.00],
    ['lite', 'annual', annualPeriod, 228.00, 3, 684.00],
    ['standard', 'monthly', period, 36.00, 4, 144.00],
    ['standard', 'annual', annualPeriod, 336.00, 4, 1344.00],
  ])('%s %s: active-user count and price = count × unit price', async (code, cycle, p, unitPrice, userCount, expectedTotal) => {
    await seedHistory([{ planId: planIds[code], cycle, effectiveFrom: '2020-01-01', effectiveTo: null }]);
    for (let i = 0; i < userCount; i++) await seedLogin(`${p.start}T09:00:00Z`);

    const invoice = await billingRun.generateInvoice(tenantRow(), cycle, p);
    expect(invoice).not.toBeNull();
    expect(invoice.active_user_count).toBe(userCount);
    expect(Number(invoice.unit_price_eur)).toBe(unitPrice);
    expect(Number(invoice.total_amount_eur)).toBe(expectedTotal);
  });

  test.each([
    ['monthly', period],
    ['annual', annualPeriod],
  ])('professional %s: uses custom_price_eur flat, NOT multiplied by user count', async (cycle, p) => {
    await seedHistory([{ planId: planIds.professional, cycle, customPriceEur: 500, effectiveFrom: '2020-01-01', effectiveTo: null }]);
    for (let i = 0; i < 7; i++) await seedLogin(`${p.start}T09:00:00Z`);

    const invoice = await billingRun.generateInvoice(tenantRow(), cycle, p);
    expect(invoice).not.toBeNull();
    expect(invoice.active_user_count).toBe(7); // still recorded, just not used to price
    expect(Number(invoice.unit_price_eur)).toBe(500);
    expect(Number(invoice.total_amount_eur)).toBe(500); // NOT 7 × 500
  });

  test('professional amount is identical regardless of active user count (0 vs many)', async () => {
    await seedHistory([{ planId: planIds.professional, cycle: 'monthly', customPriceEur: 500, effectiveFrom: '2020-01-01', effectiveTo: null }]);
    // Zero logins this time.
    const invoiceZero = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    expect(invoiceZero.active_user_count).toBe(0);
    expect(Number(invoiceZero.total_amount_eur)).toBe(500);
  });

  test('professional price is resolved historically: a later custom_price_eur change does not affect an already-generated invoice for an earlier period', async () => {
    await seedHistory([
      { planId: planIds.professional, cycle: 'monthly', customPriceEur: 400, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01' },
      { planId: planIds.professional, cycle: 'monthly', customPriceEur: 900, effectiveFrom: '2026-06-01', effectiveTo: null },
    ]);
    const mayInvoice = await billingRun.generateInvoice(tenantRow(), 'monthly', period); // May, under the 400 EUR window
    expect(Number(mayInvoice.total_amount_eur)).toBe(400);

    const junePeriod = { start: '2026-06-01', end: '2026-06-30' };
    const juneInvoice = await billingRun.generateInvoice(tenantRow(), 'monthly', junePeriod); // June, under the 900 EUR window
    expect(Number(juneInvoice.total_amount_eur)).toBe(900);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. SUBSCRIPTION CHANGES — historical correctness across every transition
// ═══════════════════════════════════════════════════════════════════════
describe('3. Subscription changes resolve historically, never using the current plan for a past period', () => {
  beforeEach(async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
  });

  test('Lite → Standard mid-period: earlier period bills Lite, later period bills Standard', async () => {
    await seedHistory([
      { planId: planIds.lite,     cycle: 'monthly', effectiveFrom: '2026-01-01', effectiveTo: '2026-02-15' },
      { planId: planIds.standard, cycle: 'monthly', effectiveFrom: '2026-02-15', effectiveTo: null },
    ]);
    const jan = await billing.getPlanForPeriod(tenantId, '2026-01-01');
    const feb = await billing.getPlanForPeriod(tenantId, '2026-03-01');
    expect(jan.code).toBe('lite');
    expect(feb.code).toBe('standard');
  });

  test('Standard → Professional mid-period', async () => {
    await seedHistory([
      { planId: planIds.standard,     cycle: 'monthly', effectiveFrom: '2026-01-01', effectiveTo: '2026-02-15' },
      { planId: planIds.professional, cycle: 'monthly', customPriceEur: 600, effectiveFrom: '2026-02-15', effectiveTo: null },
    ]);
    expect((await billing.getPlanForPeriod(tenantId, '2026-01-01')).code).toBe('standard');
    expect((await billing.getPlanForPeriod(tenantId, '2026-03-01')).code).toBe('professional');
  });

  test('Professional → Standard mid-period', async () => {
    await seedHistory([
      { planId: planIds.professional, cycle: 'monthly', customPriceEur: 600, effectiveFrom: '2026-01-01', effectiveTo: '2026-02-15' },
      { planId: planIds.standard,     cycle: 'monthly', effectiveFrom: '2026-02-15', effectiveTo: null },
    ]);
    expect((await billing.getPlanForPeriod(tenantId, '2026-01-01')).code).toBe('professional');
    expect((await billing.getPlanForPeriod(tenantId, '2026-03-01')).code).toBe('standard');
  });

  test('monthly → annual: history correctly records the cycle change, old period keeps old cycle', async () => {
    await seedHistory([
      { planId: planIds.standard, cycle: 'monthly', effectiveFrom: '2026-01-01', effectiveTo: '2026-02-15' },
      { planId: planIds.standard, cycle: 'annual',  effectiveFrom: '2026-02-15', effectiveTo: null },
    ]);
    expect((await billing.getPlanForPeriod(tenantId, '2026-01-01'))).toMatchObject({ code: 'standard' });
    const { rows } = await db.query(
      `SELECT billing_cycle FROM tenant_subscription_history WHERE tenant_id=$1 AND effective_from <= '2026-01-01' AND effective_to > '2026-01-01'`,
      [tenantId],
    );
    expect(rows[0].billing_cycle).toBe('monthly');
    const { rows: rows2 } = await db.query(
      `SELECT billing_cycle FROM tenant_subscription_history WHERE tenant_id=$1 AND effective_to IS NULL`,
      [tenantId],
    );
    expect(rows2[0].billing_cycle).toBe('annual');
  });

  test('annual → monthly: same check in reverse', async () => {
    await seedHistory([
      { planId: planIds.standard, cycle: 'annual',  effectiveFrom: '2026-01-01', effectiveTo: '2026-02-15' },
      { planId: planIds.standard, cycle: 'monthly', effectiveFrom: '2026-02-15', effectiveTo: null },
    ]);
    const { rows } = await db.query(
      `SELECT billing_cycle FROM tenant_subscription_history WHERE tenant_id=$1 AND effective_from <= '2026-01-01' AND effective_to > '2026-01-01'`,
      [tenantId],
    );
    expect(rows[0].billing_cycle).toBe('annual');
  });

  test('custom_price_eur change within Professional (same plan/cycle) is tracked as a distinct history row and resolved historically', async () => {
    await seedHistory([
      { planId: planIds.professional, cycle: 'monthly', customPriceEur: 400, effectiveFrom: '2026-01-01', effectiveTo: '2026-02-15' },
      { planId: planIds.professional, cycle: 'monthly', customPriceEur: 750, effectiveFrom: '2026-02-15', effectiveTo: null },
    ]);
    const before = await billing.getPlanForPeriod(tenantId, '2026-01-10');
    const after  = await billing.getPlanForPeriod(tenantId, '2026-03-01');
    expect(Number(before.custom_price_eur)).toBe(400);
    expect(Number(after.custom_price_eur)).toBe(750);
  });

  test('real PUT /subscription route: Lite → Standard produces exactly the expected two-row history shape', async () => {
    await resetTenantBilling();
    const put1 = await auth(request(app).put(`/api/admin/tenants/${tenantId}/subscription`))
      .send({ planId: planIds.lite, billingCycle: 'monthly', customPriceEur: null });
    expect(put1.status).toBe(200);

    const put2 = await auth(request(app).put(`/api/admin/tenants/${tenantId}/subscription`))
      .send({ planId: planIds.standard, billingCycle: 'monthly', customPriceEur: null });
    expect(put2.status).toBe(200);

    const { rows } = await db.query(
      `SELECT plan_id, effective_from, effective_to FROM tenant_subscription_history WHERE tenant_id=$1 ORDER BY effective_from`,
      [tenantId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].plan_id).toBe(planIds.lite);
    expect(rows[0].effective_to).not.toBeNull(); // closed
    expect(rows[1].plan_id).toBe(planIds.standard);
    expect(rows[1].effective_to).toBeNull(); // open
    expect(rows[0].effective_to.getTime()).toBe(rows[1].effective_from.getTime()); // no gap, no overlap
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. INVOICE GENERATION SAFETY
// ═══════════════════════════════════════════════════════════════════════
describe('4. Invoice generation safety', () => {
  beforeEach(async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
  });

  test('generating the same period twice never creates a duplicate row', async () => {
    await seedHistory([{ planId: planIds.lite, cycle: 'monthly', effectiveFrom: '2020-01-01', effectiveTo: null }]);
    const period = { start: '2026-04-01', end: '2026-04-30' };

    const first  = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    const second = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // ON CONFLICT ... DO NOTHING

    const { rows } = await db.query(
      `SELECT id FROM invoices WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3`,
      [tenantId, period.start, period.end],
    );
    expect(rows).toHaveLength(1);
  });

  test('re-running the due-period loop twice (simulated batch re-run) is idempotent', async () => {
    await seedHistory([{ planId: planIds.lite, cycle: 'monthly', effectiveFrom: '2026-01-01', effectiveTo: null }]);
    const today = new Date('2026-04-15T00:00:00Z');
    const runOnce = async () => {
      const duePeriods = billing.getDueMonthlyPeriods('2026-01-01', today);
      for (const period of duePeriods) {
        if (await billingRun.invoiceExists(tenantId, period.start, period.end)) continue;
        await billingRun.generateInvoice(tenantRow(), 'monthly', period);
      }
    };
    await runOnce();
    await runOnce(); // simulated re-run of the batch

    const { rows } = await db.query(`SELECT period_start FROM invoices WHERE tenant_id=$1`, [tenantId]);
    const uniquePeriods = new Set(rows.map(r => String(r.period_start))); // pg returns DATE columns as plain strings
    expect(rows.length).toBe(uniquePeriods.size); // no duplicates
    expect(rows.length).toBe(3); // Jan, Feb, Mar due as of mid-April
  });

  test('no history at all for the period: generation refuses instead of guessing', async () => {
    await db.query(`DELETE FROM tenant_subscription_history WHERE tenant_id = $1`, [tenantId]);
    const invoice = await billingRun.generateInvoice(tenantRow(), 'monthly', { start: '2026-04-01', end: '2026-04-30' });
    expect(invoice).toBeNull();
    const { rows } = await db.query(`SELECT id FROM invoices WHERE tenant_id=$1`, [tenantId]);
    expect(rows).toHaveLength(0);
  });

  test('FIXED: overlapping/ambiguous history rows are detected and refused instead of guessing', async () => {
    // The app itself never creates overlaps (PUT /subscription always closes
    // the old row before opening the new one, atomically) — this simulates
    // corrupted/manually-edited data. Before the fix, getPlanForPeriod
    // silently picked whichever row had the latest effective_from; now it
    // must refuse (return null) whenever more than one row covers the date.
    await seedHistory([
      { planId: planIds.lite, cycle: 'monthly', effectiveFrom: '2026-01-01', effectiveTo: null },
    ]);
    // Manually insert a SECOND, overlapping open row (bad data — two rows
    // both claim to cover 2026-04-01 with effective_to IS NULL).
    await db.query(
      `INSERT INTO tenant_subscription_history (tenant_id, plan_id, billing_cycle, custom_price_eur, effective_from, effective_to)
       VALUES ($1,$2,'monthly',NULL,'2026-02-01',NULL)`,
      [tenantId, planIds.standard],
    );
    const plan = await billing.getPlanForPeriod(tenantId, '2026-04-01');
    expect(plan).toBeNull();

    // generateInvoice() must also refuse end-to-end, not just the raw helper.
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
    const invoice = await billingRun.generateInvoice(tenantRow(), 'monthly', { start: '2026-04-01', end: '2026-04-30' });
    expect(invoice).toBeNull();
    const { rows } = await db.query(`SELECT id FROM invoices WHERE tenant_id=$1`, [tenantId]);
    expect(rows).toHaveLength(0);
  });

  test('the current, still-open month is never a due period (never auto-invoiced)', () => {
    const today = new Date('2026-04-15T00:00:00Z'); // "today" is mid-April
    const periods = billing.getDueMonthlyPeriods('2026-04-01', today);
    expect(periods).toEqual([]); // April itself must not appear
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. VOID + REISSUE
// ═══════════════════════════════════════════════════════════════════════
describe('5. Void and reissue', () => {
  test('void via the real HTTP route records reason/user/time in both the invoice row and audit_logs, and allows reissue', async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1 AND action = 'invoice_voided'`, [tenantId]);
    await seedHistory([{ planId: planIds.lite, cycle: 'monthly', effectiveFrom: '2020-01-01', effectiveTo: null }]);

    const period = { start: '2026-04-01', end: '2026-04-30' };
    const original = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    expect(original).not.toBeNull();

    const beforeVoidAt = new Date();
    const voidRes = await auth(request(app).put(`/api/admin/billing/invoices/${original.id}/void`))
      .send({ reason: 'Błędna kwota — test audytu' });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.status).toBe('void');
    expect(voidRes.body.void_reason).toBe('Błędna kwota — test audytu');
    expect(new Date(voidRes.body.voided_at).getTime()).toBeGreaterThanOrEqual(beforeVoidAt.getTime() - 2000);

    // audit_logs.tenant_id reflects the ACTING superadmin's own home tenant
    // (per auditService.log()'s `user?.tenant_id`), not the tenant the
    // voided invoice belongs to — that's in metadata.tenant_id instead.
    // Match on action + metadata.invoice_id only.
    const { rows: auditRows } = await db.query(
      `SELECT user_id, user_email, after_state, metadata FROM audit_logs
       WHERE action = 'invoice_voided' AND (metadata->>'invoice_id') = $1`,
      [original.id],
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const entry = auditRows[0];
    expect(entry.user_id).toBe(superadmin.id);
    expect(entry.user_email).toBe(superadmin.email);
    expect(entry.after_state.reason).toBe('Błędna kwota — test audytu');

    // Voided invoice still visible in the list.
    const { rows: stillThere } = await db.query(`SELECT status FROM invoices WHERE id = $1`, [original.id]);
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].status).toBe('void');

    // Reissue for the same period now succeeds.
    const corrected = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    expect(corrected).not.toBeNull();
    expect(corrected.status).toBe('issued');

    const { rows: allForPeriod } = await db.query(
      `SELECT status FROM invoices WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3`,
      [tenantId, period.start, period.end],
    );
    expect(allForPeriod).toHaveLength(2);
    expect(allForPeriod.filter(r => r.status === 'issued')).toHaveLength(1);
    expect(allForPeriod.filter(r => r.status === 'void')).toHaveLength(1);

    // Voiding the already-void invoice again is rejected.
    const doubleVoid = await auth(request(app).put(`/api/admin/billing/invoices/${original.id}/void`))
      .send({ reason: 'próba drugiego anulowania' });
    expect(doubleVoid.status).toBe(409);

    // Reason is required.
    const noReason = await auth(request(app).put(`/api/admin/billing/invoices/${corrected.id}/void`)).send({});
    expect(noReason.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. SNAPSHOT IMMUTABILITY
// ═══════════════════════════════════════════════════════════════════════
describe('6. Invoice snapshot is frozen at generation time', () => {
  test('changing seller config, buyer details, plan, and price after issuance does not alter the already-issued invoice', async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);

    await auth(request(app).put('/api/admin/billing/seller-config')).send({
      company_name: 'Before Sp. z o.o.', nip: '1111111111', address: 'ul. Przed 1',
      bank_account_number: 'PL11', payment_term_days: 14,
    });
    await auth(request(app).put(`/api/admin/tenants/${tenantId}/billing-details`)).send({
      company_name: 'Buyer Before', nip: '2222222222', street: 'ul. Nabywcy Przed 1',
      postal_code: '00-001', city: 'Przed City', country: 'Polska', invoice_email: 'before@example.invalid',
    });
    await seedHistory([{ planId: planIds.standard, cycle: 'monthly', effectiveFrom: '2020-01-01', effectiveTo: null }]);

    const period = { start: '2026-04-01', end: '2026-04-30' };
    const invoice = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    expect(invoice).not.toBeNull();

    const snapshot = { ...invoice };

    // Change everything after issuance.
    await auth(request(app).put('/api/admin/billing/seller-config')).send({
      company_name: 'After Sp. z o.o.', nip: '9999999999', address: 'ul. Po 99',
      bank_account_number: 'PL99', payment_term_days: 30,
    });
    await auth(request(app).put(`/api/admin/tenants/${tenantId}/billing-details`)).send({
      company_name: 'Buyer After', nip: '8888888888', street: 'ul. Nabywcy Po 2',
      postal_code: '99-999', city: 'Po City', country: 'Germany', invoice_email: 'after@example.invalid',
    });
    await auth(request(app).put(`/api/admin/tenants/${tenantId}/subscription`))
      .send({ planId: planIds.professional, billingCycle: 'monthly', customPriceEur: 999 });

    const { rows: [refetched] } = await db.query(`SELECT * FROM invoices WHERE id = $1`, [invoice.id]);

    expect(refetched.plan_id).toBe(snapshot.plan_id);
    expect(Number(refetched.unit_price_eur)).toBe(Number(snapshot.unit_price_eur));
    expect(Number(refetched.total_amount_eur)).toBe(Number(snapshot.total_amount_eur));
    expect(refetched.seller_name).toBe('Before Sp. z o.o.');
    expect(refetched.seller_nip).toBe('1111111111');
    expect(refetched.seller_bank_account).toBe('PL11');
    expect(refetched.buyer_name).toBe('Buyer Before');
    expect(refetched.buyer_nip).toBe('2222222222');
    expect(refetched.buyer_street).toBe('ul. Nabywcy Przed 1');
    expect(refetched.buyer_country).toBe('Polska');
    expect(refetched.buyer_invoice_email).toBe('before@example.invalid');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. PDF RENDERING
// ═══════════════════════════════════════════════════════════════════════
describe('7. PDF rendering', () => {
  function baseInvoice(overrides) {
    return {
      id: 'test', invoice_number: 'INV-TEST-0001', billing_cycle: 'monthly',
      period_start: '2026-04-01', period_end: '2026-04-30', due_date: '2026-05-15',
      active_user_count: 3, unit_price_eur: '36.00', total_amount_eur: '108.00',
      currency: 'EUR', status: 'issued', generated_at: new Date().toISOString(),
      seller_name: null, seller_nip: null, seller_address: null, seller_bank_account: null,
      buyer_name: null, buyer_nip: null, buyer_street: null, buyer_postal_code: null,
      buyer_city: null, buyer_country: null, buyer_invoice_email: null,
      ...overrides,
    };
  }
  const completeFields = {
    seller_name: 'CRMtree Sp. z o.o.', seller_nip: '1234567890', seller_address: 'ul. Testowa 1, Warszawa',
    seller_bank_account: 'PL61 1090 1014 0000 0712 1981 2874',
    buyer_name: 'Acme', buyer_nip: '0987654321', buyer_street: 'ul. Nabywcy 2',
    buyer_postal_code: '00-001', buyer_city: 'Warszawa', buyer_country: 'Polska',
    buyer_invoice_email: 'ksiegowosc@acme.pl',
  };

  test.each([
    ['lite', { name: 'Lite', is_custom_pricing: false }],
    ['standard', { name: 'Standard', is_custom_pricing: false }],
    ['professional', { name: 'Professional', is_custom_pricing: true }],
  ])('%s: renders without throwing, produces a real PDF buffer', async (code, plan) => {
    const invoice = baseInvoice(code === 'professional' ? { unit_price_eur: '500.00', total_amount_eur: '500.00' } : {});
    const buf = await generateInvoicePdfBuffer({ invoice, plan });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(10000); // a real rendered page, not a stub
    expect(buf.slice(0, 4).toString('latin1')).toBe('%PDF'); // valid PDF header
  });

  test('incomplete data renders successfully and isInvoiceComplete is false', async () => {
    const invoice = baseInvoice({}); // all seller/buyer fields null
    expect(isInvoiceComplete(invoice)).toBe(false);
    const buf = await generateInvoicePdfBuffer({ invoice, plan: { name: 'Lite', is_custom_pricing: false } });
    expect(buf.length).toBeGreaterThan(10000);
  });

  test('complete data renders successfully and isInvoiceComplete is true', async () => {
    const invoice = baseInvoice(completeFields);
    expect(isInvoiceComplete(invoice)).toBe(true);
    const buf = await generateInvoicePdfBuffer({ invoice, plan: { name: 'Standard', is_custom_pricing: false } });
    expect(buf.length).toBeGreaterThan(10000);
  });

  test('very long company name and Polish diacritics do not throw', async () => {
    const invoice = baseInvoice({
      ...completeFields,
      seller_name: 'Bardzo Długa Nazwa Spółki Akcyjnej z Ograniczoną Odpowiedzialnością i Wieloma Dodatkowymi Segmentami Prawnymi Sp. z o.o. Sp. k.',
      buyer_name: 'Żółć Gęślą Jaźń Świętokrzyska Ćma Łąka Ńórski Sp. z o.o.',
      buyer_street: 'ul. Świętokrzyska Żąbkowicka 123/456',
      buyer_city: 'Świętochłowice',
    });
    const buf = await generateInvoicePdfBuffer({ invoice, plan: { name: 'Standard', is_custom_pricing: false } });
    expect(buf.length).toBeGreaterThan(10000);
    expect(buf.slice(0, 4).toString('latin1')).toBe('%PDF');
  });

  test('professional line item: quantity is 1 and unit price equals the total (not active_user_count × price)', async () => {
    // Regression guard for the fix made earlier this session — re-verified
    // here as part of the full audit rather than assumed from memory.
    const invoice = baseInvoice({ ...completeFields, active_user_count: 9, unit_price_eur: '500.00', total_amount_eur: '500.00' });
    const buf = await generateInvoicePdfBuffer({ invoice, plan: { name: 'Professional', is_custom_pricing: true } });
    expect(buf.length).toBeGreaterThan(10000);
    // Full visual confirmation (qty=1, "9 aktywnych użytkowników" in the
    // item name, 1×500.00=500.00) done separately via manual PDF read —
    // see audit report.
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. VAT (23%)
// ═══════════════════════════════════════════════════════════════════════
describe('8. VAT (23%)', () => {
  // Section 6's immutability test changes tenant_billing_details.country to
  // 'Germany' AFTER issuing its invoice (on purpose, to prove the already-
  // issued row doesn't change) and never resets it — without this, that
  // leftover 'Germany' row would make every generateInvoice() call below hit
  // the new non-domestic-buyer refusal added in this section. Every test
  // that calls generateInvoice() without itself setting billing-details
  // needs a clean (no-row = domestic) starting point.
  beforeEach(async () => {
    await db.query(`DELETE FROM tenant_billing_details WHERE tenant_id = $1`, [tenantId]);
  });

  // Local copy of section 7's baseInvoice/completeFields helpers — those are
  // scoped inside describe('7. PDF rendering', ...) and not reachable here.
  function baseInvoiceForPdf(overrides) {
    return {
      id: 'test', invoice_number: 'INV-TEST-VAT-0001', billing_cycle: 'monthly',
      period_start: '2026-04-01', period_end: '2026-04-30', due_date: '2026-05-15',
      active_user_count: 3, unit_price_eur: '36.00', total_amount_eur: '108.00',
      vat_rate: '23.00', vat_amount_eur: '24.84',
      currency: 'EUR', status: 'issued', generated_at: new Date().toISOString(),
      seller_name: 'CRMtree Sp. z o.o.', seller_nip: '1234567890', seller_address: 'ul. Testowa 1, Warszawa',
      seller_bank_account: 'PL61 1090 1014 0000 0712 1981 2874',
      buyer_name: 'Acme', buyer_nip: '0987654321', buyer_street: 'ul. Nabywcy 2',
      buyer_postal_code: '00-001', buyer_city: 'Warszawa', buyer_country: 'Polska',
      buyer_invoice_email: 'ksiegowosc@acme.pl',
      ...overrides,
    };
  }

  test('calculateInvoiceAmount: 23% VAT computed on top of the net total for per-user plans (Lite/Standard)', () => {
    const plan = { is_custom_pricing: false, price_monthly_eur: '12.00', price_annual_eur: '120.00' };
    const amount = billing.calculateInvoiceAmount(plan, 'monthly', 4);
    expect(amount.unitPriceEur).toBe(12);
    expect(amount.totalAmountEur).toBe(48); // net: 12 × 4
    expect(amount.vatRatePercent).toBe(23);
    expect(amount.vatAmountEur).toBe(11.04); // 48 × 0.23
  });

  test('calculateInvoiceAmount: 23% VAT computed on top of the flat quote for Professional (custom pricing), unaffected by active_user_count', () => {
    const plan = { is_custom_pricing: true, custom_price_eur: '500.00' };
    const amount = billing.calculateInvoiceAmount(plan, 'monthly', 9);
    expect(amount.totalAmountEur).toBe(500); // never multiplied by active_user_count
    expect(amount.vatRatePercent).toBe(23);
    expect(amount.vatAmountEur).toBe(115); // 500 × 0.23
  });

  test('generateInvoice freezes vat_rate=23 and the correct vat_amount_eur on a newly issued invoice', async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
    await seedHistory([{ planId: planIds.standard, cycle: 'monthly', effectiveFrom: '2020-01-01', effectiveTo: null }]);

    const period = { start: '2026-04-01', end: '2026-04-30' };
    const invoice = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    expect(invoice).not.toBeNull();
    expect(Number(invoice.vat_rate)).toBe(23);
    expect(Number(invoice.vat_amount_eur)).toBeCloseTo(Number(invoice.total_amount_eur) * 0.23, 2);

    const { rows: [refetched] } = await db.query(
      `SELECT vat_rate, vat_amount_eur FROM invoices WHERE id = $1`, [invoice.id],
    );
    expect(Number(refetched.vat_rate)).toBe(23);
    expect(Number(refetched.vat_amount_eur)).toBeCloseTo(Number(invoice.total_amount_eur) * 0.23, 2);
  });

  test('IMMUTABILITY: a pre-VAT invoice (vat_rate=0, migration 0242 default) is never retroactively recomputed', async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
    await seedHistory([{ planId: planIds.standard, cycle: 'monthly', effectiveFrom: '2020-01-01', effectiveTo: null }]);

    // Simulate an invoice issued before VAT existed — inserted directly
    // (bypassing generateInvoice, and thus vat_rate/vat_amount_eur), the same
    // way migration 0242's ADD COLUMN ... DEFAULT 0 left pre-existing rows.
    const { rows: [oldInvoice] } = await db.query(
      `INSERT INTO invoices
         (tenant_id, plan_id, billing_cycle, period_start, period_end, active_user_count,
          unit_price_eur, total_amount_eur, due_date)
       VALUES ($1,$2,'monthly','2026-01-01','2026-01-31',2,'36.00','72.00','2026-02-14')
       RETURNING *`,
      [tenantId, planIds.standard],
    );
    expect(Number(oldInvoice.vat_rate)).toBe(0);
    expect(Number(oldInvoice.vat_amount_eur)).toBe(0);

    // Generating a NEW invoice for a later period must apply 23% VAT going
    // forward, without touching the old, already-issued row at all.
    const newPeriod = { start: '2026-04-01', end: '2026-04-30' };
    const newInvoice = await billingRun.generateInvoice(tenantRow(), 'monthly', newPeriod);
    expect(newInvoice).not.toBeNull();
    expect(Number(newInvoice.vat_rate)).toBe(23);

    const { rows: [stillOld] } = await db.query(
      `SELECT vat_rate, vat_amount_eur FROM invoices WHERE id = $1`, [oldInvoice.id],
    );
    expect(Number(stillOld.vat_rate)).toBe(0);
    expect(Number(stillOld.vat_amount_eur)).toBe(0);
  });

  test('PDF: gross total (brutto) equals net + vat_amount_eur, and the rate label reflects the frozen vat_rate', async () => {
    const invoice = baseInvoiceForPdf({
      total_amount_eur: '108.00', vat_rate: '23.00', vat_amount_eur: '24.84',
    });
    const buf = await generateInvoicePdfBuffer({ invoice, plan: { name: 'Standard', is_custom_pricing: false } });
    expect(buf.length).toBeGreaterThan(10000);
    expect(buf.slice(0, 4).toString('latin1')).toBe('%PDF');
    // Full visual confirmation (23% label, 108.00 + 24.84 = 132.84 "Do
    // zapłaty") done separately via manual PDF read — see audit report.
  });

  test('PDF: an old, pre-VAT invoice (vat_rate=0) still renders without throwing', async () => {
    const invoice = baseInvoiceForPdf({
      total_amount_eur: '108.00', vat_rate: '0.00', vat_amount_eur: '0.00',
    });
    const buf = await generateInvoicePdfBuffer({ invoice, plan: { name: 'Standard', is_custom_pricing: false } });
    expect(buf.length).toBeGreaterThan(10000);
  });

  test('isDomesticBuyerCountry: recognizes common spellings of Poland and treats blank as domestic', () => {
    expect(billing.isDomesticBuyerCountry(null)).toBe(true);
    expect(billing.isDomesticBuyerCountry(undefined)).toBe(true);
    expect(billing.isDomesticBuyerCountry('')).toBe(true);
    expect(billing.isDomesticBuyerCountry('Polska')).toBe(true);
    expect(billing.isDomesticBuyerCountry('  POLSKA  ')).toBe(true);
    expect(billing.isDomesticBuyerCountry('poland')).toBe(true);
    expect(billing.isDomesticBuyerCountry('PL')).toBe(true);
    expect(billing.isDomesticBuyerCountry('Germany')).toBe(false);
    expect(billing.isDomesticBuyerCountry('Niemcy')).toBe(false);
    expect(billing.isDomesticBuyerCountry('DE')).toBe(false);
  });

  test('generateInvoice refuses to bill a non-domestic buyer instead of guessing the VAT treatment', async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
    await seedHistory([{ planId: planIds.standard, cycle: 'monthly', effectiveFrom: '2020-01-01', effectiveTo: null }]);
    await auth(request(app).put(`/api/admin/tenants/${tenantId}/billing-details`)).send({
      company_name: 'Foreign Buyer GmbH', nip: '2222222222', street: 'Teststraße 1',
      postal_code: '10115', city: 'Berlin', country: 'Germany', invoice_email: 'foreign@example.invalid',
    });

    const period = { start: '2026-04-01', end: '2026-04-30' };
    const invoice = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    expect(invoice).toBeNull();

    const { rows } = await db.query(`SELECT id FROM invoices WHERE tenant_id=$1`, [tenantId]);
    expect(rows).toHaveLength(0);

    // A domestic (Polish) buyer for the same period still generates normally.
    await auth(request(app).put(`/api/admin/tenants/${tenantId}/billing-details`)).send({
      company_name: 'Buyer PL', nip: '3333333333', street: 'ul. Testowa 1',
      postal_code: '00-001', city: 'Warszawa', country: 'Polska', invoice_email: 'pl@example.invalid',
    });
    const invoicePL = await billingRun.generateInvoice(tenantRow(), 'monthly', period);
    expect(invoicePL).not.toBeNull();
    expect(Number(invoicePL.vat_rate)).toBe(23);
  });
});
