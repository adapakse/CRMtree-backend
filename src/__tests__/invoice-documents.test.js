'use strict';

// Invoices in the Documents module over HTTP — documents of type "invoice"
// entered by hand, the payment-status dictionary, the derived overdue flag,
// registering KSeF invoices as documents (explicitly and when they are linked
// to a cost item), linking invoice documents to project cost items, and the
// project links shown on the document.
//
// Multi-tenant: everything is created under one dedicated test tenant (plus a
// second one for isolation checks) and cleaned up by tenant_id. Blob storage
// is replaced by an in-memory stand-in; the PDF itself is covered by
// invoiceVisualisationPdf.test.js.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const storage   = require('../services/storageService');
const invoiceVisualisationPdfService = require('../services/invoiceVisualisationPdfService');
const { signAccessToken } = require('../middleware/auth');

const SLUG         = 'zz-invoice-documents-test';
const OTHER_SLUG   = 'zz-invoice-documents-test-other';
const EMAIL_DOMAIN = '@invoice-documents-test.crmtree.local';
const BUYER_NIP    = '3430714583';
const SELLER_NIP   = '8976607794';
const DAY_MS       = 86_400_000;
const UPLOADED_PDF = Buffer.from('%PDF-1.4\n% a scanned invoice\n%%EOF\n');
const GROUP_NOT_CONFIGURED =
  'No access group for invoice documents is configured; the tenant admin chooses it in the KSeF settings';
const DOCUMENT_LINKING_DENIED =
  'Linking an invoice document requires write access to the project finance and access to the document';
const KSEF_LINKING_DENIED =
  'Linking KSeF invoices requires the KSeF invoices permission and write access to the project finance';

let tenantId, otherTenantId;
let admin, pm, plainPm, strangerPm, controller, worker, accountant, outsider;
let invoiceGroup, otherGroup, inactiveGroup, foreignGroup;
let project, secondProject, categoryId;
let uploads;
let invoiceSequence = 0;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);
const financeUrl = (suffix = '', target = project) => `/api/projects/${target.id}/finance${suffix}`;
const isoDaysFromNow = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

async function mkUser(local, flags = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id, can_create_projects,
                        can_view_ksef_invoices)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5, $6) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, Boolean(flags.isAdmin), tenantId, Boolean(flags.canCreate),
     Boolean(flags.canViewKsef)],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

async function mkGroup(name, { tenant = tenantId, isActive = true } = {}) {
  const { rows: [group] } = await db.query(
    `INSERT INTO group_profiles (name, display_name, tenant_id, is_active) VALUES ($1, $1, $2, $3)
     RETURNING id, name, display_name`,
    [name, tenant, isActive],
  );
  return group;
}

const grant = (user, group, accessLevel) => db.query(
  'INSERT INTO user_group_roles (user_id, group_id, access_level, tenant_id) VALUES ($1, $2, $3, $4)',
  [user.id, group.id, accessLevel, tenantId],
);

