'use strict';

// KSeF purchase invoices over HTTP — the per-user permission, the tenant
// admin's configuration (companies and tokens), the invoice list and detail,
// "sync now", and linking invoices to project cost items.
//
// Multi-tenant: everything is created under one dedicated test tenant (plus a
// second one for isolation checks) and cleaned up by tenant_id. KSeF is the
// fake from helpers/ksefMock.js, NBP always answers "no table"; exchange-rate
// fixtures live in 1999, as in project-finance.test.js.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const { decrypt } = require('../utils/encrypt');
const { signAccessToken } = require('../middleware/auth');
const ksefApiClient = require('../services/ksefApiClient');
const ksefSyncService = require('../services/ksefSyncService');
const { createKsefMock } = require('./helpers/ksefMock');

const SLUG            = 'zz-ksef-invoices-test';
const OTHER_SLUG      = 'zz-ksef-invoices-test-other';
const EMAIL_DOMAIN    = '@ksef-invoices-test.crmtree.local';
const FIXTURE_ERA_END = '2000-01-01';
const BUYER_NIP       = '3430714583';
const SELLER_NIP      = '8976607794';
const DAY_MS          = 86_400_000;

let tenantId, otherTenantId;
let admin, pm, plainPm, worker, controller, viewer, outsider, external, salesManager;
let project, euroProject, categoryId;
let mock;
let invoiceSequence = 0;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);
const financeUrl = (suffix = '', target = project) => `/api/projects/${target.id}/finance${suffix}`;
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

async function mkUser(local, flags = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id, is_external,
                        can_create_projects, crm_role, can_view_ksef_invoices)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5, $6, $7, $8) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, Boolean(flags.isAdmin), tenantId, Boolean(flags.isExternal),
     Boolean(flags.canCreate), flags.crmRole || null, Boolean(flags.canViewKsef)],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

async function insertInvoice(overrides = {}) {
  invoiceSequence += 1;
  const invoice = {
    tenant_id: tenantId,
    ksef_number: `${SELLER_NIP}-20261003-BBBB${String(invoiceSequence).padStart(8, '0')}-C7`,
    invoice_number: `FV/${invoiceSequence}`,
    issue_date: isoDaysAgo(5),
    seller_nip: SELLER_NIP,
    seller_name: 'Hotel Pod Lipami Sp. z o.o.',
    buyer_nip: BUYER_NIP,
    net_amount: 1000,
    vat_amount: 230,
    gross_amount: 1230,
    currency: 'PLN',
    ...overrides,
  };
  const columns = Object.keys(invoice);
  const { rows: [created] } = await db.query(
    `INSERT INTO ksef_invoices (${columns.join(', ')})
     VALUES (${columns.map((column, index) => `$${index + 1}`).join(', ')}) RETURNING id, ksef_number, invoice_number`,
    columns.map((column) => invoice[column]),
  );
  return created;
}

async function insertCompany(overrides = {}) {
  const { rows: [company] } = await db.query(
    `INSERT INTO ksef_companies (tenant_id, nip, token_encrypted, token_hint, sync_from, status, last_error)
     VALUES ($1, $2, 'not-a-real-ciphertext', 'oken', now(), $3, $4) RETURNING *`,
    [overrides.tenantId || tenantId, overrides.nip || BUYER_NIP, overrides.status || 'active', overrides.lastError || null],
  );
  return company;
}

async function storeRates(rates) {
  for (const [currency, date, rate] of rates) {
    await db.query(
      'INSERT INTO nbp_exchange_rates (currency, rate_date, mid_rate) VALUES ($1, $2, $3)', [currency, date, rate],
    );
  }
}

async function clearRateFixtures() {
  await db.query('DELETE FROM nbp_exchange_rates WHERE rate_date < $1', [FIXTURE_ERA_END]);
}

