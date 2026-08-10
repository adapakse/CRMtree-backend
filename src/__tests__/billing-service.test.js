'use strict';

// PDF/blob upload needs a real Azurite/Azure Storage endpoint — irrelevant to
// the pricing/period logic under test here, and generateInvoice() already
// tolerates upload failures (keeps the invoice row, just logs an error), so
// mocking it out only avoids a slow/flaky network timeout in CI.
jest.mock('../services/storageService', () => ({
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
}));

const db         = require('../config/database');
const billing    = require('../services/billingService');
const billingRun = require('../jobs/billing-run');
const { isInvoiceComplete } = require('../services/invoicePdfService');

// ─── Stałe testowe ────────────────────────────────────────────────────────────
const SLUG = 'zz-billing-test';

let tenantId;
let standardPlanId, professionalPlanId;
let originalSellerConfig; // billing_seller_config is a real singleton — snapshot/restore around tests that touch it

// ─── Setup ───────────────────────────────────────────────────────────────────
beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active)
     VALUES ('Billing Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;

  const { rows: plans } = await db.query(
    `SELECT id, code FROM billing_plans WHERE code IN ('standard', 'professional')`
  );
  standardPlanId     = plans.find(p => p.code === 'standard').id;
  professionalPlanId = plans.find(p => p.code === 'professional').id;

  originalSellerConfig = await billing.getSellerConfig();

  await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_subscription_history WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@billing-test.crmtree.local'`);
});

afterAll(async () => {
  await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_subscription_history WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@billing-test.crmtree.local'`);
  await db.query(
    `UPDATE billing_seller_config SET company_name=$1, nip=$2, address=$3, bank_account_number=$4, payment_term_days=$5 WHERE id = 1`,
    [originalSellerConfig.company_name, originalSellerConfig.nip, originalSellerConfig.address,
     originalSellerConfig.bank_account_number, originalSellerConfig.payment_term_days],
  );
});

async function seedHistory(rows) {
  await db.query(`DELETE FROM tenant_subscription_history WHERE tenant_id = $1`, [tenantId]);
  for (const r of rows) {
    await db.query(
      `INSERT INTO tenant_subscription_history
         (tenant_id, plan_id, billing_cycle, custom_price_eur, effective_from, effective_to)
       VALUES ($1, $2, 'monthly', $3, $4, $5)`,
      [tenantId, r.planId, r.customPriceEur ?? null, r.effectiveFrom, r.effectiveTo ?? null],
    );
  }
}

async function seedLogin(email, createdAt) {
  await db.query(`DELETE FROM users WHERE email = $1`, [email]);
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id)
     VALUES ($1, 'Test', 'User', FALSE, TRUE, $2)
     RETURNING id`,
    [email, tenantId],
  );
  await db.query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, created_at)
     VALUES ($1, $2, 'user_login', $3)`,
    [tenantId, user.id, createdAt],
  );
  return user.id;
}

// ─── getDueMonthlyPeriods ───────────────────────────────────────────────────
describe('billingService.getDueMonthlyPeriods', () => {
  test('subscription started on the 1st of a month bills full calendar months', () => {
    const periods = billing.getDueMonthlyPeriods('2026-06-01', new Date('2026-08-15T00:00:00Z'));
    expect(periods).toEqual([
      { start: '2026-06-01', end: '2026-06-30' },
      { start: '2026-07-01', end: '2026-07-31' },
    ]);
  });

  test('subscription started mid-month bills a partial first period from the real start date, not the 1st', () => {
    const periods = billing.getDueMonthlyPeriods('2026-08-06', new Date('2026-09-01T00:00:00Z'));
    expect(periods).toEqual([
      { start: '2026-08-06', end: '2026-08-31' },
    ]);
  });

  test('a mid-month first period is followed by full calendar months', () => {
    const periods = billing.getDueMonthlyPeriods('2026-08-06', new Date('2026-10-01T00:00:00Z'));
    expect(periods).toEqual([
      { start: '2026-08-06', end: '2026-08-31' },
      { start: '2026-09-01', end: '2026-09-30' },
    ]);
  });

  test('the current, still-open month is never billed', () => {
    // Started 2026-08-06, "today" is still within August — nothing is due yet.
    const periods = billing.getDueMonthlyPeriods('2026-08-06', new Date('2026-08-20T00:00:00Z'));
    expect(periods).toEqual([]);
  });
});

