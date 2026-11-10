'use strict';

const request = require('supertest');
const app     = require('../app');
const db      = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

// A tenant whose DWH prefix points at tables that were never created.
const SLUG    = 'zz-dwh-missing-test';
const DWH_PFX = 'zz_dwh_missing_test';

let tenantId;
let adminToken;

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active, dwh_schema_prefix)
     VALUES ('DWH Missing Test Tenant', $1, TRUE, $2)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, dwh_schema_prefix = $2
     RETURNING id`,
    [SLUG, DWH_PFX],
  );
  tenantId = tenant.id;

  await db.query(`DROP TABLE IF EXISTS dwh.${DWH_PFX}_sales`);
  await db.query(`DROP TABLE IF EXISTS dwh.${DWH_PFX}_partner`);
  await db.query(`DELETE FROM crm_partner_groups WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_features    WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@dwh-missing-test.crmtree.local'`);

  const { rows: [admin] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id)
     VALUES ('admin@dwh-missing-test.crmtree.local','Admin','NoDwh',TRUE,TRUE,$1) RETURNING *`,
    [tenantId],
  );
  adminToken = signAccessToken(admin);

  await db.query(
    `INSERT INTO crm_partner_groups (name, tenant_id) VALUES ('CRM only group', $1)`,
    [tenantId],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM crm_partner_groups WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_features    WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@dwh-missing-test.crmtree.local'`);
});

const get  = (url) => request(app).get(url).set('Authorization', `Bearer ${adminToken}`);
const post = (url) => request(app).post(url).set('Authorization', `Bearer ${adminToken}`);

describe('tenant without DWH tables', () => {
  test('GET /api/crm/churn returns 200 with no rows', async () => {
    const res = await get('/api/crm/churn');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body).toHaveProperty('settings');
  });

  test('POST /api/crm/churn/compute computes nothing', async () => {
    const res = await post('/api/crm/churn/compute');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ computed: 0 });
  });

  test('POST /api/crm/churn/generate creates nothing', async () => {
    const res = await post('/api/crm/churn/generate');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, skipped: 0, total: 0 });
  });

  test.each([
    '/api/crm/sales-data',
    '/api/crm/sales-data/summary',
    '/api/crm/sales-data/by-partner',
    '/api/crm/sales-data/by-salesperson',
    '/api/crm/sales-data/by-product',
    '/api/crm/sales-data/partners',
  ])('GET %s returns an empty list', async (url) => {
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /api/crm/sales-data/report returns empty sections', async () => {
    const res = await get('/api/crm/sales-data/report?period_from=2026-01&period_to=2026-03');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kpi: {}, prev_kpi: null, trend: [], by_partner: [], by_product: [], by_rep: [],
    });
  });

  test('GET /api/crm/sales-data/analytics returns empty periods', async () => {
    const res = await get('/api/crm/sales-data/analytics?period_from=2026-01&period_to=2026-03&compare_from=2025-01&compare_to=2025-03');
    expect(res.status).toBe(200);
    expect(res.body.a).toMatchObject({ trend: [], by_partner: [], by_product: [], by_rep: [] });
    expect(res.body.b).toMatchObject({ trend: [], by_partner: [] });
  });

  test('GET /api/crm/groups still lists CRM groups', async () => {
    const res = await get('/api/crm/groups');
    expect(res.status).toBe(200);
    expect(res.body.map(g => g.name)).toEqual(['CRM only group']);
  });
});