async function insertKsefInvoice(overrides = {}) {
  invoiceSequence += 1;
  const invoice = {
    tenant_id: tenantId,
    ksef_number: `${SELLER_NIP}-20261003-CCCC${String(invoiceSequence).padStart(8, '0')}-D1`,
    invoice_number: `FV/${invoiceSequence}`,
    issue_date: '2026-09-14',
    sale_date: '2026-09-13',
    seller_nip: SELLER_NIP,
    seller_name: 'Hotel Pod Lipami Sp. z o.o.',
    seller_address: 'ul. Lipowa 1, 00-001 Warszawa',
    buyer_nip: BUYER_NIP,
    buyer_name: 'Nasza Firma Sp. z o.o.',
    net_amount: 1000,
    vat_amount: 230,
    gross_amount: 1230,
    currency: 'PLN',
    payment_due_date: '2026-09-28',
    bank_account: '73111111111111111111111111',
    payment: JSON.stringify({ due_dates: ['2026-09-28', '2026-10-28'], form: '6', bank_accounts: [], is_partially_paid: false }),
    lines: JSON.stringify([{ number: 1, name: 'Nocleg', unit: 'szt.', quantity: 2, unit_net_price: 500, net_amount: 1000, vat_rate: '23' }]),
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

const invoiceForm = (overrides = {}) => ({
  name: 'Faktura od dostawcy zagranicznego',
  doc_type: 'invoice',
  gdpr_type: 'no_gdpr',
  group_id: invoiceGroup.id,
  'entities[]': ['Nasza Firma Sp. z o.o.', 'Lieferant GmbH'],
  nip: 'DE811907980',
  invoice_number: 'RE-2026-0042',
  signing_date: '2026-09-10',
  expiration_date: '2026-09-24',
  net_amount: '500.00',
  vat_amount: '95.00',
  gross_amount: '595.00',
  currency: 'EUR',
  bank_account: 'DE89370400440532013000',
  ...overrides,
});

// Documents are created as multipart forms, as the frontend does.
function postDocument(fields, user = pm, { withFile = true } = {}) {
  const req = api('post', '/api/documents', user);
  for (const [key, value] of Object.entries(fields)) {
    for (const item of [].concat(value)) req.field(key, item);
  }
  if (withFile) req.attach('file', UPLOADED_PDF, { filename: 'faktura.pdf', contentType: 'application/pdf' });
  return req;
}

async function createInvoiceDocument(overrides = {}, user = pm) {
  const res = await postDocument(invoiceForm(overrides), user);
  expect(res.status).toBe(201);
  return res.body;
}

const getDocument = async (documentId, user = pm) => (await api('get', `/api/documents/${documentId}`, user)).body;
const register = (invoice, user = pm) => api('post', `/api/ksef/invoices/${invoice.id}/document`, user);
const chooseGroup = (group) =>
  api('put', '/api/admin/ksef/settings', admin).send({ invoice_documents_group_id: group ? group.id : null });
const setFinanceSwitch = (isEnabled) =>
  api('put', '/api/admin/project-config/finance', admin).send({ is_enabled: isEnabled });

async function addCost(body, { user = pm, target = project } = {}) {
  const res = await api('post', financeUrl('/costs', target), user).send({ category_id: categoryId, ...body });
  expect(res.status).toBe(201);
  return res.body;
}

async function createTask(name = 'Zadanie', target = project) {
  const res = await api('post', `/api/projects/${target.id}/tasks`, pm).send({ name });
  expect(res.status).toBe(201);
  return res.body;
}

const documentsOfTenant = async () => (await db.query(
  'SELECT id, ksef_invoice_id, deleted_at FROM documents WHERE tenant_id = $1 ORDER BY created_at', [tenantId],
)).rows;

async function deleteDocuments() {
  await db.query('DELETE FROM documents WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
}

async function cleanup() {
  await db.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]);
  await deleteDocuments();
  await db.query('DELETE FROM doc_number_seq WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  await db.query('DELETE FROM ksef_invoices WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  await db.query('DELETE FROM project_cost_categories WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_statuses WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_types WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_priorities WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM user_group_roles WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM group_profiles WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

beforeAll(async () => {
  const createTenant = async (name, slug) => (await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [name, slug],
  )).rows[0].id;
  tenantId = await createTenant('Invoice Documents Test', SLUG);
  otherTenantId = await createTenant('Invoice Documents Test Other', OTHER_SLUG);
  await db.query(
    `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', TRUE)
     ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE`,
    [tenantId],
  );
  await cleanup();

  admin      = await mkUser('dadmin', { isAdmin: true });
  pm         = await mkUser('dpm', { canCreate: true, canViewKsef: true });
  plainPm    = await mkUser('dplainpm');
  strangerPm = await mkUser('dstrangerpm', { canViewKsef: true });
  controller = await mkUser('dcontroller');
  worker     = await mkUser('dworker', { canViewKsef: true });
  accountant = await mkUser('daccountant', { canViewKsef: true });
  outsider   = await mkUser('doutsider');

  invoiceGroup  = await mkGroup('Faktury');
  otherGroup    = await mkGroup('Umowy');
  inactiveGroup = await mkGroup('Archiwum', { isActive: false });
  foreignGroup  = await mkGroup('Faktury', { tenant: otherTenantId });
  await grant(pm, invoiceGroup, 'full');
  await grant(accountant, invoiceGroup, 'full');
  await grant(plainPm, invoiceGroup, 'read');
  await grant(worker, invoiceGroup, 'read');
  await grant(pm, otherGroup, 'full');

  jest.spyOn(emailUtil, 'sendProjectTaskAssigned').mockResolvedValue();
  project = (await api('post', '/api/projects', pm).send({ name: 'Projekt Faktury' })).body;
  secondProject = (await api('post', '/api/projects', pm).send({ name: 'Projekt Drugi' })).body;
  for (const member of [
    { user_id: plainPm.id,    role: 'pm' },
    { user_id: strangerPm.id, role: 'pm' },
    { user_id: controller.id, role: 'controller' },
    { user_id: worker.id,     role: 'internal_participant', access_level: 'full' },
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
    await db.query(`DELETE FROM ${table} WHERE project_id = ANY($1::uuid[])`, [[project.id, secondProject.id]]);
  }
  await deleteDocuments();
  await db.query('DELETE FROM ksef_invoices WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  await db.query(
    `DELETE FROM app_settings WHERE tenant_id = $1 AND key = ANY($2::text[])`,
    [tenantId, ['ksef_invoice_documents_group_id', 'doc_payment_statuses']],
  );
  await db.query("UPDATE tenants SET default_locale = 'pl' WHERE id = $1", [tenantId]);
  await db.query(
    "UPDATE projects SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = $1", [project.id],
  );

  uploads = [];
  jest.spyOn(emailUtil, 'sendProjectTaskAssigned').mockResolvedValue();
  jest.spyOn(storage, 'uploadDocument').mockImplementation(async (buffer, fileName, mimeType, documentId, version) => {
    uploads.push({ buffer, fileName, mimeType, documentId });
    return { blobPath: `test/${documentId}/v${version}`, blobName: fileName, blobSizeBytes: buffer.length };
  });
  jest.spyOn(storage, 'downloadDocument').mockImplementation(async (blobPath) => ({
    buffer: uploads.find((upload) => blobPath.startsWith(`test/${upload.documentId}/`)).buffer,
    contentType: 'application/pdf',
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('an invoice entered by hand', () => {
  test('is created through the normal document creation, with an uploaded PDF and the invoice fields', async () => {
    const res = await postDocument(invoiceForm({ contract_subject: 'System', payment_status: 'partially_paid' }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      doc_type: 'invoice',
      status: 'new',
      name: 'Faktura od dostawcy zagranicznego',
      entities: ['Nasza Firma Sp. z o.o.', 'Lieferant GmbH'],
      nip: 'DE811907980',
      invoice_number: 'RE-2026-0042',
      signing_date: '2026-09-10',
      expiration_date: '2026-09-24',
      net_amount: 500,
      vat_amount: 95,
      gross_amount: 595,
      currency: 'EUR',
      bank_account: 'DE89370400440532013000',
      payment_status: 'partially_paid',
      contract_subject: null,
      ksef_invoice_id: null,
      owner_id: pm.id,
      group_id: invoiceGroup.id,
      is_payment_overdue: true,
    });
    expect(res.body.doc_number).toMatch(/^DOC-\d{4}-\d{4}$/);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ fileName: 'faktura.pdf', mimeType: 'application/pdf' });

    const detail = await getDocument(res.body.id);
    expect(detail).toMatchObject({ invoice_number: 'RE-2026-0042', net_amount: 500, project_links: [], _access: 'full' });
    expect(detail.versions).toHaveLength(1);

    const preview = await api('get', `/api/documents/${res.body.id}/preview`, plainPm);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toContain('application/pdf');
  });

  test('without them: unpaid, in PLN, every other invoice field empty — and no file is required', async () => {
    const res = await postDocument(
      { name: 'Faktura sprzed KSeF', doc_type: 'invoice', gdpr_type: 'no_gdpr', group_id: invoiceGroup.id },
      pm, { withFile: false },
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      payment_status: 'unpaid',
      currency: 'PLN',
      invoice_number: null,
      net_amount: null,
      vat_amount: null,
      gross_amount: null,
      bank_account: null,
      signing_date: null,
      expiration_date: null,
      is_payment_overdue: false,
    });
    expect(uploads).toHaveLength(0);
  });

  test('rejects an unknown payment status, a malformed currency and amounts that are not amounts', async () => {
    for (const [overrides, error] of [
      [{ payment_status: 'paid_twice' }, 'Unknown payment status'],
      [{ currency: 'XXQ' }, 'Unknown currency code'],
    ]) {
      const res = await postDocument(invoiceForm(overrides));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
    }
    for (const overrides of [{ currency: 'eur' }, { net_amount: '-1' }, { gross_amount: 'dużo' }, { bank_account: 'x'.repeat(65) }]) {
      expect((await postDocument(invoiceForm(overrides))).status).toBe(400);
    }
    expect(await documentsOfTenant()).toHaveLength(0);
  });

  test('is updated like any document; the payment status is set by hand and an empty value clears a field', async () => {
    const document = await createInvoiceDocument();

    const updated = await api('patch', `/api/documents/${document.id}`, pm).send({
      payment_status: 'paid', gross_amount: 600.5, expiration_date: '2026-10-01', bank_account: null,
      contract_subject: 'System',
    });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      payment_status: 'paid', gross_amount: 600.5, net_amount: 500, expiration_date: '2026-10-01',
      bank_account: null, contract_subject: null, is_payment_overdue: false, owner_name: 'dpm Test',
    });

    const rejected = await api('patch', `/api/documents/${document.id}`, pm).send({ payment_status: 'settled' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('Unknown payment status');
    expect((await api('patch', `/api/documents/${document.id}`, pm).send({ currency: 'XXQ' })).status).toBe(400);
    expect((await api('patch', `/api/documents/${document.id}`, plainPm).send({ payment_status: 'unpaid' })).status).toBe(403);
  });

  test('is listed with its invoice fields and found by its invoice number', async () => {
    const document = await createInvoiceDocument();
    await postDocument({ name: 'NDA', doc_type: 'nda', gdpr_type: 'no_gdpr', group_id: invoiceGroup.id }, pm, { withFile: false });

    const { body: all } = await api('get', '/api/documents', pm);
    const { body: invoices } = await api('get', '/api/documents?doc_type=invoice', pm);
    const { body: found } = await api('get', '/api/documents?search=RE-2026-00', pm);

    expect(all.total).toBe(2);
    expect(invoices.data.map((row) => row.id)).toEqual([document.id]);
    expect(found.data.map((row) => row.id)).toEqual([document.id]);
    expect(invoices.data[0]).toMatchObject({
      invoice_number: 'RE-2026-0042', net_amount: 500, vat_amount: 95, gross_amount: 595, currency: 'EUR',
      bank_account: 'DE89370400440532013000', payment_status: 'unpaid', ksef_invoice_id: null,
      is_payment_overdue: true,
    });
  });
});

describe('documents of other types', () => {
  const contractForm = (overrides = {}) => ({
    name: 'Umowa partnerska', doc_type: 'partner_agreement', gdpr_type: 'no_gdpr', group_id: otherGroup.id,
    contract_subject: 'System', signing_date: '2026-01-15', expiration_date: '2026-02-15', ...overrides,
  });

  test('behave as before: the contract subject stays, there are no invoice fields and no project links', async () => {
    const created = await postDocument(contractForm());

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      doc_type: 'partner_agreement', contract_subject: 'System', signing_date: '2026-01-15',
      invoice_number: null, net_amount: null, currency: null, payment_status: null, ksef_invoice_id: null,
      is_payment_overdue: false,
    });
    const detail = await getDocument(created.body.id);
    expect(detail).not.toHaveProperty('project_links');
    expect(detail.is_payment_overdue).toBe(false);

    const updated = await api('patch', `/api/documents/${created.body.id}`, pm)
      .send({ contract_subject: 'Inne', status: 'being_edited' });
    expect(updated.body).toMatchObject({ contract_subject: 'Inne', status: 'being_edited', payment_status: null });
  });

  test('cannot carry invoice fields', async () => {
    const error = 'Invoice fields can be set only on documents of type invoice';
    const onCreate = await postDocument(contractForm({ invoice_number: 'FV/1' }));
    expect(onCreate.status).toBe(400);
    expect(onCreate.body.error).toBe(error);

    const { body: contract } = await postDocument(contractForm());
    const onUpdate = await api('patch', `/api/documents/${contract.id}`, pm).send({ payment_status: 'paid' });
    expect(onUpdate.status).toBe(400);
    expect(onUpdate.body.error).toBe(error);
    // Empty values are what a shared form sends for the fields it hides.
    expect((await api('patch', `/api/documents/${contract.id}`, pm).send({ name: 'Umowa 2', invoice_number: '' })).status).toBe(200);
  });

  test('changing the type: a contract becomes an unpaid invoice, an invoice loses its invoice fields', async () => {
    const { body: contract } = await postDocument(contractForm());

    const asInvoice = await api('patch', `/api/documents/${contract.id}`, pm)
      .send({ doc_type: 'invoice', invoice_number: 'FV/7' });
    expect(asInvoice.body).toMatchObject({
      doc_type: 'invoice', invoice_number: 'FV/7', payment_status: 'unpaid', currency: 'PLN', contract_subject: null,
    });

    const asContract = await api('patch', `/api/documents/${contract.id}`, pm).send({ doc_type: 'nda' });
    expect(asContract.body).toMatchObject({
      doc_type: 'nda', invoice_number: null, payment_status: null, currency: null, is_payment_overdue: false,
    });
  });
});

describe('the payment-status dictionary', () => {
  const storeDictionary = (statuses) => db.query(
    `INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
     VALUES ($1, 'doc_payment_statuses', $2, 'Statusy płatności faktur', '', 'json', 'documents')`,
    [tenantId, JSON.stringify(statuses)],
  );

  test('has four statuses by default', async () => {
    for (const status of ['unpaid', 'partially_paid', 'paid', 'overdue']) {
      expect((await createInvoiceDocument({ payment_status: status })).payment_status).toBe(status);
    }
  });

  test('is a tenant setting managed like the other document dictionaries', async () => {
    await storeDictionary(['unpaid', 'partially_paid', 'paid', 'overdue']);

    const saved = await api('put', '/api/admin/settings', admin)
      .send({ doc_payment_statuses: ['unpaid', 'paid', 'disputed'] });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body.settings.doc_payment_statuses)).toEqual(['unpaid', 'paid', 'disputed']);
    expect((await api('put', '/api/admin/settings', pm).send({ doc_payment_statuses: ['paid'] })).status).toBe(403);
    const { body: forEveryone } = await api('get', '/api/admin/settings', outsider);
    expect(JSON.parse(forEveryone.settings.doc_payment_statuses)).toEqual(['unpaid', 'paid', 'disputed']);

    expect((await createInvoiceDocument({ payment_status: 'disputed' })).payment_status).toBe('disputed');
    expect((await postDocument(invoiceForm({ payment_status: 'overdue' }))).status).toBe(400);
  });

  test('a new invoice starts without a status when the tenant removed "unpaid"', async () => {
    await storeDictionary(['open', 'paid']);
    expect((await createInvoiceDocument()).payment_status).toBeNull();
  });

  test('the migration gave it to the template tenant, together with the "invoice" document type', async () => {
    const { rows } = await db.query(
      `SELECT s.key, s.value FROM app_settings s JOIN tenants t ON t.id = s.tenant_id
       WHERE t.slug = 'crmtree-gold' AND s.key = ANY($1::text[])`,
      [['doc_types', 'doc_payment_statuses']],
    );
    const dictionaries = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    // The template tenant exists in every real database; an empty test database has nothing to check.
    if (dictionaries.doc_types) expect(dictionaries.doc_types).toContain('invoice');
    if (rows.length) expect(dictionaries.doc_payment_statuses).toEqual(['unpaid', 'partially_paid', 'paid', 'overdue']);
  });
});

describe('the derived overdue flag', () => {
  test('is true when the due date has passed and the status is not "paid" — the stored status is untouched', async () => {
    const pastDue = isoDaysFromNow(-2);
    const cases = [
      [{ expiration_date: pastDue, payment_status: 'unpaid' }, true],
      [{ expiration_date: pastDue, payment_status: 'partially_paid' }, true],
      [{ expiration_date: pastDue, payment_status: 'paid' }, false],
      [{ expiration_date: isoDaysFromNow(2), payment_status: 'unpaid' }, false],
      [{ expiration_date: isoDaysFromNow(2), payment_status: 'overdue' }, false],
    ];
    for (const [overrides, isOverdue] of cases) {
      const document = await createInvoiceDocument(overrides);
      expect(document.is_payment_overdue).toBe(isOverdue);
      const detail = await getDocument(document.id);
      expect(detail.is_payment_overdue).toBe(isOverdue);
      expect(detail.payment_status).toBe(overrides.payment_status);
    }
    const { body: listed } = await api('get', '/api/documents?doc_type=invoice&sort=created_at&order=asc', pm);
    expect(listed.data.map((row) => row.is_payment_overdue)).toEqual(cases.map(([, isOverdue]) => isOverdue));
  });

  test('an invoice without a due date is never overdue, and paying it clears the flag', async () => {
    const formWithoutDueDate = invoiceForm();
    delete formWithoutDueDate.expiration_date;
    const { body: noDueDate } = await postDocument(formWithoutDueDate);
    expect(noDueDate).toMatchObject({ expiration_date: null, payment_status: 'unpaid', is_payment_overdue: false });

    const overdue = await createInvoiceDocument({ expiration_date: isoDaysFromNow(-10) });
    expect(overdue.is_payment_overdue).toBe(true);
    const paid = await api('patch', `/api/documents/${overdue.id}`, pm).send({ payment_status: 'paid' });
    expect(paid.body.is_payment_overdue).toBe(false);
  });
});

describe('the access group for invoice documents', () => {
  test('is chosen by the tenant admin in the KSeF settings, among the active groups of the tenant', async () => {
    expect((await api('get', '/api/admin/ksef', admin)).body.invoice_documents_group).toBeNull();

    for (const [group, status] of [[inactiveGroup, 400], [foreignGroup, 400]]) {
      const res = await chooseGroup(group);
      expect(res.status).toBe(status);
      expect(res.body.error).toBe('Unknown or inactive group');
    }
    expect((await api('put', '/api/admin/ksef/settings', admin).send({ invoice_documents_group_id: 'faktury' })).status).toBe(400);
    expect((await api('put', '/api/admin/ksef/settings', admin).send({})).status).toBe(400);
    expect((await api('put', '/api/admin/ksef/settings', pm).send({ invoice_documents_group_id: invoiceGroup.id })).status).toBe(403);

    const saved = await chooseGroup(invoiceGroup);
    expect(saved.status).toBe(200);
    expect(saved.body.invoice_documents_group).toEqual({ id: invoiceGroup.id, name: 'Faktury', display_name: 'Faktury' });

    // The other KSeF setting is saved on its own and leaves the group alone.
    const days = await api('put', '/api/admin/ksef/settings', admin).send({ initial_sync_days: 45 });
    expect(days.body).toMatchObject({ initial_sync_days: 45, invoice_documents_group: { id: invoiceGroup.id } });

    expect((await chooseGroup(null)).body.invoice_documents_group).toBeNull();
  });

  test('a group that was deactivated afterwards counts as not chosen', async () => {
    const temporary = await mkGroup('Tymczasowa');
    await chooseGroup(temporary);
    await db.query('UPDATE group_profiles SET is_active = FALSE WHERE id = $1', [temporary.id]);

    expect((await api('get', '/api/admin/ksef', admin)).body.invoice_documents_group).toBeNull();
    expect((await register(await insertKsefInvoice())).status).toBe(409);
  });
});

describe('registering a KSeF invoice in Documents', () => {
  test('without a chosen group the action is refused and the invoice lists say registration is not set up', async () => {
    const invoice = await insertKsefInvoice();

    const res = await register(invoice);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(GROUP_NOT_CONFIGURED);
    expect(await documentsOfTenant()).toHaveLength(0);
    const { body: list } = await api('get', '/api/ksef/invoices?date_from=2026-09-01&date_to=2026-09-30', pm);
    expect(list.is_document_group_configured).toBe(false);
    expect(list.items[0].document_id).toBeNull();
    const { body: detail } = await api('get', `/api/ksef/invoices/${invoice.id}`, pm);
    expect(detail).toMatchObject({ document_id: null, is_document_group_configured: false });
  });

  test('creates a completed invoice document filled from the invoice, owned by the registering user', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice({ invoice_number: 'FV/2026/09/77' });

    const res = await register(invoice, accountant);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      document_id: expect.any(String),
      doc_number: expect.stringMatching(/^DOC-\d{4}-\d{4}$/),
      name: 'FV/2026/09/77 — Hotel Pod Lipami Sp. z o.o.',
      is_new: true,
      can_open: true,
    });
    const document = await getDocument(res.body.document_id, accountant);
    expect(document).toMatchObject({
      doc_type: 'invoice',
      status: 'completed',
      gdpr_type: 'no_gdpr',
      group_id: invoiceGroup.id,
      owner_id: accountant.id,
      created_by: accountant.id,
      entities: ['Nasza Firma Sp. z o.o.', 'Hotel Pod Lipami Sp. z o.o.'],
      nip: SELLER_NIP,
      invoice_number: 'FV/2026/09/77',
      signing_date: '2026-09-14',
      expiration_date: '2026-09-28',
      net_amount: 1000,
      vat_amount: 230,
      gross_amount: 1230,
      currency: 'PLN',
      bank_account: '73111111111111111111111111',
      payment_status: 'unpaid',
      contract_subject: null,
      ksef_invoice_id: invoice.id,
      is_payment_overdue: true,
      project_links: [],
      workflow_tasks: null,
    });

    const { body: history } = await api('get', `/api/documents/${document.id}/history`, accountant);
    expect(history.find((entry) => entry.action === 'document_created')).toMatchObject({
      user_email: accountant.email, metadata: { source: 'ksef', ksef_invoice_id: invoice.id },
    });
    const { body: detail } = await api('get', `/api/ksef/invoices/${invoice.id}`, pm);
    expect(detail).toMatchObject({ document_id: document.id, is_document_group_configured: true });
    const { body: list } = await api('get', '/api/ksef/invoices?date_from=2026-09-01&date_to=2026-09-30', pm);
    expect(list).toMatchObject({ is_document_group_configured: true, items: [{ document_id: document.id }] });
  });

  test('the main file is a PDF visualisation in the tenant language, shown by the normal preview', async () => {
    await chooseGroup(invoiceGroup);
    await db.query("UPDATE tenants SET default_locale = 'en' WHERE id = $1", [tenantId]);
    const generate = jest.spyOn(invoiceVisualisationPdfService, 'generateInvoiceVisualisationPdf');
    const invoice = await insertKsefInvoice({ invoice_number: 'FV/2026/09/77' });

    const { body: registered } = await register(invoice);

    expect(generate).toHaveBeenCalledTimes(1);
    const [renderedInvoice, locale] = generate.mock.calls[0];
    expect(locale).toBe('en');
    expect(renderedInvoice).toMatchObject({
      ksef_number: invoice.ksef_number, sale_date: '2026-09-13', seller_address: 'ul. Lipowa 1, 00-001 Warszawa',
      net_amount: 1000, lines: [{ name: 'Nocleg', quantity: 2 }], payment: { form: '6' },
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ fileName: 'FV_2026_09_77.pdf', mimeType: 'application/pdf' });
    expect(uploads[0].buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const document = await getDocument(registered.document_id);
    expect(document).toMatchObject({ blob_name: 'FV_2026_09_77.pdf', mime_type: 'application/pdf' });
    expect(document.versions).toEqual([
      expect.objectContaining({ version_number: 1, label: 'KSeF data visualisation', mime_type: 'application/pdf' }),
    ]);
    const preview = await api('get', `/api/documents/${document.id}/preview`, plainPm).buffer(true).parse((res, done) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toContain('application/pdf');
    expect(preview.body.equals(uploads[0].buffer)).toBe(true);
  });

  test('is idempotent: one document per invoice, also when two requests race', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice();

    const first = await register(invoice);
    const again = await register(invoice, accountant);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ document_id: first.body.document_id, is_new: false });
    expect(uploads).toHaveLength(1);

    const raced = await insertKsefInvoice();
    const responses = await Promise.all([register(raced), register(raced, accountant), register(raced, admin)]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(responses.map((res) => res.body.document_id)).size).toBe(1);
    expect((await documentsOfTenant()).filter((document) => document.ksef_invoice_id === raced.id)).toHaveLength(1);
  });

  test('the payment status starts from what the invoice says', async () => {
    await chooseGroup(invoiceGroup);
    const partially = JSON.stringify({ due_dates: [], form: null, bank_accounts: [], is_partially_paid: true });
    for (const [overrides, status] of [
      [{ is_paid: true }, 'paid'],
      [{ is_paid: false, payment: partially }, 'partially_paid'],
      [{ is_paid: null, payment: partially }, 'partially_paid'],
      [{ is_paid: false }, 'unpaid'],
      [{ is_paid: null, payment: null }, 'unpaid'],
    ]) {
      const { body: registered } = await register(await insertKsefInvoice(overrides));
      expect((await getDocument(registered.document_id)).payment_status).toBe(status);
    }
  });

  test('an invoice with hardly any data is registered too', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice({
      invoice_number: null, seller_name: null, seller_nip: null, buyer_name: null, net_amount: null, vat_amount: null,
      gross_amount: null, payment_due_date: null, bank_account: null, payment: null, lines: '[]',
    });

    const res = await register(invoice);

    expect(res.status).toBe(201);
    expect(res.body.name).toBe(invoice.ksef_number);
    expect(await getDocument(res.body.document_id)).toMatchObject({
      entities: [], nip: null, invoice_number: null, net_amount: null, expiration_date: null,
      payment_status: 'unpaid', is_payment_overdue: false,
    });
  });

  test('needs the KSeF permission; unknown and foreign invoices are not found', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice();
    const foreign = await insertKsefInvoice({ tenant_id: otherTenantId });

    for (const user of [plainPm, controller, outsider]) {
      expect((await register(invoice, user)).status).toBe(403);
    }
    expect((await register(foreign, admin)).status).toBe(404);
    expect((await register({ id: '00000000-0000-4000-8000-000000000000' }, admin)).status).toBe(404);
    expect((await register({ id: 'not-a-uuid' }, admin)).status).toBe(400);
    expect(await documentsOfTenant()).toHaveLength(0);
  });

  test('a user outside the group registers the document but cannot open it', async () => {
    await chooseGroup(invoiceGroup);

    const res = await register(await insertKsefInvoice(), strangerPm);

    expect(res.status).toBe(201);
    expect(res.body.can_open).toBe(false);
    expect((await api('get', `/api/documents/${res.body.document_id}`, strangerPm)).status).toBe(403);
    expect((await getDocument(res.body.document_id, accountant)).owner_id).toBe(strangerPm.id);
  });

  test('after the document was deleted the invoice can be registered again', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice();
    const { body: first } = await register(invoice);
    expect((await api('delete', `/api/documents/${first.document_id}`, pm)).status).toBe(200);
    expect((await api('get', `/api/ksef/invoices/${invoice.id}`, pm)).body.document_id).toBeNull();

    const second = await register(invoice);

    expect(second.status).toBe(201);
    expect(second.body.document_id).not.toBe(first.document_id);
  });

  test('with project finance switched off there is no registration', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice();
    await setFinanceSwitch(false);
    try {
      const res = await register(invoice, admin);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Project finance is switched off');
    } finally {
      await setFinanceSwitch(true);
    }
  });
});