// ─── getDueMonthlyPeriods — cancellation mid-period (2026-08 Lite/Standard rule) ──
describe('billingService.getDueMonthlyPeriods — cancellation', () => {
  test('cancelling mid-month still bills that whole month once it closes, no proration', () => {
    // 100 users logged in 2026-08-01..05, tenant cancels 2026-08-06 — August
    // is still due in full once "today" moves past it.
    const periods = billing.getDueMonthlyPeriods('2026-01-01', new Date('2026-09-01T00:00:00Z'), '2026-08-06T10:00:00Z');
    expect(periods.at(-1)).toEqual({ start: '2026-08-01', end: '2026-08-31' });
  });

  test('cancelling on the last day of the month still bills that whole month', () => {
    const periods = billing.getDueMonthlyPeriods('2026-08-01', new Date('2026-09-01T00:00:00Z'), '2026-08-31T23:50:00Z');
    expect(periods).toEqual([{ start: '2026-08-01', end: '2026-08-31' }]);
  });

  test('no period is generated for the month after cancellation, even once it closes too', () => {
    // "today" has advanced all the way to October — without the cancellation
    // cap, September would also be due.
    const periods = billing.getDueMonthlyPeriods('2026-01-01', new Date('2026-10-01T00:00:00Z'), '2026-08-06T10:00:00Z');
    expect(periods).toEqual([
      { start: '2026-01-01', end: '2026-01-31' },
      { start: '2026-02-01', end: '2026-02-28' },
      { start: '2026-03-01', end: '2026-03-31' },
      { start: '2026-04-01', end: '2026-04-30' },
      { start: '2026-05-01', end: '2026-05-31' },
      { start: '2026-06-01', end: '2026-06-30' },
      { start: '2026-07-01', end: '2026-07-31' },
      { start: '2026-08-01', end: '2026-08-31' },
    ]);
  });

  test('the cancellation month is not yet due while "today" is still inside it', () => {
    const periods = billing.getDueMonthlyPeriods('2026-08-01', new Date('2026-08-20T00:00:00Z'), '2026-08-06T10:00:00Z');
    expect(periods).toEqual([]);
  });

  test('re-running with a later refDate after the cancelled period was already billed produces no additional periods', () => {
    const first  = billing.getDueMonthlyPeriods('2026-08-01', new Date('2026-09-01T00:00:00Z'), '2026-08-06T10:00:00Z');
    const second = billing.getDueMonthlyPeriods('2026-08-01', new Date('2026-12-01T00:00:00Z'), '2026-08-06T10:00:00Z');
    expect(second).toEqual(first);
  });
});

// ─── getPlanForPeriod ───────────────────────────────────────────────────────
describe('billingService.getPlanForPeriod', () => {
  test('returns null when no history row covers the period start — never guesses', async () => {
    await seedHistory([
      { planId: standardPlanId, effectiveFrom: '2026-08-06T10:00:00Z', effectiveTo: null },
    ]);
    const plan = await billing.getPlanForPeriod(tenantId, '2026-07-01');
    expect(plan).toBeNull();
  });

  test('resolves the plan whose history window covers the period start', async () => {
    await seedHistory([
      { planId: standardPlanId, effectiveFrom: '2026-08-06T10:00:00Z', effectiveTo: '2026-08-20T09:00:00Z' },
      { planId: professionalPlanId, customPriceEur: 300, effectiveFrom: '2026-08-20T09:00:00Z', effectiveTo: null },
    ]);
    const early = await billing.getPlanForPeriod(tenantId, '2026-08-06');
    expect(early.code).toBe('standard');

    const late = await billing.getPlanForPeriod(tenantId, '2026-09-01');
    expect(late.code).toBe('professional');
  });

  test('the calendar day of a plan change belongs to the new plan (day-granularity, not the exact timestamp)', async () => {
    await seedHistory([
      { planId: standardPlanId, effectiveFrom: '2026-08-06T10:00:00Z', effectiveTo: '2026-08-20T09:00:00Z' },
      { planId: professionalPlanId, customPriceEur: 300, effectiveFrom: '2026-08-20T09:00:00Z', effectiveTo: null },
    ]);
    const changeDay = await billing.getPlanForPeriod(tenantId, '2026-08-20');
    expect(changeDay.code).toBe('professional');
  });
});

// ─── countActiveUsers respects the real subscription start ────────────────
describe('billingService.countActiveUsers + first partial month', () => {
  test('a login before started_at is excluded, a login after is counted', async () => {
    await seedLogin('before-start@billing-test.crmtree.local', '2026-08-05T09:00:00Z');
    await seedLogin('after-start@billing-test.crmtree.local', '2026-08-16T09:00:00Z');

    const [period] = billing.getDueMonthlyPeriods('2026-08-06', new Date('2026-09-01T00:00:00Z'));
    expect(period.start).toBe('2026-08-06');

    const count = await billing.countActiveUsers(tenantId, period.start, period.end);
    expect(count).toBe(1);
  });
});