async function cleanup() {
  await db.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM ksef_invoices WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  await db.query('DELETE FROM ksef_companies WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  await db.query('DELETE FROM project_cost_categories WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_statuses WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_types WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_priorities WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [tenantId]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
  await clearRateFixtures();
}

const setFinanceSwitch = (isEnabled) =>
  api('put', '/api/admin/project-config/finance', admin).send({ is_enabled: isEnabled });

async function createTask(name = 'Zadanie', target = project) {
  const res = await api('post', `/api/projects/${target.id}/tasks`, pm).send({ name });
  expect(res.status).toBe(201);
  return res.body;
}

const linkBody = (invoice, overrides = {}) => ({ ksef_invoice_id: invoice.id, category_id: categoryId, ...overrides });

async function link(invoice, overrides = {}, { user = pm, target = project } = {}) {
  const res = await api('post', financeUrl('/costs', target), user).send(linkBody(invoice, overrides));
  expect(res.status).toBe(201);
  return res.body;
}

async function addPlainCost(overrides = {}, user = pm) {
  const res = await api('post', financeUrl('/costs'), user)
    .send({ date: '2026-09-15', amount: 100, category_id: categoryId, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

const getInvoice = async (invoice, user = viewer) => (await api('get', `/api/ksef/invoices/${invoice.id}`, user)).body;

beforeAll(async () => {
  const createTenant = async (name, slug) => (await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [name, slug],
  )).rows[0].id;
  tenantId = await createTenant('KSeF Invoices Test', SLUG);
  otherTenantId = await createTenant('KSeF Invoices Test Other', OTHER_SLUG);
  await db.query(
    `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', TRUE)
     ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE`,
    [tenantId],
  );
  await cleanup();

  admin        = await mkUser('kadmin', { isAdmin: true });
  pm           = await mkUser('kpm', { canCreate: true, canViewKsef: true });
  plainPm      = await mkUser('kplainpm');
  worker       = await mkUser('kworker', { canViewKsef: true });
  controller   = await mkUser('kcontroller');
  viewer       = await mkUser('kviewer', { canViewKsef: true });
  outsider     = await mkUser('koutsider');
  external     = await mkUser('kexternal', { isExternal: true });
  salesManager = await mkUser('kmanager', { crmRole: 'sales_manager' });

  jest.spyOn(emailUtil, 'sendProjectTaskAssigned').mockResolvedValue();
  project = (await api('post', '/api/projects', pm).send({ name: 'Projekt KSeF' })).body;
  euroProject = (await api('post', '/api/projects', pm).send({ name: 'Projekt Euro' })).body;
  for (const member of [
    { user_id: plainPm.id,    role: 'pm' },
    { user_id: worker.id,     role: 'internal_participant', access_level: 'full' },
    { user_id: controller.id, role: 'controller' },
    { user_id: external.id,   role: 'external_participant', access_level: 'full' },
  ]) {
    const added = await api('post', `/api/projects/${project.id}/members`, pm).send(member);
    expect(added.status).toBe(201);
  }

  expect((await setFinanceSwitch(true)).status).toBe(200);
  const { body: config } = await api('get', '/api/projects/config', admin);
  categoryId = config.cost_categories[0].id;
  jest.restoreAllMocks();
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenant_features WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM tenants WHERE slug = ANY($1::text[])', [[SLUG, OTHER_SLUG]]);
});

beforeEach(async () => {
  for (const table of ['project_cost_items', 'project_finance', 'project_tasks']) {
    await db.query(`DELETE FROM ${table} WHERE project_id = ANY($1::uuid[])`, [[project.id, euroProject.id]]);
  }
  await db.query('DELETE FROM ksef_invoices WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  await db.query('DELETE FROM ksef_companies WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  await db.query("DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'ksef_initial_sync_days'", [tenantId]);
  await db.query(
    "UPDATE projects SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = $1", [project.id],
  );
  await clearRateFixtures();

  process.env.KSEF_ENVIRONMENT = 'test';
  ksefApiClient.clearPublicKeyCache();
  mock = createKsefMock();
  jest.spyOn(emailUtil, 'sendProjectTaskAssigned').mockResolvedValue();
  jest.spyOn(ksefApiClient.timing, 'sleep').mockResolvedValue();
  jest.spyOn(global, 'fetch').mockImplementation((url, options) => (
    String(url).startsWith('https://api.nbp.pl') ? Promise.resolve(new Response(null, { status: 404 })) : mock.fetch(url, options)
  ));
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.KSEF_ENVIRONMENT;
});

describe('the KSeF permission', () => {
  test('the tenant admin grants it; it shows in /api/auth/me', async () => {
    const granted = await api('patch', `/api/admin/users/${outsider.id}`, admin).send({ can_view_ksef_invoices: true });
    expect(granted.status).toBe(200);
    expect(granted.body.can_view_ksef_invoices).toBe(true);

    expect((await api('get', '/api/auth/me', outsider)).body.can_view_ksef_invoices).toBe(true);
    expect((await api('get', '/api/ksef/invoices', outsider)).status).toBe(200);
    expect((await api('get', `/api/admin/users/${outsider.id}`, admin)).body.can_view_ksef_invoices).toBe(true);

    await api('patch', `/api/admin/users/${outsider.id}`, admin).send({ can_view_ksef_invoices: false });
    expect((await api('get', '/api/auth/me', outsider)).body.can_view_ksef_invoices).toBe(false);
    expect((await api('get', '/api/ksef/invoices', outsider)).status).toBe(403);
  });

  test('it can be set when the account is created', async () => {
    const created = await api('post', '/api/admin/users', admin).send({
      email: `knew${EMAIL_DOMAIN}`, first_name: 'New', last_name: 'User', can_view_ksef_invoices: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.can_view_ksef_invoices).toBe(true);
  });

  test('a sales manager cannot grant it and an external account cannot hold it', async () => {
    const byManager = await api('patch', `/api/admin/users/${outsider.id}`, salesManager)
      .send({ can_view_ksef_invoices: true, first_name: 'koutsider' });
    expect(byManager.status).toBe(200);
    expect(byManager.body.can_view_ksef_invoices).toBe(false);

    const toExternal = await api('patch', `/api/admin/users/${external.id}`, admin).send({ can_view_ksef_invoices: true });
    expect(toExternal.status).toBe(400);
    expect(toExternal.body.error).toBe('An external account cannot be given access to KSeF invoices');
  });

  test('every KSeF invoice endpoint answers 403 without it — the tenant admin always has it', async () => {
    const invoice = await insertInvoice();
    const calls = (user) => [
      api('get', '/api/ksef/invoices', user),
      api('get', `/api/ksef/invoices/${invoice.id}`, user),
      api('get', '/api/ksef/companies', user),
      api('post', '/api/ksef/sync', user).send({}),
    ];
    jest.spyOn(ksefSyncService, 'syncCompaniesOf').mockResolvedValue([]);

    for (const user of [outsider, plainPm, controller, salesManager, external]) {
      for (const res of await Promise.all(calls(user))) expect(res.status).toBe(403);
    }
    for (const user of [admin, viewer, pm]) {
      expect((await Promise.all(calls(user))).map((res) => res.status)).toEqual([200, 200, 200, 202]);
    }
  });

  test('with project finance switched off KSeF invoices do not exist for anyone', async () => {
    const invoice = await insertInvoice();
    await setFinanceSwitch(false);
    try {
      for (const res of await Promise.all([
        api('get', '/api/ksef/invoices', admin),
        api('get', `/api/ksef/invoices/${invoice.id}`, admin),
        api('get', '/api/ksef/companies', viewer),
        api('post', '/api/ksef/sync', admin).send({}),
        api('get', '/api/admin/ksef', admin),
        api('post', '/api/admin/ksef/companies', admin).send({ nip: BUYER_NIP, token: mock.validToken }),
        api('put', '/api/admin/ksef/settings', admin).send({ initial_sync_days: 10 }),
      ])) {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Project finance is switched off');
      }
    } finally {
      await setFinanceSwitch(true);
    }
  });
});

describe('admin configuration', () => {
  const addCompany = (body, user = admin) => api('post', '/api/admin/ksef/companies', user).send(body);

  test('only the tenant admin reads and changes it', async () => {
    for (const user of [pm, viewer, controller, outsider]) {
      expect((await api('get', '/api/admin/ksef', user)).status).toBe(403);
      expect((await addCompany({ nip: BUYER_NIP, token: mock.validToken }, user)).status).toBe(403);
      expect((await api('put', '/api/admin/ksef/settings', user).send({ initial_sync_days: 10 })).status).toBe(403);
    }
    const config = await api('get', '/api/admin/ksef', admin);
    expect(config.status).toBe(200);
    expect(config.body).toEqual({ is_configured: true, environment: 'test', initial_sync_days: 30, companies: [] });
  });

  test('the first sync reaches back 1 to 365 days, 30 by default', async () => {
    for (const days of [0, 366, 'many', 1.5]) {
      expect((await api('put', '/api/admin/ksef/settings', admin).send({ initial_sync_days: days })).status).toBe(400);
    }
    const saved = await api('put', '/api/admin/ksef/settings', admin).send({ initial_sync_days: 365 });
    expect(saved.status).toBe(200);
    expect(saved.body.initial_sync_days).toBe(365);
    expect((await api('put', '/api/admin/ksef/settings', admin).send({ initial_sync_days: 1 })).body.initial_sync_days).toBe(1);
  });

  test('a company is stored only after KSeF accepted its token; the token is never returned', async () => {
    await api('put', '/api/admin/ksef/settings', admin).send({ initial_sync_days: 60 });

    const created = await addCompany({ nip: 'PL 343-071-45-83', token: `  ${mock.validToken} `, name: ' Spółka A ' });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      nip: BUYER_NIP, name: 'Spółka A', token_hint: 'oken', status: 'active', last_error: null, last_synced_at: null,
    });
    expect(JSON.stringify(created.body)).not.toContain(mock.validToken);
    expect(mock.lastAuthBody.contextIdentifier).toEqual({ type: 'Nip', value: BUYER_NIP });
    const expectedStart = Date.now() - 60 * DAY_MS;
    expect(Math.abs(Date.parse(created.body.sync_from) - expectedStart)).toBeLessThan(60_000);

    const { rows: [stored] } = await db.query('SELECT * FROM ksef_companies WHERE id = $1', [created.body.id]);
    expect(stored.token_encrypted).not.toContain(mock.validToken);
    expect(decrypt(stored.token_encrypted)).toBe(mock.validToken);
    expect(stored.created_by).toBe(admin.id);

    const config = await api('get', '/api/admin/ksef', admin);
    expect(config.body.companies).toHaveLength(1);
    expect(JSON.stringify(config.body)).not.toContain(mock.validToken);
    expect(config.body.companies[0]).not.toHaveProperty('token_encrypted');

    const { rows: auditRows } = await db.query(
      "SELECT after_state, metadata FROM audit_logs WHERE tenant_id = $1 AND metadata->>'area' = 'ksef_company_added'",
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows)).not.toContain(mock.validToken);
  });

  test('several companies per tenant, each NIP once', async () => {
    expect((await addCompany({ nip: BUYER_NIP, token: mock.validToken })).status).toBe(201);
    expect((await addCompany({ nip: SELLER_NIP, token: mock.validToken })).status).toBe(201);

    const duplicate = await addCompany({ nip: '343-071-45-83', token: mock.validToken });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('A company with this NIP is already configured');
    expect((await api('get', '/api/admin/ksef', admin)).body.companies.map((company) => company.nip))
      .toEqual([BUYER_NIP, SELLER_NIP]);
  });

  test('a wrong NIP, a rejected token and an unreachable KSeF store nothing', async () => {
    const badNip = await addCompany({ nip: '1234567890', token: mock.validToken });
    expect(badNip.status).toBe(400);
    expect(badNip.body.error).toBe('Invalid NIP');
    expect(mock.calls).toHaveLength(0);
    expect((await addCompany({ nip: BUYER_NIP })).status).toBe(400);

    const rejected = await addCompany({ nip: BUYER_NIP, token: 'wrong-token' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('KSeF rejected the token for this NIP');

    mock.serverErrorPaths.add('/auth/challenge');
    const unreachable = await addCompany({ nip: BUYER_NIP, token: mock.validToken });
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error).toBe('KSeF could not be reached to verify the token; try again later');

    expect((await api('get', '/api/admin/ksef', admin)).body.companies).toEqual([]);
  });

  test('without KSEF_ENVIRONMENT the screen says so and no token can be saved', async () => {
    delete process.env.KSEF_ENVIRONMENT;

    expect((await api('get', '/api/admin/ksef', admin)).body).toMatchObject({ is_configured: false, environment: null });
    const res = await addCompany({ nip: BUYER_NIP, token: mock.validToken });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KSeF integration is not configured');
    expect((await api('post', '/api/ksef/sync', admin).send({})).status).toBe(400);
  });

  test('replacing the token re-activates an invalid company; a rejected replacement changes nothing', async () => {
    const company = await insertCompany({ status: 'invalid', lastError: 'Token revoked' });
    const url = `/api/admin/ksef/companies/${company.id}`;

    const rejected = await api('patch', url, admin).send({ token: 'another-wrong-token' });
    expect(rejected.status).toBe(400);
    const { rows: [untouched] } = await db.query('SELECT * FROM ksef_companies WHERE id = $1', [company.id]);
    expect(untouched).toMatchObject({ status: 'invalid', token_hint: 'oken', token_encrypted: 'not-a-real-ciphertext' });

    mock.validToken = 'replacement-token-WXYZ';
    const replaced = await api('patch', url, admin).send({ token: mock.validToken, name: 'Nowa nazwa' });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ status: 'active', last_error: null, token_hint: 'WXYZ', name: 'Nowa nazwa' });
    expect(Date.parse(replaced.body.sync_from)).toBe(company.sync_from.getTime());

    expect((await api('patch', `/api/admin/ksef/companies/${admin.id}`, admin).send({ name: 'x' })).status).toBe(404);
  });

  test('removing a company keeps the invoices already synced', async () => {
    const company = await insertCompany();
    const invoice = await insertInvoice({ company_id: company.id });
    const foreign = await insertCompany({ tenantId: otherTenantId });

    expect((await api('delete', `/api/admin/ksef/companies/${foreign.id}`, admin)).status).toBe(404);
    expect((await api('delete', `/api/admin/ksef/companies/${company.id}`, admin)).status).toBe(204);

    expect((await api('get', '/api/admin/ksef', admin)).body.companies).toEqual([]);
    const kept = await getInvoice(invoice);
    expect(kept).toMatchObject({ id: invoice.id, company_id: null });
    expect((await api('get', '/api/ksef/invoices', viewer)).body.total).toBe(1);
  });
});

describe('invoice list', () => {
  const list = async (queryString = '', user = viewer) => (await api('get', `/api/ksef/invoices${queryString}`, user)).body;
  const numbers = (body) => body.items.map((item) => item.invoice_number);

  test('covers the last 30 days by default, newest first, with the agreed fields', async () => {
    const recent = await insertInvoice({ invoice_number: 'RECENT', issue_date: isoDaysAgo(2), payment_due_date: '2026-12-01' });
    await insertInvoice({ invoice_number: 'OLDER', issue_date: isoDaysAgo(20) });
    await insertInvoice({ invoice_number: 'TOO-OLD', issue_date: isoDaysAgo(45) });
    await insertInvoice({ invoice_number: 'FOREIGN-TENANT', tenant_id: otherTenantId });
    await link(recent, { amount: 10 });

    const body = await list();

    expect(body).toMatchObject({ total: 2, page: 1, page_size: 50, date_from: isoDaysAgo(30), date_to: isoDaysAgo(0) });
    expect(numbers(body)).toEqual(['RECENT', 'OLDER']);
    expect(body.items[0]).toEqual({
      id: recent.id,
      invoice_number: 'RECENT',
      ksef_number: recent.ksef_number,
      issue_date: isoDaysAgo(2),
      seller_name: 'Hotel Pod Lipami Sp. z o.o.',
      seller_nip: SELLER_NIP,
      buyer_nip: BUYER_NIP,
      net_amount: 1000,
      vat_amount: 230,
      gross_amount: 1230,
      currency: 'PLN',
      payment_due_date: '2026-12-01',
      links_count: 1,
    });
    expect(body.items[1].links_count).toBe(0);
  });

  test('an explicit period is inclusive on both ends', async () => {
    await insertInvoice({ invoice_number: 'A', issue_date: '2025-03-01' });
    await insertInvoice({ invoice_number: 'B', issue_date: '2025-03-15' });
    await insertInvoice({ invoice_number: 'C', issue_date: '2025-03-31' });
    await insertInvoice({ invoice_number: 'D', issue_date: '2025-04-01' });

    expect(numbers(await list('?date_from=2025-03-01&date_to=2025-03-31'))).toEqual(['C', 'B', 'A']);
    expect(numbers(await list('?date_from=2025-03-16&date_to=2025-04-30'))).toEqual(['D', 'C']);
    // Only the end given: the 30 days before it.
    expect(await list('?date_to=2025-03-31')).toMatchObject({ date_from: '2025-03-01', total: 3 });
  });

  test('filters by seller name or NIP, invoice number and amount ranges', async () => {
    await insertInvoice({ invoice_number: 'FV/HOTEL/1', net_amount: 100, gross_amount: 123 });
    await insertInvoice({
      invoice_number: 'FV/TAXI/7', seller_name: 'Taxi 100% Sp. j.', seller_nip: '5260250995', net_amount: 500, gross_amount: 540,
    });
    await insertInvoice({ invoice_number: 'R-2026-9', seller_name: 'Biuro_Rachunkowe', seller_nip: '1132191233', net_amount: 900, gross_amount: 1107 });

    expect(numbers(await list('?seller=taxi'))).toEqual(['FV/TAXI/7']);
    expect(numbers(await list('?seller=60250'))).toEqual(['FV/TAXI/7']);
    // LIKE wildcards in the search text are taken literally.
    expect(numbers(await list('?seller=100%25'))).toEqual(['FV/TAXI/7']);
    expect(numbers(await list('?seller=o_R'))).toEqual(['R-2026-9']);
    expect(numbers(await list('?seller=%25'))).toEqual(['FV/TAXI/7']);
    expect(numbers(await list('?invoice_number=fv/'))).toHaveLength(2);
    expect(numbers(await list('?invoice_number=2026'))).toEqual(['R-2026-9']);
    expect(numbers(await list('?net_min=500'))).toHaveLength(2);
    expect(numbers(await list('?net_min=100.01&net_max=500'))).toEqual(['FV/TAXI/7']);
    expect(numbers(await list('?gross_max=123'))).toEqual(['FV/HOTEL/1']);
    expect(numbers(await list('?gross_min=541&gross_max=2000'))).toEqual(['R-2026-9']);
    expect(numbers(await list('?seller=hotel&net_min=200'))).toEqual([]);
    expect(numbers(await list(`?buyer_nip=${BUYER_NIP}`))).toHaveLength(3);
    expect(numbers(await list('?buyer_nip=5260250995'))).toEqual([]);
  });

  test('is paginated', async () => {
    for (let day = 1; day <= 5; day += 1) await insertInvoice({ invoice_number: `P${day}`, issue_date: isoDaysAgo(day) });

    const first = await list('?page_size=2');
    expect(first).toMatchObject({ total: 5, page: 1, page_size: 2 });
    expect(numbers(first)).toEqual(['P1', 'P2']);
    expect(numbers(await list('?page_size=2&page=3'))).toEqual(['P5']);
    expect(numbers(await list('?page_size=2&page=4'))).toEqual([]);
  });

  test('rejects malformed filters', async () => {
    for (const queryString of ['?date_from=01.03.2025', '?date_to=2025-13-01', '?net_min=abc', '?page=0', '?page_size=201']) {
      expect((await api('get', `/api/ksef/invoices${queryString}`, viewer)).status).toBe(400);
    }
  });
});

describe('invoice detail', () => {
  test('returns everything parsed and the links', async () => {
    const invoice = await insertInvoice({
      invoice_type: 'Vat',
      sale_date: '2026-09-12',
      seller_address: 'ul. Lipowa 12, 00-950 Warszawa',
      buyer_name: 'Nabywca Sp. z o.o.',
      buyer_address: 'ul. Testowa 1, 00-001 Warszawa',
      payment_due_date: '2026-10-14',
      bank_account: '00123456789012345678901234',
      is_paid: true,
      payment_date: '2026-10-01',
      amount_due: 1230,
      payment: JSON.stringify({ form: '6', due_dates: ['2026-10-14'], bank_accounts: [], is_partially_paid: false }),
      lines: JSON.stringify([{ number: 1, name: 'Nocleg', net_amount: 1000 }]),
      raw_xml: '<Faktura/>',
    });
    const task = await createTask('Wyjazd');
    await link(invoice, { task_id: task.id, amount: 400 });

    const res = await api('get', `/api/ksef/invoices/${invoice.id}`, viewer);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: invoice.id,
      invoice_type: 'Vat',
      sale_date: '2026-09-12',
      seller_address: 'ul. Lipowa 12, 00-950 Warszawa',
      buyer_name: 'Nabywca Sp. z o.o.',
      buyer_address: 'ul. Testowa 1, 00-001 Warszawa',
      payment_due_date: '2026-10-14',
      bank_account: '00123456789012345678901234',
      is_paid: true,
      payment_date: '2026-10-01',
      amount_due: 1230,
      payment: { form: '6', due_dates: ['2026-10-14'] },
      lines: [{ number: 1, name: 'Nocleg', net_amount: 1000 }],
      has_xml: true,
      links_count: 1,
      linked_total: 400,
      is_over_allocated: false,
    });
    expect(res.body).not.toHaveProperty('raw_xml');
    expect(res.body.links).toEqual([{
      cost_item_id: expect.any(String),
      project_id: project.id,
      project_key: project.key,
      project_name: 'Projekt KSeF',
      task_id: task.id,
      task_number: task.task_number,
      task_name: 'Wyjazd',
      amount: 400,
      currency: 'PLN',
      status: 'incurred',
      linked_by: pm.id,
      linked_by_name: pm.display_name,
      linked_at: expect.any(String),
    }]);
  });

  test('an unknown invoice and another tenant\'s invoice are not found', async () => {
    const foreign = await insertInvoice({ tenant_id: otherTenantId });
    expect((await api('get', `/api/ksef/invoices/${foreign.id}`, viewer)).status).toBe(404);
    expect((await api('get', `/api/ksef/invoices/${admin.id}`, viewer)).status).toBe(404);
    expect((await api('get', '/api/ksef/invoices/not-a-uuid', viewer)).status).toBe(400);
  });
});