describe('automatic registration when a KSeF invoice is linked to a cost item', () => {
  test('the first link registers the invoice; the cost item points at the document', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice({ invoice_number: 'FV/9' });

    const first = await addCost({ ksef_invoice_id: invoice.id, amount: 400 });
    const second = await addCost({ ksef_invoice_id: invoice.id, amount: 100 }, { target: secondProject });

    const documents = await documentsOfTenant();
    expect(documents).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    expect(first).toMatchObject({
      ksef_invoice_id: invoice.id,
      document_id: documents[0].id,
      document: {
        id: documents[0].id, name: 'FV/9 — Hotel Pod Lipami Sp. z o.o.', invoice_number: 'FV/9', can_open: true,
        doc_number: expect.stringMatching(/^DOC-/),
      },
      ksef_invoice: { id: invoice.id, document_id: documents[0].id },
    });
    expect(second.document_id).toBe(documents[0].id);
    expect(second.other_links.map((other) => other.cost_item_id)).toEqual([first.id]);

    const document = await getDocument(documents[0].id);
    expect(document).toMatchObject({ status: 'completed', owner_id: pm.id, workflow_tasks: null });
    expect(document.project_links.map((projectLink) => projectLink.cost_item_id)).toEqual([first.id, second.id]);
  });

  test('without a chosen group the link still succeeds; registering later fills in the document', async () => {
    const invoice = await insertKsefInvoice();

    const cost = await addCost({ ksef_invoice_id: invoice.id });

    expect(cost).toMatchObject({ ksef_invoice_id: invoice.id, document_id: null, document: null });
    expect(cost.ksef_invoice.document_id).toBeNull();
    expect(await documentsOfTenant()).toHaveLength(0);

    await chooseGroup(invoiceGroup);
    const { body: registered } = await register(invoice, accountant);
    const { body: [listed] } = await api('get', financeUrl('/costs'), pm);
    expect(listed).toMatchObject({ document_id: registered.document_id, document: { id: registered.document_id } });
    const { project_links: [projectLink] } = await getDocument(registered.document_id, accountant);
    // The link was made by the PM, earlier — not by whoever registered the document.
    expect(projectLink).toMatchObject({ cost_item_id: cost.id, linked_by: pm.id, linked_by_name: 'dpm Test' });
  });

  test('attaching an invoice to an existing cost item registers it; detaching drops the document link', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice();
    const plain = await addCost({ date: '2026-09-15', amount: 100 });
    expect(plain).toMatchObject({ document_id: null, document: null });

    const attached = await api('patch', financeUrl(`/costs/${plain.id}`), pm).send({ ksef_invoice_id: invoice.id });

    expect(attached.status).toBe(200);
    const [document] = await documentsOfTenant();
    expect(attached.body).toMatchObject({ ksef_invoice_id: invoice.id, document_id: document.id });

    const detached = await api('patch', financeUrl(`/costs/${plain.id}`), pm).send({ ksef_invoice_id: null });
    expect(detached.body).toMatchObject({ ksef_invoice_id: null, document_id: null, document: null, ksef_invoice: null });
    expect((await getDocument(document.id)).project_links).toEqual([]);
  });

  test('a failing registration never fails the link', async () => {
    await chooseGroup(invoiceGroup);
    storage.uploadDocument.mockRejectedValue(new Error('storage is down'));
    const invoice = await insertKsefInvoice();

    const cost = await addCost({ ksef_invoice_id: invoice.id });

    expect(cost).toMatchObject({ ksef_invoice_id: invoice.id, document_id: null, amount: 1000 });
    expect(await documentsOfTenant()).toHaveLength(0);
  });

  test('the document of a KSeF-linked cost item follows the invoice, whatever the request says about it', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice();
    const other = await insertKsefInvoice();
    const handEntered = await createInvoiceDocument();
    const cost = await addCost({ ksef_invoice_id: invoice.id });

    // A form that sends the whole item back, with an empty document.
    const resent = await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ document_id: null, description: 'Opis' });
    expect(resent.body).toMatchObject({ description: 'Opis', ksef_invoice_id: invoice.id, document_id: cost.document_id });

    const mismatch = await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ document_id: handEntered.id });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('The document does not belong to this KSeF invoice');

    const moved = await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ ksef_invoice_id: other.id });
    const { body: otherInvoice } = await api('get', `/api/ksef/invoices/${other.id}`, pm);
    expect(moved.body.document_id).toBe(otherInvoice.document_id);
    expect(moved.body.document_id).not.toBe(cost.document_id);

    // Swapping the KSeF invoice for a hand-entered document in one request.
    const swapped = await api('patch', financeUrl(`/costs/${cost.id}`), pm)
      .send({ ksef_invoice_id: null, document_id: handEntered.id });
    expect(swapped.body).toMatchObject({ ksef_invoice_id: null, ksef_invoice: null, document_id: handEntered.id });
  });
});