// ─── Standard → Professional mid-month: invoice-generation safety ─────────
describe('generateInvoice — Standard→Professional mid-month', () => {
  const tenantRow = () => ({ tenant_id: tenantId, tenant_name: 'Billing Test Tenant' });

  test('bills the August period as Standard, not Professional, when the plan changed on 2026-08-20', async () => {
    await seedHistory([
      { planId: standardPlanId, effectiveFrom: '2026-08-06T10:00:00Z', effectiveTo: '2026-08-20T09:00:00Z' },
      { planId: professionalPlanId, customPriceEur: 300, effectiveFrom: '2026-08-20T09:00:00Z', effectiveTo: null },
    ]);
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
    await seedLogin('active-aug@billing-test.crmtree.local', '2026-08-16T09:00:00Z');

    const period = { start: '2026-08-06', end: '2026-08-31' };
    const invoice = await billingRun.generateInvoice(tenantRow(), 'monthly', period);

    expect(invoice).not.toBeNull();
    expect(invoice.plan_id).toBe(standardPlanId);
    expect(Number(invoice.unit_price_eur)).toBe(36);
    expect(Number(invoice.total_amount_eur)).toBe(36); // 1 active user * 36 EUR
  });

  test('refuses to generate an invoice when no history covers the period — cannot confirm Professional applied', async () => {
    // Reproduces the exact real-world gap: the first history row starts
    // AFTER the period we're trying to bill (e.g. a backdated started_at
    // with no matching backdated history row).
    await seedHistory([
      { planId: professionalPlanId, customPriceEur: 300, effectiveFrom: '2026-08-20T09:00:00Z', effectiveTo: null },
    ]);
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);

    const period = { start: '2026-08-06', end: '2026-08-31' };
    const invoice = await billingRun.generateInvoice(tenantRow(), 'monthly', period);

    expect(invoice).toBeNull();
    const { rows } = await db.query(
      `SELECT id FROM invoices WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3`,
      [tenantId, period.start, period.end],
    );
    expect(rows).toHaveLength(0);
  });

  test('once Professional genuinely covers the whole period, it bills Professional at the flat quote', async () => {
    await seedHistory([
      { planId: professionalPlanId, customPriceEur: 300, effectiveFrom: '2026-08-20T09:00:00Z', effectiveTo: null },
    ]);
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);

    const period = { start: '2026-09-01', end: '2026-09-30' };
    const invoice = await billingRun.generateInvoice(tenantRow(), 'monthly', period);

    expect(invoice).not.toBeNull();
    expect(invoice.plan_id).toBe(professionalPlanId);
    expect(Number(invoice.total_amount_eur)).toBe(300);
  });
});

// ─── isInvoiceComplete — drives the PDF draft banner ───────────────────────
describe('invoicePdfService.isInvoiceComplete', () => {
  const complete = {
    seller_name: 'CRMtree', seller_nip: '1234567890', seller_address: 'ul. Testowa 1',
    seller_bank_account: 'PL00000000000000000000',
    buyer_name: 'Acme', buyer_nip: '0987654321',
    buyer_street: 'ul. Nabywcy 2', buyer_postal_code: '00-001', buyer_city: 'Warszawa',
    buyer_country: 'Polska', buyer_invoice_email: 'ksiegowosc@acme.pl',
  };

  test('true when every seller/buyer field is present', () => {
    expect(isInvoiceComplete(complete)).toBe(true);
  });

  test.each([
    'seller_name', 'seller_nip', 'seller_address', 'seller_bank_account',
    'buyer_name', 'buyer_nip', 'buyer_street', 'buyer_postal_code', 'buyer_city', 'buyer_country', 'buyer_invoice_email',
  ])('false when %s is missing', (field) => {
    expect(isInvoiceComplete({ ...complete, [field]: null })).toBe(false);
  });
});

// ─── due_date — frozen from billing_seller_config.payment_term_days ───────
describe('generateInvoice — due_date', () => {
  test('is computed from the seller config payment_term_days at generation time', async () => {
    await db.query(`UPDATE billing_seller_config SET payment_term_days = 30 WHERE id = 1`);
    await seedHistory([
      { planId: standardPlanId, effectiveFrom: '2026-08-06T10:00:00Z', effectiveTo: null },
    ]);
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);

    const period = { start: '2026-08-06', end: '2026-08-31' };
    const invoice = await billingRun.generateInvoice(
      { tenant_id: tenantId, tenant_name: 'Billing Test Tenant' }, 'monthly', period,
    );

    const today = billingRun.getToday();
    const expectedDueDate = new Date(today.getTime() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    expect(invoice.due_date).toBe(expectedDueDate);
  });
});