describe('companies and "sync now" for invoice users', () => {
  test('the sync state is visible without any token data', async () => {
    const company = await insertCompany({ status: 'error', lastError: 'KSeF answered 500' });

    const res = await api('get', '/api/ksef/companies', viewer);

    expect(res.body).toEqual({
      is_configured: true,
      companies: [{ id: company.id, nip: BUYER_NIP, name: null, status: 'error', last_attempt_at: null, last_synced_at: null }],
    });
  });

  test('"sync now" starts a background sync of the tenant, or of one company', async () => {
    const sync = jest.spyOn(ksefSyncService, 'syncCompaniesOf').mockResolvedValue([]);
    const company = await insertCompany();

    const all = await api('post', '/api/ksef/sync', viewer).send({});
    expect(all.status).toBe(202);
    expect(all.body).toEqual({ status: 'started' });
    expect(sync).toHaveBeenLastCalledWith({ tenantId, companyId: null });

    expect((await api('post', '/api/ksef/sync', viewer).send({ company_id: company.id })).status).toBe(202);
    expect(sync).toHaveBeenLastCalledWith({ tenantId, companyId: company.id });
    expect((await api('post', '/api/ksef/sync', viewer).send({ company_id: 'nope' })).status).toBe(400);
  });

  test('a failing background sync does not break the request', async () => {
    jest.spyOn(ksefSyncService, 'syncCompaniesOf').mockRejectedValue(new Error('boom'));
    expect((await api('post', '/api/ksef/sync', admin).send({})).status).toBe(202);
  });
});