describe('linking a hand-entered invoice document to cost items', () => {
  test('a cost item created from the document takes its amount, date, supplier and number', async () => {
    const document = await createInvoiceDocument({ currency: 'PLN' });

    const cost = await addCost({ document_id: document.id });

    expect(cost).toMatchObject({
      date: '2026-09-10',
      amount: 500,
      supplier_name: 'Lieferant GmbH',
      document_number: 'RE-2026-0042',
      ksef_invoice_id: null,
      ksef_invoice: null,
      document_id: document.id,
      document: {
        id: document.id, doc_number: document.doc_number, name: document.name, invoice_number: 'RE-2026-0042',
        can_open: true,
      },
      other_links: [],
    });

    const explicit = await addCost({
      document_id: document.id, date: '2026-09-20', amount: 120, supplier_name: 'Inny', document_number: 'X/1',
    });
    expect(explicit).toMatchObject({ date: '2026-09-20', amount: 120, supplier_name: 'Inny', document_number: 'X/1' });
  });

  test('a document without a net amount or an issue date needs them in the request', async () => {
    const { body: bare } = await postDocument(
      { name: 'Faktura bez danych', doc_type: 'invoice', gdpr_type: 'no_gdpr', group_id: invoiceGroup.id },
      pm, { withFile: false },
    );

    const noDate = await api('post', financeUrl('/costs'), pm).send({ category_id: categoryId, document_id: bare.id, amount: 10 });
    expect(noDate.status).toBe(400);
    expect(noDate.body.error).toBe('The date is required');
    const noAmount = await api('post', financeUrl('/costs'), pm)
      .send({ category_id: categoryId, document_id: bare.id, date: '2026-09-15' });
    expect(noAmount.status).toBe(400);
    expect(noAmount.body.error).toBe('The invoice has no positive net amount; provide the amount');

    const cost = await addCost({ document_id: bare.id, date: '2026-09-15', amount: 10 });
    expect(cost).toMatchObject({ document_id: bare.id, supplier_name: null, document_number: null });
  });

  test('is attached to an existing cost item and detached again, with the change in the audit log', async () => {
    const document = await createInvoiceDocument();
    const cost = await addCost({ date: '2026-09-15', amount: 100 });

    const attached = await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ document_id: document.id });
    expect(attached.status).toBe(200);
    expect(attached.body).toMatchObject({ amount: 100, document_id: document.id, document: { id: document.id } });

    const detached = await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ document_id: null });
    expect(detached.body).toMatchObject({ document_id: null, document: null, other_links: [] });

    const { rows: log } = await db.query(
      `SELECT before_state, after_state FROM audit_logs
       WHERE tenant_id = $1 AND action = 'project_cost_updated' AND metadata->>'cost_item_id' = $2
       ORDER BY created_at`,
      [tenantId, cost.id],
    );
    expect(log).toEqual([
      { before_state: { document_id: null }, after_state: { document_id: document.id } },
      { before_state: { document_id: document.id }, after_state: { document_id: null } },
    ]);
  });

  test('needs finance write access AND access to the document', async () => {
    const document = await createInvoiceDocument();
    await api('patch', financeUrl(), pm).send({ participants_can_add_costs: true });
    const task = await createTask();
    await api('patch', `/api/projects/${project.id}/tasks/${task.id}`, pm).send({ assignee_ids: [worker.id] });
    const body = { category_id: categoryId, document_id: document.id };

    // A PM outside the document's group; a participant adding costs to own tasks who can read the document.
    for (const [user, overrides] of [[strangerPm, {}], [worker, { task_id: task.id }]]) {
      const res = await api('post', financeUrl('/costs'), user).send({ ...body, ...overrides });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(DOCUMENT_LINKING_DENIED);
    }
    expect((await api('post', financeUrl('/costs'), controller).send(body)).status).toBe(403);
    expect((await api('post', financeUrl('/costs'), accountant).send(body)).status).toBe(404);

    // Read access to the document is enough; no KSeF permission is involved.
    const byPlainPm = await api('post', financeUrl('/costs'), plainPm).send(body);
    expect(byPlainPm.status).toBe(201);
    expect((await api('post', financeUrl('/costs'), admin).send(body)).status).toBe(201);

    const attachDenied = await api('patch', financeUrl(`/costs/${byPlainPm.body.id}`), strangerPm).send({ document_id: null });
    expect(attachDenied.status).toBe(403);
    expect(attachDenied.body.error).toBe(DOCUMENT_LINKING_DENIED);
    // The rest of a linked item stays editable for a PM who cannot open the document.
    const edited = await api('patch', financeUrl(`/costs/${byPlainPm.body.id}`), strangerPm).send({ description: 'Opis' });
    expect(edited.body).toMatchObject({ description: 'Opis', document_id: document.id, document: { can_open: false } });
  });

  test('only a live invoice document of the same tenant can be linked', async () => {
    const { body: contract } = await postDocument(
      { name: 'Umowa', doc_type: 'nda', gdpr_type: 'no_gdpr', group_id: invoiceGroup.id }, pm, { withFile: false },
    );
    const deleted = await createInvoiceDocument();
    await api('delete', `/api/documents/${deleted.id}`, pm);
    const { rows: [foreign] } = await db.query(
      `INSERT INTO documents (tenant_id, name, doc_type, gdpr_type, group_id)
       VALUES ($1, 'Obca faktura', 'invoice', 'no_gdpr', $2) RETURNING id`,
      [otherTenantId, foreignGroup.id],
    );

    for (const documentId of [contract.id, deleted.id, foreign.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await api('post', financeUrl('/costs'), admin)
        .send({ category_id: categoryId, document_id: documentId, date: '2026-09-15', amount: 10 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Unknown invoice document');
    }
    expect((await api('post', financeUrl('/costs'), admin)
      .send({ category_id: categoryId, document_id: 'faktura', date: '2026-09-15', amount: 10 })).status).toBe(400);
  });

  test('a hand-entered document and a KSeF invoice cannot be mixed on one cost item', async () => {
    const document = await createInvoiceDocument();
    const invoice = await insertKsefInvoice();

    const res = await api('post', financeUrl('/costs'), pm)
      .send({ category_id: categoryId, document_id: document.id, ksef_invoice_id: invoice.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The document does not belong to this KSeF invoice');
  });

  test('attaching the document of a KSeF invoice is linking that invoice — with the KSeF permission', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice();
    const { body: registered } = await register(invoice);
    const body = { category_id: categoryId, document_id: registered.document_id };

    const withoutPermission = await api('post', financeUrl('/costs'), plainPm).send(body);
    expect(withoutPermission.status).toBe(403);
    expect(withoutPermission.body.error).toBe(KSEF_LINKING_DENIED);

    const cost = await addCost({ document_id: registered.document_id });
    expect(cost).toMatchObject({
      ksef_invoice_id: invoice.id, document_id: registered.document_id, amount: 1000, date: '2026-09-14',
      ksef_invoice: { links_count: 1, linked_total: 1000 },
    });

    const plain = await addCost({ date: '2026-09-15', amount: 50 });
    const attached = await api('patch', financeUrl(`/costs/${plain.id}`), pm).send({ document_id: registered.document_id });
    expect(attached.body).toMatchObject({ ksef_invoice_id: invoice.id, ksef_invoice: { links_count: 2, linked_total: 1050 } });
  });

  test('a closed project is read-only: no attaching or detaching — the links stay visible', async () => {
    const document = await createInvoiceDocument({ currency: 'PLN' });
    const cost = await addCost({ document_id: document.id });
    expect((await api('post', `/api/projects/${project.id}/close`, pm)).status).toBe(200);

    expect((await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ document_id: null })).status).toBe(409);
    expect((await api('post', financeUrl('/costs'), pm).send({ category_id: categoryId, document_id: document.id })).status).toBe(409);
    const { body: [listed] } = await api('get', financeUrl('/costs'), pm);
    expect(listed.document_id).toBe(document.id);
    expect((await getDocument(document.id)).project_links).toHaveLength(1);
  });
});

