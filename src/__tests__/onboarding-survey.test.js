'use strict';

// Onboarding survey — access control (tenant admin vs regular user vs super
// admin), tenant scoping, and the secret contract: the tenant admin never
// gets a secret back, a blank secret keeps the saved one, and only a super
// admin reads the plaintext.

const request = require('supertest');
const app     = require('../app');
const db      = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

const SLUG         = 'zz-survey-test';
const OTHER_SLUG   = 'zz-survey-test-other';
const EMAIL_DOMAIN = '@survey-test.crmtree.local';

let tenantId, otherTenantId;
let adminTok, userTok, superTok, otherAdminTok;

async function mkTenant(slug) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active)
     VALUES ($1, $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL
     RETURNING id`,
    [slug],
  );
  return tenant.id;
}

async function mkUser(local, ownerTenantId, { admin = false, superAdmin = false } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_super_admin, is_active, tenant_id)
     VALUES ($1, $2, 'Test', $3, $4, TRUE, $5) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, admin, superAdmin, ownerTenantId],
  );
  return user;
}

async function cleanup() {
  await db.query(`DELETE FROM tenant_onboarding_surveys WHERE tenant_id = ANY($1)`, [[tenantId, otherTenantId]]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%${EMAIL_DOMAIN}`]);
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  tenantId      = await mkTenant(SLUG);
  otherTenantId = await mkTenant(OTHER_SLUG);
  await cleanup();

  adminTok      = signAccessToken(await mkUser('admin', tenantId, { admin: true }));
  userTok       = signAccessToken(await mkUser('user', tenantId));
  superTok      = signAccessToken(await mkUser('super', tenantId, { admin: true, superAdmin: true }));
  otherAdminTok = signAccessToken(await mkUser('other', otherTenantId, { admin: true }));
});

afterAll(async () => {
  await cleanup();
  await db.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantId, otherTenantId]]);
  await db.pool.end();
});

describe('tenant admin: /api/admin/onboarding-survey', () => {
  test('non-admin user is rejected', async () => {
    const res = await request(app).get('/api/admin/onboarding-survey').set(auth(userTok));
    expect(res.status).toBe(403);
  });

  test('empty survey reads as not_started', async () => {
    const res = await request(app).get('/api/admin/onboarding-survey').set(auth(adminTok));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'not_started', answers: {}, configured_secret_keys: [] });
  });

  test('draft save stores answers, hides the secret value', async () => {
    const res = await request(app).put('/api/admin/onboarding-survey').set(auth(adminTok)).send({
      answers: { contact_name: 'Jan Kowalski', modules: ['leads', 'whatsapp'] },
      secrets: { whatsapp_access_token: 'EAAG-secret-1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
    expect(res.body.answers).toEqual({ contact_name: 'Jan Kowalski', modules: ['leads', 'whatsapp'] });
    expect(res.body.configured_secret_keys).toEqual(['whatsapp_access_token']);
    expect(res.body.secrets).toBeUndefined();
  });

  test('secret is stored encrypted, not in plaintext', async () => {
    const { rows: [row] } = await db.query(
      `SELECT encrypted_secrets FROM tenant_onboarding_surveys WHERE tenant_id = $1`, [tenantId],
    );
    expect(row.encrypted_secrets.whatsapp_access_token).toBeTruthy();
    expect(JSON.stringify(row.encrypted_secrets)).not.toContain('EAAG-secret-1');
  });

  test('submit marks the survey submitted; blank and masked secrets keep the saved one', async () => {
    const res = await request(app).post('/api/admin/onboarding-survey/submit').set(auth(adminTok)).send({
      answers: { contact_name: 'Jan Kowalski' },
      secrets: { whatsapp_access_token: '', pbx_note_secret: '••••••••' },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
    expect(res.body.submitted_at).toBeTruthy();
    expect(res.body.configured_secret_keys).toEqual(['whatsapp_access_token']);
  });

  test('a later draft save does not un-submit the survey', async () => {
    const res = await request(app).put('/api/admin/onboarding-survey').set(auth(adminTok)).send({
      answers: { contact_name: 'Jan Nowak' },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
    expect(res.body.answers.contact_name).toBe('Jan Nowak');
  });

  test('malformed answers are rejected', async () => {
    const badKey = await request(app).put('/api/admin/onboarding-survey').set(auth(adminTok))
      .send({ answers: { 'Bad Key': 'x' } });
    expect(badKey.status).toBe(400);

    const badValue = await request(app).put('/api/admin/onboarding-survey').set(auth(adminTok))
      .send({ answers: { contact_name: { nested: true } } });
    expect(badValue.status).toBe(400);
  });

  test("another tenant's admin sees only their own (empty) survey", async () => {
    const res = await request(app).get('/api/admin/onboarding-survey').set(auth(otherAdminTok));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_started');
  });
});

describe('super admin: /api/admin/tenants/:id/onboarding-survey', () => {
  test('tenant admin is rejected', async () => {
    const res = await request(app).get(`/api/admin/tenants/${tenantId}/onboarding-survey`).set(auth(adminTok));
    expect(res.status).toBe(403);
  });

  test('super admin reads answers and decrypted secrets', async () => {
    const res = await request(app).get(`/api/admin/tenants/${tenantId}/onboarding-survey`).set(auth(superTok));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
    expect(res.body.answers.contact_name).toBe('Jan Nowak');
    expect(res.body.secrets).toEqual({ whatsapp_access_token: 'EAAG-secret-1' });
  });
});