describe('creating a cost item from an invoice', () => {
  test('defaults: the whole net amount, the issue date, supplier and document number from the invoice', async () => {
    const invoice = await insertInvoice({ issue_date: '2026-09-14', invoice_number: 'FV/2026/09/77' });

    const res = await api('post', financeUrl('/costs'), pm).send(linkBody(invoice));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      date: '2026-09-14',
      amount: 1000,
      status: 'incurred',
      category_id: categoryId,
      task_id: null,
      supplier_name: 'Hotel Pod Lipami Sp. z o.o.',
      document_number: 'FV/2026/09/77',
      original_amount: null,
      original_currency: null,
      exchange_rate: null,
      ksef_invoice_id: invoice.id,
      other_links: [],
    });
    expect(res.body.ksef_invoice).toEqual({
      id: invoice.id,
      invoice_number: 'FV/2026/09/77',
      ksef_number: invoice.ksef_number,
      issue_date: '2026-09-14',
      seller_name: 'Hotel Pod Lipami Sp. z o.o.',
      seller_nip: SELLER_NIP,
      buyer_nip: BUYER_NIP,
      net_amount: 1000,
      vat_amount: 230,
      gross_amount: 1230,
      currency: 'PLN',
      payment_due_date: null,
      links_count: 1,
      linked_total: 1000,
      is_over_allocated: false,
    });
  });

  test('everything can be overridden: amount, date, task, status, supplier, document number', async () => {
    const invoice = await insertInvoice();
    const task = await createTask();

    const cost = await link(invoice, {
      amount: 250.5, date: '2026-08-01', task_id: task.id, status: 'planned',
      supplier_name: 'Inna nazwa', document_number: 'WEWN/1', description: 'Część faktury',
    });

    expect(cost).toMatchObject({
      amount: 250.5, date: '2026-08-01', task_id: task.id, task_number: task.task_number, status: 'planned',
      supplier_name: 'Inna nazwa', document_number: 'WEWN/1', description: 'Część faktury',
    });
    expect(cost.ksef_invoice).toMatchObject({ linked_total: 250.5, is_over_allocated: false });
  });

  test('long invoice texts are cut to what a cost item holds', async () => {
    const invoice = await insertInvoice({ seller_name: 'S'.repeat(300), invoice_number: 'N'.repeat(200) });
    const cost = await link(invoice);
    expect(cost.supplier_name).toHaveLength(200);
    expect(cost.document_number).toHaveLength(100);
  });

  test('a category is required, and so is a date when there is no invoice', async () => {
    const invoice = await insertInvoice();
    expect((await api('post', financeUrl('/costs'), pm).send({ ksef_invoice_id: invoice.id })).status).toBe(400);

    const withoutDate = await api('post', financeUrl('/costs'), pm).send({ amount: 10, category_id: categoryId });
    expect(withoutDate.status).toBe(400);
    expect(withoutDate.body.error).toBe('The date is required');
  });

  test('an unknown invoice, another tenant\'s invoice and an invoice without a net amount', async () => {
    const foreign = await insertInvoice({ tenant_id: otherTenantId });
    for (const invoiceId of [foreign.id, admin.id]) {
      const res = await api('post', financeUrl('/costs'), pm).send(linkBody({ id: invoiceId }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Unknown KSeF invoice');
    }
    expect((await api('post', financeUrl('/costs'), pm).send(linkBody({ id: 'nope' }))).status).toBe(400);

    const zero = await insertInvoice({ net_amount: 0 });
    const withoutAmount = await api('post', financeUrl('/costs'), pm).send(linkBody(zero));
    expect(withoutAmount.status).toBe(400);
    expect(withoutAmount.body.error).toBe('The invoice has no positive net amount; provide the amount');
    expect((await api('post', financeUrl('/costs'), pm).send(linkBody(zero, { amount: 5 }))).status).toBe(201);
  });

  describe('invoice in another currency than the project', () => {
    // 1999-03-06 and 07 are a weekend, so the business day before the 8th is the 5th.
    beforeEach(() => storeRates([
      ['EUR', '1999-03-05', 4.10], ['USD', '1999-03-05', 3.60], ['EUR', '1999-03-08', 4.20], ['EUR', '1999-06-14', 4.50],
    ]));
    const euroInvoice = (overrides = {}) => insertInvoice({
      currency: 'EUR', issue_date: '1999-03-08', net_amount: 162.6, gross_amount: 200, vat_amount: 37.4, ...overrides,
    });

    test('the default amount uses the NBP rate of the business day before the ISSUE date', async () => {
      const invoice = await euroInvoice();

      // The cost date differs from the issue date on purpose: it must not pick the rate.
      const cost = await link(invoice, { date: '1999-06-15' });

      expect(cost).toMatchObject({
        date: '1999-06-15',
        amount: 666.66,
        original_amount: 162.6,
        original_currency: 'EUR',
        exchange_rate: 4.1,
        exchange_rate_date: '1999-03-05',
      });
      expect(cost.ksef_invoice).toMatchObject({ currency: 'EUR', linked_total: 162.6, is_over_allocated: false });
    });

    test('an explicit amount wins and no rate is stored', async () => {
      const cost = await link(await euroInvoice(), { amount: 700 });

      expect(cost).toMatchObject({
        amount: 700, original_amount: null, original_currency: null, exchange_rate: null, exchange_rate_date: null,
      });
      // 700 PLN back at 4.10 is 170.73 EUR — more than the 162.60 net.
      expect(cost.ksef_invoice).toMatchObject({ linked_total: 170.73, is_over_allocated: true });
    });

    test('a part of the invoice given in its own currency is converted the same way', async () => {
      const cost = await link(await euroInvoice(), { original_amount: 100, original_currency: 'EUR', date: '1999-06-15' });

      expect(cost).toMatchObject({ amount: 410, original_amount: 100, exchange_rate: 4.1, exchange_rate_date: '1999-03-05' });
      expect(cost.ksef_invoice.linked_total).toBe(100);
    });

    test('a foreign project converts through PLN', async () => {
      await api('patch', financeUrl('', euroProject), pm).send({ currency: 'USD' });
      const invoice = await euroInvoice();

      const cost = await link(invoice, {}, { target: euroProject });

      expect(cost).toMatchObject({ amount: 185.18, original_amount: 162.6, original_currency: 'EUR', exchange_rate: 1.13888889 });
    });

    test('without a rate nothing is guessed', async () => {
      const invoice = await euroInvoice({ issue_date: '1999-01-20' });

      const res = await api('post', financeUrl('/costs'), pm).send(linkBody(invoice));

      expect(res.status).toBe(422);
      expect((await getInvoice(invoice)).links_count).toBe(0);
    });

    test('a link without a usable rate leaves linked_total unknown instead of wrong', async () => {
      const invoice = await euroInvoice({ issue_date: '1999-01-20' });
      await link(invoice, { amount: 100 });

      expect(await getInvoice(invoice)).toMatchObject({ links_count: 1, linked_total: null, is_over_allocated: null });
    });
  });
});