describe('one invoice document, many cost items', () => {
  test('linking is never blocked, and every cost item lists the others', async () => {
    const document = await createInvoiceDocument({ currency: 'PLN' });
    const task = await createTask('Montaż');

    const first = await addCost({ document_id: document.id, amount: 300 });
    const second = await addCost({ document_id: document.id, amount: 300, task_id: task.id });
    const third = await addCost({ document_id: document.id, amount: 300, task_id: task.id });
    const fourth = await addCost({ document_id: document.id, amount: 300, status: 'planned' }, { target: secondProject });

    expect(first.other_links).toEqual([]);
    expect(fourth.other_links).toEqual([
      expect.objectContaining({ cost_item_id: first.id, project_key: project.key, task_id: null, amount: 300, currency: 'PLN' }),
      expect.objectContaining({ cost_item_id: second.id, task_number: task.task_number, task_name: 'Montaż' }),
      expect.objectContaining({ cost_item_id: third.id, linked_by: pm.id, linked_by_name: 'dpm Test' }),
    ]);
    const { body: costs } = await api('get', financeUrl('/costs'), controller);
    expect(costs).toHaveLength(3);
    for (const cost of costs) {
      expect(cost.other_links).toHaveLength(3);
      expect(cost.other_links.map((other) => other.cost_item_id)).not.toContain(cost.id);
      // The controller reads the project finance but is outside the document's group.
      expect(cost.document).toMatchObject({ id: document.id, can_open: false });
    }
  });

  test('other_links is one list without duplicates, whether the KSeF invoice or the document is shared', async () => {
    await chooseGroup(invoiceGroup);
    const invoice = await insertKsefInvoice();
    const unrelated = await createInvoiceDocument();

    const viaInvoice = await addCost({ ksef_invoice_id: invoice.id, amount: 100 });
    const viaDocument = await addCost({ document_id: viaInvoice.document_id, amount: 200 }, { target: secondProject });
    const viaInvoiceAgain = await addCost({ ksef_invoice_id: invoice.id, amount: 300 });
    await addCost({ document_id: unrelated.id, date: '2026-09-15', amount: 50 });
    await addCost({ date: '2026-09-15', amount: 50 });

    const { body: costs } = await api('get', financeUrl('/costs'), pm);
    const othersOf = (cost) => costs.find((listed) => listed.id === cost.id).other_links.map((other) => other.cost_item_id);
    expect(othersOf(viaInvoice)).toEqual([viaDocument.id, viaInvoiceAgain.id]);
    expect(othersOf(viaInvoiceAgain)).toEqual([viaInvoice.id, viaDocument.id]);
    const { body: [inSecondProject] } = await api('get', financeUrl('/costs', secondProject), pm);
    expect(inSecondProject.other_links.map((other) => other.cost_item_id)).toEqual([viaInvoice.id, viaInvoiceAgain.id]);
    expect(costs.filter((cost) => !cost.ksef_invoice_id).every((cost) => cost.other_links.length === 0)).toBe(true);
  });

  test('links made before the invoice had a document are in the same list as later ones', async () => {
    const invoice = await insertKsefInvoice();
    const early = await addCost({ ksef_invoice_id: invoice.id, amount: 100 });
    await chooseGroup(invoiceGroup);
    await db.query('UPDATE project_cost_items SET document_id = NULL WHERE id = $1', [early.id]);
    const late = await addCost({ ksef_invoice_id: invoice.id, amount: 100 });

    const { body: costs } = await api('get', financeUrl('/costs'), pm);

    expect(costs.find((cost) => cost.id === late.id).other_links.map((other) => other.cost_item_id)).toEqual([early.id]);
    expect(costs.find((cost) => cost.id === early.id).other_links.map((other) => other.cost_item_id)).toEqual([late.id]);
  });

  test('a participant who only sees own cost items gets no document data', async () => {
    const document = await createInvoiceDocument();
    await api('patch', financeUrl(), pm).send({ participants_can_add_costs: true });
    const task = await createTask();
    await api('patch', `/api/projects/${project.id}/tasks/${task.id}`, pm).send({ assignee_ids: [worker.id] });
    const own = await api('post', financeUrl('/costs'), worker)
      .send({ category_id: categoryId, task_id: task.id, date: '2026-09-15', amount: 10 });
    await addCost({ document_id: document.id, date: '2026-09-15', amount: 20 });
    expect((await api('patch', financeUrl(`/costs/${own.body.id}`), pm).send({ document_id: document.id })).status).toBe(200);

    const { body: costs } = await api('get', financeUrl('/costs'), worker);

    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ id: own.body.id, document_id: document.id, document: null, other_links: [] });
    expect((await api('patch', financeUrl(`/costs/${own.body.id}`), worker).send({ document_id: null })).status).toBe(403);
  });
});