// ─── Void → same period can be regenerated ─────────────────────────────────
describe('voiding an invoice frees its period for a corrected regeneration', () => {
  test('invoiceExists() ignores void rows, and generateInvoice() can insert a new one for the same period', async () => {
    await seedHistory([
      { planId: standardPlanId, effectiveFrom: '2026-08-06T10:00:00Z', effectiveTo: null },
    ]);
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);

    const period = { start: '2026-08-06', end: '2026-08-31' };
    const tenantRow = { tenant_id: tenantId, tenant_name: 'Billing Test Tenant' };

    const first = await billingRun.generateInvoice(tenantRow, 'monthly', period);
    expect(first).not.toBeNull();
    expect(await billingRun.invoiceExists(tenantId, period.start, period.end)).toBe(true);

    // Simulate the void route: mark it void with a reason (never deleted).
    await db.query(
      `UPDATE invoices SET status = 'void', void_reason = $2, voided_at = NOW() WHERE id = $1`,
      [first.id, 'zły plan na fakturze — test'],
    );

    expect(await billingRun.invoiceExists(tenantId, period.start, period.end)).toBe(false);

    const corrected = await billingRun.generateInvoice(tenantRow, 'monthly', period);
    expect(corrected).not.toBeNull();
    expect(corrected.id).not.toBe(first.id);
    expect(corrected.status).toBe('issued');

    // Both rows must still exist — voiding never deletes.
    const { rows } = await db.query(
      `SELECT id, status FROM invoices WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3 ORDER BY created_at`,
      [tenantId, period.start, period.end],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.status).sort()).toEqual(['issued', 'void']);
  });
});

// ─── catchUpTenant — cancelled mid-period tenant (2026-08 Lite/Standard rule) ──
// Full pipeline: tenant_subscriptions.cancelled_at -> fetchBillableTenants
// shape -> catchUpTenant -> generateInvoice, against the real DB, matching
// Adam's example: users active before cancellation, no billing afterward.
describe('catchUpTenant — cancelled mid-period tenant', () => {
  function tenantRow(cancelledAt) {
    return {
      tenant_id: tenantId, tenant_name: 'Billing Test Tenant',
      billing_cycle: 'monthly', started_at: '2026-08-01', cancelled_at: cancelledAt,
    };
  }

  beforeEach(async () => {
    await db.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
    await seedHistory([
      { planId: standardPlanId, effectiveFrom: '2026-08-01T00:00:00Z', effectiveTo: null },
    ]);
  });

  test('logins before the cancellation date are still counted on the final invoice', async () => {
    await seedLogin('early1@billing-test.crmtree.local', '2026-08-02T09:00:00Z');
    await seedLogin('early2@billing-test.crmtree.local', '2026-08-04T09:00:00Z');

    await billingRun.catchUpTenant(tenantRow('2026-08-06T10:00:00Z'), new Date('2026-09-01T00:00:00Z'));

    const { rows } = await db.query(
      `SELECT active_user_count, period_start, period_end FROM invoices
       WHERE tenant_id = $1 AND status = 'issued'`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ period_start: '2026-08-01', period_end: '2026-08-31', active_user_count: 2 });
  });

  test('no invoice is generated for the month following cancellation', async () => {
    await seedLogin('early1@billing-test.crmtree.local', '2026-08-02T09:00:00Z');

    // "today" is well past September too — without the cancellation cap this
    // would also produce a September invoice.
    await billingRun.catchUpTenant(tenantRow('2026-08-06T10:00:00Z'), new Date('2026-10-01T00:00:00Z'));

    const { rows } = await db.query(
      `SELECT period_start, period_end FROM invoices WHERE tenant_id = $1 AND status = 'issued'`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ period_start: '2026-08-01', period_end: '2026-08-31' });
  });

  test('a repeated batch run creates no additional invoices for the already-billed cancelled tenant', async () => {
    await seedLogin('early1@billing-test.crmtree.local', '2026-08-02T09:00:00Z');

    const tenant = tenantRow('2026-08-06T10:00:00Z');
    await billingRun.catchUpTenant(tenant, new Date('2026-09-01T00:00:00Z'));
    await billingRun.catchUpTenant(tenant, new Date('2026-09-01T00:00:00Z')); // same run twice
    await billingRun.catchUpTenant(tenant, new Date('2026-12-01T00:00:00Z')); // months later

    const { rows } = await db.query(
      `SELECT period_start, period_end FROM invoices WHERE tenant_id = $1 AND status = 'issued'`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
  });
});