describe('one invoice, many links', () => {
  test('linking is never blocked: several tasks, several projects, even twice the same one', async () => {
    const invoice = await insertInvoice();
    const task = await createTask('Etap 1');
    const otherTask = await createTask('Etap 2');

    const first = await link(invoice, { task_id: task.id, amount: 600 });
    const second = await link(invoice, { task_id: task.id, amount: 300 });
    const third = await link(invoice, { task_id: otherTask.id, amount: 100 });
    const fourth = await link(invoice, { amount: 50 }, { target: euroProject });

    expect(first.other_links).toEqual([]);
    expect(first.ksef_invoice).toMatchObject({ links_count: 1, linked_total: 600, is_over_allocated: false });
    expect(second.other_links.map((other) => other.cost_item_id)).toEqual([first.id]);
    expect(third.ksef_invoice).toMatchObject({ links_count: 3, linked_total: 1000, is_over_allocated: false });
    // The fourth link pushes the total over the net amount — reported, not refused.
    expect(fourth.ksef_invoice).toMatchObject({ links_count: 4, linked_total: 1050, is_over_allocated: true });
    expect(fourth.other_links).toEqual([
      expect.objectContaining({
        cost_item_id: first.id, project_key: project.key, project_name: 'Projekt KSeF',
        task_number: task.task_number, task_name: 'Etap 1', amount: 600, currency: 'PLN',
      }),
      expect.objectContaining({ cost_item_id: second.id, task_name: 'Etap 1', amount: 300 }),
      expect.objectContaining({ cost_item_id: third.id, task_name: 'Etap 2', amount: 100 }),
    ]);

    const { body: costs } = await api('get', financeUrl('/costs'), pm);
    const listed = costs.find((cost) => cost.id === first.id);
    expect(listed.ksef_invoice).toMatchObject({ links_count: 4, linked_total: 1050, is_over_allocated: true });
    expect(listed.other_links).toHaveLength(3);
    expect(listed.other_links.at(-1)).toMatchObject({
      project_key: euroProject.key, project_name: 'Projekt Euro', task_id: null, task_number: null, task_name: null, amount: 50,
    });

    const { body: taskCosts } = await api('get', financeUrl(`/costs?task_id=${task.id}`), pm);
    expect(taskCosts.map((cost) => cost.id).sort()).toEqual([first.id, second.id].sort());
    expect(taskCosts.every((cost) => cost.other_links.length === 3 && cost.ksef_invoice.is_over_allocated)).toBe(true);

    expect(await getInvoice(invoice)).toMatchObject({ links_count: 4, linked_total: 1050, is_over_allocated: true });
    expect((await api('get', '/api/ksef/invoices', viewer)).body.items[0].links_count).toBe(4);
  });

  test('links exactly equal to the net amount are not an over-allocation', async () => {
    const invoice = await insertInvoice({ net_amount: 0.3 });
    await link(invoice, { amount: 0.1 });
    await link(invoice, { amount: 0.2 });
    expect(await getInvoice(invoice)).toMatchObject({ linked_total: 0.3, is_over_allocated: false });
  });

  test('linked_total is in the invoice currency: links in other currencies are converted at the issue date', async () => {
    await storeRates([['EUR', '1999-03-05', 4.00], ['USD', '1999-03-05', 2.00]]);
    await api('patch', financeUrl('', euroProject), pm).send({ currency: 'EUR' });
    const invoice = await insertInvoice({ issue_date: '1999-03-08', net_amount: 1000 });

    await link(invoice, { amount: 400 });
    // 100 EUR at 4.00 on the business day before the issue date = 400 PLN.
    await link(invoice, { amount: 100 }, { target: euroProject });
    // Entered in the invoice currency: counts with what was entered, not with the rounded conversion.
    const third = await link(invoice, { original_amount: 333.33, original_currency: 'PLN' }, { target: euroProject });

    expect(third).toMatchObject({ amount: 83.33, original_amount: 333.33, original_currency: 'PLN' });
    expect(third.ksef_invoice).toMatchObject({ linked_total: 1133.33, is_over_allocated: true });
    expect(third.other_links.map((other) => [other.amount, other.currency])).toEqual([[400, 'PLN'], [100, 'EUR']]);
  });

  test('plain cost items carry empty invoice fields and count nowhere', async () => {
    const invoice = await insertInvoice();
    await link(invoice, { amount: 100 });
    const plain = await addPlainCost();

    expect(plain).toMatchObject({ ksef_invoice_id: null, ksef_invoice: null, other_links: [] });
    const { body: costs } = await api('get', financeUrl('/costs'), pm);
    expect(costs.find((cost) => cost.id === plain.id)).toMatchObject({ ksef_invoice: null, other_links: [] });
    expect((await getInvoice(invoice)).links_count).toBe(1);
  });
});

