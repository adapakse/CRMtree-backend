'use strict';

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

const tenants = [];

async function createTenantWithSources(label, sources) {
  const slug = `zz-lead-sources-${label}-${Date.now()}`;
  const { rows: [tenant] } = await db.query('INSERT INTO tenants (name, slug) VALUES ($1,$1) RETURNING id', [slug]);
  await db.query(`INSERT INTO app_settings (tenant_id, key, value, value_type, label)
    VALUES ($1, 'crm_lead_sources', $2, 'json', 'Lead sources')`, [tenant.id, JSON.stringify(sources)]);
  const { rows: [user] } = await db.query(`INSERT INTO users
    (tenant_id, email, first_name, last_name, is_active, is_admin, crm_role)
    VALUES ($1,$2,'Sources','Test',true,false,'salesperson') RETURNING *`, [tenant.id, `${label}-${tenant.id}@sources.test`]);
  tenants.push(tenant.id);
  return signAccessToken(user);
}

afterAll(async () => {
  await db.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [tenants]);
  await db.query('DELETE FROM app_settings WHERE tenant_id = ANY($1::uuid[])', [tenants]);
  await db.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
});

test('each tenant reads its own lead sources dictionary', async () => {
  const firstToken = await createTenantWithSources('first', [{ value: 'Trade fair', label: 'Trade fair', group: null }]);
  const secondToken = await createTenantWithSources('second', [{ value: 'Webinar', label: 'Webinar', group: null }]);

  const first = await request(app).get('/api/crm/leads/sources').set('Authorization', `Bearer ${firstToken}`);
  const second = await request(app).get('/api/crm/leads/sources').set('Authorization', `Bearer ${secondToken}`);

  expect(first.status).toBe(200);
  expect(first.body.map(source => source.value)).toEqual(['Trade fair']);
  expect(second.status).toBe(200);
  expect(second.body.map(source => source.value)).toEqual(['Webinar']);
});
