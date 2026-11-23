'use strict';

// POST /api/admin/prospects/import — the "already a Lead or a Partner" check.
// It used to run one query per CSV row; it is now one lookup for the whole file.
// These tests try to show that the single lookup behaves differently from the
// per-row one (formatting of the NIP, tenant isolation, lead vs partner, repeats).

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

const TENANT_SLUG = 'zz-prospects-import-lookup';
const OTHER_TENANT_SLUG = 'zz-prospects-import-lookup-other';
const ADMIN_EMAIL = 'admin@zz-prospects-import-lookup.worktrips.com';
const NIP = {
  leadPlain: '9999999811', leadFormatted: '9999999812', partner: '9999999813', leadAndPartner: '9999999814',
  otherTenantLead: '9999999815', fresh: '9999999816', repeated: '9999999817', revenueRange: '9999999818',
};
const ALL_NIPS = Object.values(NIP);
let tenantId, otherTenantId, adminToken;

async function ensureTenant(name, slug) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [name, slug],
  );
  return tenant.id;
}

async function removeTestRows() {
  const tenants = [tenantId, otherTenantId];
  await db.query('DELETE FROM prospect_companies WHERE tenant_id = ANY($1) AND nip = ANY($2)', [tenants, ALL_NIPS]);
  await db.query(
    `DELETE FROM crm_leads WHERE tenant_id = ANY($1) AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = ANY($2)`, [tenants, ALL_NIPS],
  );
  await db.query(
    `DELETE FROM crm_partners WHERE tenant_id = ANY($1) AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = ANY($2)`, [tenants, ALL_NIPS],
  );
}

function importCsv(lines) {
  return request(app)
    .post('/api/admin/prospects/import')
    .set('Authorization', `Bearer ${adminToken}`)
    .attach('file', Buffer.from(lines.join('\n'), 'utf8'), 'import.csv');
}

beforeAll(async () => {
  tenantId = await ensureTenant('Prospects Import Lookup Tenant', TENANT_SLUG);
  otherTenantId = await ensureTenant('Prospects Import Lookup Other Tenant', OTHER_TENANT_SLUG);
  await db.query('DELETE FROM users WHERE email = $1', [ADMIN_EMAIL]);
  const { rows: [admin] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, tenant_id) VALUES ($1, 'Admin', 'User', TRUE, $2) RETURNING *`,
    [ADMIN_EMAIL, tenantId],
  );
  adminToken = signAccessToken(admin);
});

beforeEach(removeTestRows);
afterAll(removeTestRows);

describe('import skips companies that are already in the CRM', () => {
  test('a Lead is found whether its NIP is stored plain or with separators', async () => {
    await db.query(`INSERT INTO crm_leads (tenant_id, company, nip) VALUES ($1, 'Lead Plain', $2)`, [tenantId, NIP.leadPlain]);
    await db.query(`INSERT INTO crm_leads (tenant_id, company, nip) VALUES ($1, 'Lead Formatted', '999-999-98-12')`, [tenantId]);

    const res = await importCsv([
      'BAZA,NIP,Nazwa',
      `zz-lookup,${NIP.leadPlain},Lead Plain`,
      'zz-lookup,PL 999 999 98 12,Lead Formatted',
      `zz-lookup,${NIP.fresh},Nowa Firma`,
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 1, skipped_in_crm: 2, errors: 0, total: 3 });
    expect(res.body.in_crm.map(r => r.nip).sort()).toEqual([NIP.leadPlain, NIP.leadFormatted]);
    expect(res.body.in_crm.find(r => r.nip === NIP.leadFormatted)).toMatchObject({ row: 3, existsAs: 'lead', existingName: 'Lead Formatted' });
  });

  test('a Partner is found, and a Lead wins when the NIP is both', async () => {
    await db.query(`INSERT INTO crm_partners (tenant_id, company, status, nip) VALUES ($1, 'Partner Only', 'active', $2)`, [tenantId, NIP.partner]);
    await db.query(`INSERT INTO crm_partners (tenant_id, company, status, nip) VALUES ($1, 'Partner Twin', 'active', $2)`, [tenantId, NIP.leadAndPartner]);
    await db.query(`INSERT INTO crm_leads (tenant_id, company, nip) VALUES ($1, 'Lead Twin', $2)`, [tenantId, NIP.leadAndPartner]);

    const res = await importCsv([
      'BAZA,NIP,Nazwa',
      `zz-lookup,${NIP.partner},Partner Only`,
      `zz-lookup,${NIP.leadAndPartner},Twin`,
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 0, skipped_in_crm: 2 });
    expect(res.body.in_crm.find(r => r.nip === NIP.partner)).toMatchObject({ existsAs: 'partner', existingName: 'Partner Only' });
    expect(res.body.in_crm.find(r => r.nip === NIP.leadAndPartner)).toMatchObject({ existsAs: 'lead', existingName: 'Lead Twin' });
  });

  test('a Lead of another tenant does not block the import', async () => {
    await db.query(`INSERT INTO crm_leads (tenant_id, company, nip) VALUES ($1, 'Foreign Lead', $2)`, [otherTenantId, NIP.otherTenantLead]);

    const res = await importCsv(['BAZA,NIP,Nazwa', `zz-lookup,${NIP.otherTenantLead},Firma`]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 1, skipped_in_crm: 0 });
    const { rows } = await db.query('SELECT tenant_id FROM prospect_companies WHERE nip = $1', [NIP.otherTenantLead]);
    expect(rows.map(r => r.tenant_id)).toEqual([tenantId]);
  });

  test('a NIP repeated in the file is reported on every row it appears in', async () => {
    await db.query(`INSERT INTO crm_leads (tenant_id, company, nip) VALUES ($1, 'Repeated Lead', $2)`, [tenantId, NIP.repeated]);

    const res = await importCsv([
      'BAZA,NIP,Nazwa',
      `zz-lookup,${NIP.repeated},Raz`,
      `zz-lookup,${NIP.fresh},Nowa Firma`,
      `zz-lookup,${NIP.repeated},Dwa`,
    ]);

    expect(res.body).toMatchObject({ added: 1, skipped_in_crm: 2 });
    expect(res.body.in_crm.map(r => r.row)).toEqual([2, 4]);
  });

  test('a file without a single valid NIP still returns row errors, not a crash', async () => {
    const res = await importCsv(['BAZA,NIP,Nazwa', 'zz-lookup,123,Za krótki', 'zz-lookup,,Pusty']);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 0, skipped_in_crm: 0, errors: 2, total: 2 });
  });
});

describe('import — revenue written as a range', () => {
  test('"5 do 15" keeps the lower bound instead of gluing the digits into 515', async () => {
    const res = await importCsv(['BAZA;NIP;Nazwa;obrot', `zz-lookup;${NIP.revenueRange};Firma;5 do 15`]);

    expect(res.body).toMatchObject({ added: 1 });
    const { rows } = await db.query('SELECT annual_revenue FROM prospect_companies WHERE tenant_id = $1 AND nip = $2', [tenantId, NIP.revenueRange]);
    expect(Number(rows[0].annual_revenue)).toBe(5);
  });

  test('a plain amount with thousands separators is unchanged', async () => {
    const res = await importCsv(['BAZA;NIP;Nazwa;obrot', `zz-lookup;${NIP.fresh};Firma;12 500 000`]);

    expect(res.body).toMatchObject({ added: 1 });
    const { rows } = await db.query('SELECT annual_revenue FROM prospect_companies WHERE tenant_id = $1 AND nip = $2', [tenantId, NIP.fresh]);
    expect(Number(rows[0].annual_revenue)).toBe(12500000);
  });
});