describe('who may link and who sees the links', () => {
  test('linking needs finance write access AND the KSeF permission', async () => {
    const invoice = await insertInvoice();
    await api('patch', financeUrl(), pm).send({ participants_can_add_costs: true });
    const task = await createTask();
    await api('patch', `/api/projects/${project.id}/tasks/${task.id}`, pm).send({ assignee_ids: [worker.id] });

    const denied = 'Linking KSeF invoices requires the KSeF invoices permission and write access to the project finance';
    // A PM without the permission; a participant who may add costs to own tasks (even holding the permission).
    for (const [user, overrides] of [[plainPm, {}], [worker, { task_id: task.id }]]) {
      const res = await api('post', financeUrl('/costs'), user).send(linkBody(invoice, overrides));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(denied);
    }
    // No write access at all: refused before KSeF is even looked at.
    for (const user of [controller, viewer, external]) {
      expect([403, 404]).toContain((await api('post', financeUrl('/costs'), user).send(linkBody(invoice))).status);
    }
    expect((await getInvoice(invoice)).links_count).toBe(0);

    expect((await api('post', financeUrl('/costs'), pm).send(linkBody(invoice))).status).toBe(201);
    expect((await api('post', financeUrl('/costs'), admin).send(linkBody(invoice))).status).toBe(201);
  });

  test('everyone who reads the project finance sees the invoice and its other links, permission or not', async () => {
    const invoice = await insertInvoice();
    await link(invoice, { amount: 100 });
    await link(invoice, { amount: 50 }, { target: euroProject });

    for (const user of [controller, plainPm, admin]) {
      const { body: [cost] } = await api('get', financeUrl('/costs'), user);
      expect(cost.ksef_invoice).toMatchObject({ id: invoice.id, links_count: 2, linked_total: 150 });
      expect(cost.other_links).toEqual([expect.objectContaining({ project_key: euroProject.key, amount: 50 })]);
    }
  });

  test('a participant who only sees own cost items gets no invoice data', async () => {
    const invoice = await insertInvoice();
    await api('patch', financeUrl(), pm).send({ participants_can_add_costs: true });
    const task = await createTask();
    await api('patch', `/api/projects/${project.id}/tasks/${task.id}`, pm).send({ assignee_ids: [worker.id] });
    const own = await addPlainCost({ task_id: task.id }, worker);
    await link(invoice, { amount: 100 });
    expect((await api('patch', financeUrl(`/costs/${own.id}`), pm).send({ ksef_invoice_id: invoice.id })).status).toBe(200);

    const { body: costs } = await api('get', financeUrl('/costs'), worker);

    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ id: own.id, ksef_invoice_id: invoice.id, ksef_invoice: null, other_links: [] });

    // Still their own item to edit — but the link is not theirs to change.
    expect((await api('patch', financeUrl(`/costs/${own.id}`), worker).send({ description: 'Opis' })).status).toBe(200);
    expect((await api('patch', financeUrl(`/costs/${own.id}`), worker).send({ ksef_invoice_id: null })).status).toBe(403);
  });
});