describe('project links on the invoice document', () => {
  test('list every linked cost item; can_open tells whether the viewer may enter the project', async () => {
    const document = await createInvoiceDocument({ currency: 'PLN' });
    const task = await createTask('Montaż');
    const onTask = await addCost({ document_id: document.id, amount: 300, task_id: task.id });
    const onProject = await addCost({ document_id: document.id, amount: 200, status: 'planned' }, { target: secondProject });

    const forPm = await getDocument(document.id, pm);

    expect(forPm.project_links).toEqual([
      {
        cost_item_id: onTask.id,
        project_id: project.id,
        project_key: project.key,
        project_name: 'Projekt Faktury',
        task_id: task.id,
        task_number: task.task_number,
        task_name: 'Montaż',
        amount: 300,
        currency: 'PLN',
        status: 'incurred',
        linked_by: pm.id,
        linked_by_name: 'dpm Test',
        linked_at: expect.any(String),
        can_open: true,
      },
      {
        cost_item_id: onProject.id,
        project_id: secondProject.id,
        project_key: secondProject.key,
        project_name: 'Projekt Drugi',
        task_id: null,
        task_number: null,
        task_name: null,
        amount: 200,
        currency: 'PLN',
        status: 'planned',
        linked_by: pm.id,
        linked_by_name: 'dpm Test',
        linked_at: expect.any(String),
        can_open: true,
      },
    ]);
    // A member of the first project only.
    expect((await getDocument(document.id, plainPm)).project_links.map((projectLink) => projectLink.can_open)).toEqual([true, false]);
    expect((await getDocument(document.id, admin)).project_links.map((projectLink) => projectLink.can_open)).toEqual([true, true]);
  });

  test('a viewer without any project access still sees names and amounts, only not as links', async () => {
    const document = await createInvoiceDocument({ currency: 'PLN' });
    await addCost({ document_id: document.id, amount: 300 });

    const res = await api('get', `/api/documents/${document.id}`, accountant);

    expect(res.status).toBe(200);
    expect(res.body.project_links).toEqual([
      expect.objectContaining({ project_name: 'Projekt Faktury', project_key: project.key, amount: 300, currency: 'PLN', can_open: false }),
    ]);
    expect((await api('get', `/api/projects/${project.id}`, accountant)).status).toBe(404);
    // Whoever cannot read the document does not get the list either.
    expect((await api('get', `/api/documents/${document.id}`, controller)).status).toBe(403);
  });

  test('are empty while project finance is switched off, and back when it is switched on again', async () => {
    const document = await createInvoiceDocument({ currency: 'PLN' });
    await addCost({ document_id: document.id });
    await setFinanceSwitch(false);
    try {
      const detail = await getDocument(document.id);
      expect(detail.project_links).toEqual([]);
      expect(detail.invoice_number).toBe('RE-2026-0042');
      const res = await api('post', financeUrl('/costs'), pm).send({ category_id: categoryId, document_id: document.id });
      expect(res.status).toBe(403);
    } finally {
      await setFinanceSwitch(true);
    }
    expect((await getDocument(document.id)).project_links).toHaveLength(1);
  });

  test('an invoice linked to costs or registered from KSeF cannot change its type', async () => {
    await chooseGroup(invoiceGroup);
    const linked = await createInvoiceDocument({ currency: 'PLN' });
    const cost = await addCost({ document_id: linked.id });
    const { body: registered } = await register(await insertKsefInvoice());

    for (const documentId of [linked.id, registered.document_id]) {
      const res = await api('patch', `/api/documents/${documentId}`, pm).send({ doc_type: 'nda' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('An invoice registered from KSeF or linked to project costs cannot change its type');
    }
    await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ document_id: null });
    expect((await api('patch', `/api/documents/${linked.id}`, pm).send({ doc_type: 'nda' })).status).toBe(200);
  });

  test('deleting the document detaches it from its cost items; a KSeF link stays', async () => {
    await chooseGroup(invoiceGroup);
    const handEntered = await createInvoiceDocument({ currency: 'PLN' });
    const plainCost = await addCost({ document_id: handEntered.id });
    const invoice = await insertKsefInvoice();
    const ksefCost = await addCost({ ksef_invoice_id: invoice.id });

    expect((await api('delete', `/api/documents/${handEntered.id}`, pm)).status).toBe(200);
    expect((await api('delete', `/api/documents/${ksefCost.document_id}`, pm)).status).toBe(200);

    const { body: costs } = await api('get', financeUrl('/costs'), pm);
    expect(costs.find((cost) => cost.id === plainCost.id)).toMatchObject({ document_id: null, document: null, amount: 500 });
    expect(costs.find((cost) => cost.id === ksefCost.id)).toMatchObject({
      ksef_invoice_id: invoice.id, document_id: null, document: null, ksef_invoice: { document_id: null },
    });
  });
});
