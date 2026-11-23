'use strict';

// A tenant with a DWH prefix must always have its (possibly empty) DWH tables:
// queries read dwh.<prefix>_partner / _sales directly and a missing table was a 500
// on the partner onboarding list.

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');
const { ensureTenantDwhTables } = require('../utils/dwh');

const PREFIX = 'zz_ensure_dwh_test';
const TENANT_SLUG = 'zz-ensure-dwh-test';
const ADMIN_EMAIL = 'admin@zz-ensure-dwh-test.worktrips.com';

async function tableExists(name) {
  const { rows } = await db.query('SELECT to_regclass($1) IS NOT NULL AS found', [name]);
  return rows[0].found;
}

async function dropTestTables() {
  await db.query(`DROP TABLE IF EXISTS dwh.${PREFIX}_partner`);
  await db.query(`DROP TABLE IF EXISTS dwh.${PREFIX}_sales`);
}

async function hasTemplatePair() {
  return (await tableExists('dwh.crmtree_gold_partner')) && (await tableExists('dwh.crmtree_gold_sales'));
}

beforeEach(dropTestTables);
afterAll(async () => {
  await db.query(`DELETE FROM crm_partners WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = $1)`, [TENANT_SLUG]);
  await dropTestTables();
});

describe('ensureTenantDwhTables', () => {
  test('creates both tables with the structure of the template pair', async () => {
    if (!(await hasTemplatePair())) return; // an environment without any DWH tables has nothing to copy

    const result = await ensureTenantDwhTables(db, PREFIX);

    expect(result).toMatchObject({ created: true, copiedFrom: 'crmtree_gold' });
    expect(await tableExists(`dwh.${PREFIX}_partner`)).toBe(true);
    expect(await tableExists(`dwh.${PREFIX}_sales`)).toBe(true);
    const columnsOf = async (table) => (await db.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'dwh' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    )).rows;
    expect(await columnsOf(`${PREFIX}_partner`)).toEqual(await columnsOf('crmtree_gold_partner'));
    expect(await columnsOf(`${PREFIX}_sales`)).toEqual(await columnsOf('crmtree_gold_sales'));
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM dwh.${PREFIX}_partner`);
    expect(rows[0].n).toBe(0);
  });

  test('is a no-op when the tables already exist and never touches their rows', async () => {
    if (!(await hasTemplatePair())) return;
    await ensureTenantDwhTables(db, PREFIX);
    await db.query(`INSERT INTO dwh.${PREFIX}_partner (partner_id, name) VALUES (1, 'Existing')`);

    const second = await ensureTenantDwhTables(db, PREFIX);

    expect(second).toEqual({ created: false, reason: 'already_exist' });
    const { rows } = await db.query(`SELECT name FROM dwh.${PREFIX}_partner`);
    expect(rows).toEqual([{ name: 'Existing' }]);
  });

  test('creates only the missing table of a half-existing pair', async () => {
    if (!(await hasTemplatePair())) return;
    await db.query(`CREATE TABLE dwh.${PREFIX}_partner (LIKE dwh.crmtree_gold_partner INCLUDING ALL)`);

    await ensureTenantDwhTables(db, PREFIX);

    expect(await tableExists(`dwh.${PREFIX}_sales`)).toBe(true);
  });

  test('a tenant without a prefix gets nothing', async () => {
    expect(await ensureTenantDwhTables(db, null)).toEqual({ created: false, reason: 'no_prefix' });
    expect(await ensureTenantDwhTables(db, '')).toEqual({ created: false, reason: 'no_prefix' });
  });

  test.each([
    'Comparme', 'comp-arme', '1comparme', 'comparme; DROP TABLE tenants', 'comparme"', "x' OR '1'='1", 'a b',
  ])('rejects the prefix %j instead of building SQL from it', async (prefix) => {
    await expect(ensureTenantDwhTables(db, prefix)).rejects.toThrow('Invalid DWH prefix');
  });
});

describe('GET /api/crm/partners/onboarding for a tenant whose DWH tables were just created', () => {
  test('lists the tenant\'s onboarding partners with the data kept in the CRM', async () => {
    if (!(await hasTemplatePair())) return;
    const { rows: [tenant] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active, dwh_schema_prefix) VALUES ('Ensure DWH Test Tenant', $1, TRUE, $2)
       ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, dwh_schema_prefix = EXCLUDED.dwh_schema_prefix RETURNING id`,
      [TENANT_SLUG, PREFIX],
    );
    await db.query('DELETE FROM users WHERE email = $1', [ADMIN_EMAIL]);
    const { rows: [admin] } = await db.query(
      `INSERT INTO users (email, first_name, last_name, is_admin, tenant_id) VALUES ($1, 'Admin', 'User', TRUE, $2) RETURNING *`,
      [ADMIN_EMAIL, tenant.id],
    );
    await db.query(`DELETE FROM crm_partners WHERE tenant_id = $1`, [tenant.id]);
    await db.query(
      `INSERT INTO crm_partners (tenant_id, company, status, nip) VALUES ($1, 'Partner w onboardingu', 'onboarding', '9999999611')`,
      [tenant.id],
    );
    const token = signAccessToken(admin);

    const withoutTables = await request(app).get('/api/crm/partners/onboarding').set('Authorization', `Bearer ${token}`);
    expect(withoutTables.status).toBe(500); // the failure this change removes

    await ensureTenantDwhTables(db, PREFIX);
    const withTables = await request(app).get('/api/crm/partners/onboarding').set('Authorization', `Bearer ${token}`);

    expect(withTables.status).toBe(200);
    expect(withTables.body).toHaveLength(1);
    expect(withTables.body[0]).toMatchObject({ company: 'Partner w onboardingu', nip: '9999999611' });
  });
});