describe('attaching and detaching', () => {
  test('a plain cost item is attached to an invoice afterwards and detached again', async () => {
    const invoice = await insertInvoice();
    const plain = await addPlainCost({ amount: 123.45, supplier_name: 'Wpisany ręcznie' });
    const url = financeUrl(`/costs/${plain.id}`);

    const attached = await api('patch', url, pm).send({ ksef_invoice_id: invoice.id });

    expect(attached.status).toBe(200);
    // Attaching changes nothing else on the item.
    expect(attached.body).toMatchObject({
      amount: 123.45, date: '2026-09-15', supplier_name: 'Wpisany ręcznie', document_number: null, ksef_invoice_id: invoice.id,
    });
    expect(attached.body.ksef_invoice).toMatchObject({ id: invoice.id, links_count: 1, linked_total: 123.45 });
    expect((await getInvoice(invoice)).links[0]).toMatchObject({ cost_item_id: plain.id, linked_by: pm.id });

    const detached = await api('patch', url, admin).send({ ksef_invoice_id: null });

    expect(detached.status).toBe(200);
    expect(detached.body).toMatchObject({ amount: 123.45, ksef_invoice_id: null, ksef_invoice: null, other_links: [] });
    expect(await getInvoice(invoice)).toMatchObject({ links_count: 0, linked_total: 0, links: [] });
    const { rows: [row] } = await db.query(
      'SELECT ksef_linked_by, ksef_linked_at FROM project_cost_items WHERE id = $1', [plain.id],
    );
    expect(row).toEqual({ ksef_linked_by: null, ksef_linked_at: null });
  });

  test('moving a link to another invoice records who did it', async () => {
    const [first, second] = [await insertInvoice(), await insertInvoice()];
    const cost = await link(first, { amount: 10 });

    const moved = await api('patch', financeUrl(`/costs/${cost.id}`), admin).send({ ksef_invoice_id: second.id });

    expect(moved.body.ksef_invoice.id).toBe(second.id);
    expect((await getInvoice(first)).links_count).toBe(0);
    expect((await getInvoice(second)).links[0]).toMatchObject({ linked_by: admin.id, linked_by_name: admin.display_name });
  });

  test('without the KSeF permission the link cannot be changed, the rest of the item can', async () => {
    const [invoice, other] = [await insertInvoice(), await insertInvoice()];
    const cost = await link(invoice, { amount: 10 });
    const url = financeUrl(`/costs/${cost.id}`);

    for (const body of [{ ksef_invoice_id: null }, { ksef_invoice_id: other.id }]) {
      expect((await api('patch', url, plainPm).send(body)).status).toBe(403);
    }
    const edited = await api('patch', url, plainPm).send({ amount: 20, ksef_invoice_id: invoice.id });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ amount: 20, ksef_invoice_id: invoice.id });
    expect(edited.body.ksef_invoice.linked_total).toBe(20);

    const foreign = await insertInvoice({ tenant_id: otherTenantId });
    expect((await api('patch', url, pm).send({ ksef_invoice_id: foreign.id })).status).toBe(400);
  });

  test('re-entering a foreign amount on a linked item keeps using the issue date rate', async () => {
    await storeRates([['EUR', '1999-03-05', 4.10], ['EUR', '1999-06-14', 4.50]]);
    const invoice = await insertInvoice({ currency: 'EUR', issue_date: '1999-03-08', net_amount: 100 });
    const cost = await link(invoice, { date: '1999-06-15' });

    const res = await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ original_amount: 50 });

    expect(res.body).toMatchObject({ amount: 205, original_amount: 50, exchange_rate: 4.1, exchange_rate_date: '1999-03-05' });
  });

  test('deleting a cost item removes the link, never the invoice', async () => {
    const invoice = await insertInvoice();
    const cost = await link(invoice);
    await link(invoice, { amount: 1 });

    expect((await api('delete', financeUrl(`/costs/${cost.id}`), plainPm)).status).toBe(204);

    expect(await getInvoice(invoice)).toMatchObject({ links_count: 1, linked_total: 1 });
  });

  test('link and unlink are in the audit log with the other cost changes', async () => {
    const invoice = await insertInvoice();
    const created = await link(invoice, { amount: 10 });
    const plain = await addPlainCost();
    await api('patch', financeUrl(`/costs/${plain.id}`), pm).send({ ksef_invoice_id: invoice.id });
    await api('patch', financeUrl(`/costs/${plain.id}`), pm).send({ ksef_invoice_id: null });
    await api('delete', financeUrl(`/costs/${created.id}`), pm);

    const { rows } = await db.query(
      `SELECT action, before_state, after_state, metadata->>'cost_item_id' AS cost_item_id FROM audit_logs
       WHERE tenant_id = $1 AND metadata->>'cost_item_id' = ANY($2::text[]) ORDER BY created_at`,
      [tenantId, [created.id, plain.id]],
    );
    const entriesOf = (costItemId) => rows.filter((row) => row.cost_item_id === costItemId);

    expect(entriesOf(created.id).map((row) => row.action)).toEqual(['project_cost_created', 'project_cost_deleted']);
    expect(entriesOf(created.id)[0].after_state.ksef_invoice_id).toBe(invoice.id);
    expect(entriesOf(created.id)[1].before_state.ksef_invoice_id).toBe(invoice.id);
    expect(entriesOf(plain.id).slice(1)).toEqual([
      expect.objectContaining({
        action: 'project_cost_updated', before_state: { ksef_invoice_id: null }, after_state: { ksef_invoice_id: invoice.id },
      }),
      expect.objectContaining({
        action: 'project_cost_updated', before_state: { ksef_invoice_id: invoice.id }, after_state: { ksef_invoice_id: null },
      }),
    ]);
  });
});

describe('closed project and switched-off finance', () => {
  test('a closed project is read-only: no linking, attaching or detaching — the links stay visible', async () => {
    const invoice = await insertInvoice();
    const linked = await link(invoice, { amount: 10 });
    const plain = await addPlainCost();
    await api('post', `/api/projects/${project.id}/close`, pm);

    expect((await api('post', financeUrl('/costs'), pm).send(linkBody(invoice))).status).toBe(409);
    expect((await api('patch', financeUrl(`/costs/${plain.id}`), pm).send({ ksef_invoice_id: invoice.id })).status).toBe(409);
    expect((await api('patch', financeUrl(`/costs/${linked.id}`), pm).send({ ksef_invoice_id: null })).status).toBe(409);
    expect((await api('delete', financeUrl(`/costs/${linked.id}`), admin)).status).toBe(409);

    const { body: costs } = await api('get', financeUrl('/costs'), controller);
    expect(costs.find((cost) => cost.id === linked.id).ksef_invoice).toMatchObject({ id: invoice.id, links_count: 1 });
    // The invoice can still be linked in another, open project.
    expect((await api('post', financeUrl('/costs', euroProject), pm).send(linkBody(invoice))).status).toBe(201);
  });

  test('with finance switched off there is no linking; switching it back on shows the links again', async () => {
    const invoice = await insertInvoice();
    const linked = await link(invoice, { amount: 10 });
    await setFinanceSwitch(false);
    try {
      expect((await api('post', financeUrl('/costs'), pm).send(linkBody(invoice))).status).toBe(403);
      expect((await api('patch', financeUrl(`/costs/${linked.id}`), pm).send({ ksef_invoice_id: null })).status).toBe(403);
      expect((await api('get', financeUrl('/costs'), pm)).status).toBe(403);
    } finally {
      await setFinanceSwitch(true);
    }
    expect((await getInvoice(invoice)).links_count).toBe(1);
  });
});
