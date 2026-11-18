'use strict';

// E-mail campaigns (SendGrid, per-tenant account): tenant isolation of campaigns,
// previews and person consents; the tenant SendGrid settings never leak the API key;
// the Event Webhook resolves the tenant from its token and checks the signature.
// SendGrid itself is never called — global fetch is replaced where needed.

const crypto  = require('crypto');
const request = require('supertest');
const app      = require('../app');
const db       = require('../config/database');
const sendgrid = require('../services/sendgridService');
const { processEvents } = require('../routes/sendgrid-webhook');
const { signAccessToken } = require('../middleware/auth');

const DOMAIN = '@campaigns-test.crmtree.local';
const SLUG_A = 'zz-campaigns-a';
const SLUG_B = 'zz-campaigns-b';
const SLUG_OFF = 'zz-campaigns-off';
const FAKE_API_KEY = 'SG.test-only-not-a-real-key-abcd1234WXYZ';
const SHARED_EMAIL = 'shared.person@example.com';
const CONSENT_TYPES = JSON.stringify([
  { key: 'email newsletter', label: 'Newsletter e-mail' },
  { key: 'telefon', label: 'Kontakt telefoniczny' },
]);

let A, B, OFF;   // { id, adminTok, salesTok, salesId, adminId }
const realFetch = global.fetch;

async function mkTenant(slug, featureOn) {
  const { rows: [t] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
    [`Campaigns ${slug}`, slug],
  );
  await db.query(
    `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'email_campaigns', $2)
     ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`,
    [t.id, featureOn],
  );
  await db.query(
    `INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
     VALUES ($1, 'crm.consent_types', $2, 'Typy zgód', '', 'string', 'global')
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [t.id, CONSENT_TYPES],
  );
  const mk = async (local, admin, role) => (await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, tenant_id)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5) RETURNING *`,
    [`${local}.${slug}${DOMAIN}`, local, admin, role, t.id],
  )).rows[0];
  const admin = await mk('admin', true, 'sales_manager');
  const sales = await mk('sales', false, 'salesperson');
  return { id: t.id, adminId: admin.id, salesId: sales.id, adminTok: signAccessToken(admin), salesTok: signAccessToken(sales) };
}

async function cleanup() {
  const { rows } = await db.query(`SELECT id FROM tenants WHERE slug = ANY($1)`, [[SLUG_A, SLUG_B, SLUG_OFF]]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  await db.query(`DELETE FROM crm_email_campaigns WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM crm_contact_consents WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM tenant_sendgrid_config WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM crm_lead_activities WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM crm_partner_activities WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM crm_lead_contacts WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM crm_leads WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM crm_partners WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM user_feature_access WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM audit_logs WHERE user_email LIKE $1`, [`%${DOMAIN}`]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  await db.query(`DELETE FROM app_settings WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM tenant_features WHERE tenant_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM tenants WHERE id = ANY($1)`, [ids]);
}

async function mkLead(tenant, company, email) {
  const { rows: [l] } = await db.query(
    `INSERT INTO crm_leads (company, stage, email, contact_name, assigned_to, created_by, tenant_id)
     VALUES ($1, 'new', $2, 'Jan Kowalski', $3, $3, $4) RETURNING id`,
    [company, email, tenant.salesId, tenant.id],
  );
  return l.id;
}

async function grantConsent(tenant, email, key = 'email newsletter', value = 'granted') {
  await db.query(
    `INSERT INTO crm_contact_consents (tenant_id, email, consent_key, value, source)
     VALUES ($1, $2, $3, $4, 'crm')
     ON CONFLICT (tenant_id, email, consent_key) DO UPDATE SET value = EXCLUDED.value`,
    [tenant.id, email, key, value],
  );
}

const auth = tok => ({ Authorization: `Bearer ${tok}` });

async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise(r => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  await cleanup();
  A = await mkTenant(SLUG_A, true);
  B = await mkTenant(SLUG_B, true);
  OFF = await mkTenant(SLUG_OFF, false);
});

afterAll(async () => {
  global.fetch = realFetch;
  await cleanup();
});

afterEach(() => { global.fetch = realFetch; });

// ── Access ───────────────────────────────────────────────────────────────────
describe('access', () => {
  it('blocks a tenant without the module', async () => {
    const res = await request(app).get('/api/crm/email-campaigns').set(auth(OFF.adminTok));
    expect(res.status).toBe(403);
  });

  it('needs a personal grant for non-admins; admin always passes', async () => {
    expect((await request(app).get('/api/crm/email-campaigns').set(auth(A.salesTok))).status).toBe(403);
    expect((await request(app).get('/api/crm/email-campaigns').set(auth(A.adminTok))).status).toBe(200);
    await db.query(
      `INSERT INTO user_feature_access (tenant_id, user_id, feature_name, granted) VALUES ($1, $2, 'email_campaigns', TRUE)
       ON CONFLICT (user_id, feature_name) DO UPDATE SET granted = TRUE`, [A.id, A.salesId]);
    expect((await request(app).get('/api/crm/email-campaigns').set(auth(A.salesTok))).status).toBe(200);
  });

  it('lets only a tenant admin read or change the SendGrid settings', async () => {
    expect((await request(app).get('/api/crm/email-campaigns/sendgrid/settings').set(auth(A.salesTok))).status).toBe(403);
    expect((await request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(A.salesTok))
      .send({ from_email: 'x@example.com' })).status).toBe(403);
    expect((await request(app).post('/api/crm/email-campaigns/sendgrid/test').set(auth(A.salesTok))).status).toBe(403);
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────
describe('SendGrid settings', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  it('saves the key encrypted and never returns it', async () => {
    const put = await request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(B.adminTok)).send({
      api_key: FAKE_API_KEY, from_email: 'Marketing@Example.com', from_name: 'Zespół B', asm_group_id: '123',
    });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain(FAKE_API_KEY);
    expect(put.body).toMatchObject({
      has_api_key: true, api_key_hint: 'WXYZ', from_email: 'marketing@example.com', from_name: 'Zespół B',
      asm_group_id: 123, has_webhook_public_key: false,
    });
    expect(put.body.webhook_url).toMatch(/\/api\/webhooks\/sendgrid\/[a-f0-9]{64}$/);
    expect(put.body.consent_key).toBe('email newsletter');
    expect(put.body.consent_types).toEqual([
      { key: 'email newsletter', label: 'Newsletter e-mail' }, { key: 'telefon', label: 'Kontakt telefoniczny' },
    ]);

    const { rows: [row] } = await db.query(`SELECT * FROM tenant_sendgrid_config WHERE tenant_id = $1`, [B.id]);
    expect(JSON.stringify(row)).not.toContain(FAKE_API_KEY);
    expect(row.api_key_encrypted).toBeTruthy();

    const get = await request(app).get('/api/crm/email-campaigns/sendgrid/settings').set(auth(B.adminTok));
    expect(get.status).toBe(200);
    expect(JSON.stringify(get.body)).not.toContain(FAKE_API_KEY);
    expect(get.body.webhook_url).toBe(put.body.webhook_url);

    const status = await request(app).get('/api/crm/email-campaigns/sendgrid/status').set(auth(B.adminTok));
    expect(JSON.stringify(status.body)).not.toContain(FAKE_API_KEY);
    expect(status.body).toMatchObject({
      configured: true, missing: [], from_email: 'marketing@example.com', from_name: 'Zespół B', asm_group_id: 123,
      webhook_signed: false, max_recipients: expect.any(Number), can_send_large: true,
      consent_key: 'email newsletter', consent_label: 'Newsletter e-mail',
    });
  });

  it('keeps the key and token when the key is left out, removes it on null', async () => {
    const before = (await request(app).get('/api/crm/email-campaigns/sendgrid/settings').set(auth(B.adminTok))).body;
    const keep = await request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(B.adminTok))
      .send({ from_email: 'marketing@example.com', asm_group_id: 123, webhook_public_key: publicKeyB64, consent_key: 'telefon' });
    expect(keep.status).toBe(200);
    expect(keep.body).toMatchObject({ has_api_key: true, api_key_hint: 'WXYZ', has_webhook_public_key: true, consent_key: 'telefon' });
    expect(keep.body.webhook_url).toBe(before.webhook_url);

    const removed = await request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(B.adminTok))
      .send({ api_key: null, from_email: 'marketing@example.com', asm_group_id: 123 });
    expect(removed.body).toMatchObject({ has_api_key: false, api_key_hint: null, has_webhook_public_key: true });
    const status = (await request(app).get('/api/crm/email-campaigns/sendgrid/status').set(auth(B.adminTok))).body;
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(['api_key']);
  });

  it('validates the body', async () => {
    const put = body => request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(B.adminTok)).send(body);
    expect((await put({ from_email: 'not-an-email' })).status).toBe(400);
    expect((await put({ from_email: 'a@example.com', asm_group_id: '12x' })).status).toBe(400);
    expect((await put({ from_email: 'a@example.com', webhook_public_key: 'bm90IGEga2V5' })).status).toBe(400);
    expect((await put({ from_email: 'a@example.com', consent_key: 'marketing_comm' })).status).toBe(400);
    const bad = await put({ from_email: 'not-an-email' });
    expect(bad.body).toEqual({ error: expect.any(String) });
  });

  it('does not show one tenant the settings of another', async () => {
    const res = await request(app).get('/api/crm/email-campaigns/sendgrid/settings').set(auth(A.adminTok));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ has_api_key: false, from_email: null, webhook_url: null });
  });

  it('tests the saved key against SendGrid', async () => {
    await request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(B.adminTok))
      .send({ api_key: FAKE_API_KEY, from_email: 'marketing@example.com', asm_group_id: 123 });
    let authHeader;
    global.fetch = jest.fn(async (url, opts) => {
      authHeader = opts.headers.Authorization;
      return { ok: true, status: 200, json: async () => ({ result: [{ id: 'd-' + 'a'.repeat(32), name: 'T', versions: [] }] }) };
    });
    const ok = await request(app).post('/api/crm/email-campaigns/sendgrid/test').set(auth(B.adminTok));
    expect(ok.body).toEqual({ ok: true, templates: 1 });
    expect(authHeader).toBe(`Bearer ${FAKE_API_KEY}`);

    global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
    const rejected = await request(app).post('/api/crm/email-campaigns/sendgrid/test').set(auth(B.adminTok));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toEqual(expect.any(String));

    const none = await request(app).post('/api/crm/email-campaigns/sendgrid/test').set(auth(A.adminTok));
    expect(none.status).toBe(400);
  });
});

describe('resolveConsent', () => {
  it('picks the saved key, then marketing_comm, then e-mail/newsletter, then the first type', () => {
    const types = [{ key: 'telefon', label: 'Telefon' }, { key: 'email newsletter', label: 'Newsletter' }];
    expect(sendgrid.resolveConsent(types, 'telefon').consent_key).toBe('telefon');
    expect(sendgrid.resolveConsent([...types, { key: 'marketing_comm', label: 'M' }], null).consent_key).toBe('marketing_comm');
    expect(sendgrid.resolveConsent(types, 'missing').consent_key).toBe('email newsletter');
    expect(sendgrid.resolveConsent([{ key: 'a', label: 'Zgoda na e-mail' }, { key: 'b', label: 'x' }], null).consent_key).toBe('a');
    expect(sendgrid.resolveConsent([{ key: 'x', label: 'X' }], null)).toEqual({ consent_key: 'x', consent_label: 'X' });
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────
describe('tenant isolation', () => {
  let campaignA;

  beforeAll(async () => {
    await mkLead(A, 'Firma A', SHARED_EMAIL);
    await mkLead(B, 'Firma B', SHARED_EMAIL);
    await grantConsent(A, SHARED_EMAIL);   // B has no consent for the same address
    const res = await request(app).post('/api/crm/email-campaigns').set(auth(A.adminTok))
      .send({ name: 'Kampania A', filter_criteria: { audience: 'leads' } });
    expect(res.status).toBe(201);
    campaignA = res.body;
  });

  it('keeps campaigns inside their tenant', async () => {
    expect(campaignA.tenant_id).toBe(A.id);
    expect(campaignA.estimated_recipients).toBe(1);
    const path = `/api/crm/email-campaigns/${campaignA.id}`;
    expect((await request(app).get(path).set(auth(B.adminTok))).status).toBe(404);
    expect((await request(app).put(path).set(auth(B.adminTok)).send({ name: 'Hijack' })).status).toBe(404);
    expect((await request(app).delete(path).set(auth(B.adminTok))).status).toBe(404);
    expect((await request(app).post(`${path}/archive`).set(auth(B.adminTok))).status).toBe(404);
    expect((await request(app).post(`${path}/duplicate`).set(auth(B.adminTok))).status).toBe(404);
    const bulk = await request(app).post('/api/crm/email-campaigns/bulk').set(auth(B.adminTok))
      .send({ action: 'archive', ids: [campaignA.id] });
    expect(bulk.body.done).toBe(0);

    const listB = await request(app).get('/api/crm/email-campaigns').set(auth(B.adminTok));
    expect(listB.body.items.map(c => c.id)).not.toContain(campaignA.id);
    const listA = await request(app).get('/api/crm/email-campaigns').set(auth(A.adminTok));
    expect(listA.body.items.map(c => c.id)).toContain(campaignA.id);
    const reqB = await request(app).get('/api/crm/email-campaigns/requesters').set(auth(B.adminTok));
    expect(reqB.body.every(u => u.display_name.endsWith('Test'))).toBe(true);
    expect(reqB.body.map(u => u.id)).not.toContain(A.adminId);
  });

  it('builds the preview from the tenant own leads and consents only', async () => {
    const preview = body => request(app).post('/api/crm/email-campaigns/preview').send(body);
    const a = await preview({ criteria: { audience: 'leads' } }).set(auth(A.adminTok));
    expect(a.body.to_send).toBe(1);
    expect(a.body.recipients.map(r => r.company)).toEqual(['Firma A']);

    const b = await preview({ criteria: { audience: 'leads' } }).set(auth(B.adminTok));
    expect(b.body.recipients.map(r => r.company)).toEqual(['Firma B']);
    expect(b.body.to_send).toBe(0);
    expect(b.body.recipients[0].reason).toBe('no_consent');

    const csv = await preview({ criteria: { source: 'csv', csv_emails: [SHARED_EMAIL] } }).set(auth(B.adminTok));
    expect(csv.body.recipients.map(r => r.company)).toEqual(['Firma B']);
  });

  it('returns filter options of the own tenant with the resolved consent', async () => {
    const res = await request(app).get('/api/crm/email-campaigns/filter-options').set(auth(B.adminTok));
    expect(res.status).toBe(200);
    expect(res.body.owners.map(o => o.id)).not.toContain(A.salesId);
    expect(res.body).toMatchObject({ consent_key: expect.any(String), consent_label: expect.any(String), company_sizes: [] });
  });

  it('keeps person consents inside their tenant', async () => {
    const { rows: [leadB] } = await db.query(`SELECT id FROM crm_leads WHERE tenant_id = $1`, [B.id]);
    const { rows: [leadA] } = await db.query(`SELECT id FROM crm_leads WHERE tenant_id = $1`, [A.id]);

    expect((await request(app).get(`/api/crm/consents/people/leads/${leadA.id}`).set(auth(B.adminTok))).status).toBe(404);
    expect((await request(app).put(`/api/crm/consents/people/leads/${leadA.id}`).set(auth(B.adminTok))
      .send({ email: SHARED_EMAIL, key: 'email newsletter', value: 'denied' })).status).toBe(404);

    const peopleB = await request(app).get(`/api/crm/consents/people/leads/${leadB.id}`).set(auth(B.adminTok));
    expect(peopleB.status).toBe(200);
    expect(peopleB.body).toHaveLength(1);
    expect(peopleB.body[0]).toMatchObject({ email: SHARED_EMAIL, is_main: true });
    expect(peopleB.body[0].consents.map(c => c.consent_key)).toEqual(['email newsletter', 'telefon']);
    expect(peopleB.body[0].consents[0].value).toBe('no_data');

    const noNote = await request(app).put(`/api/crm/consents/people/leads/${leadB.id}`).set(auth(B.adminTok))
      .send({ email: SHARED_EMAIL, key: 'email newsletter', value: 'granted' });
    expect(noNote.status).toBe(400);

    const saved = await request(app).put(`/api/crm/consents/people/leads/${leadB.id}`).set(auth(B.adminTok))
      .send({ email: SHARED_EMAIL, key: 'email newsletter', value: 'denied' });
    expect(saved.status).toBe(200);
    expect(saved.body[0].consents[0]).toMatchObject({ value: 'denied', source: 'crm' });

    const { rows } = await db.query(
      `SELECT tenant_id, value FROM crm_contact_consents WHERE email = $1 AND consent_key = 'email newsletter' AND tenant_id = ANY($2)
       ORDER BY value`, [SHARED_EMAIL, [A.id, B.id]]);
    expect(rows).toEqual([{ tenant_id: B.id, value: 'denied' }, { tenant_id: A.id, value: 'granted' }]);
  });

  it('lets a salesperson see only own companies', async () => {
    const { rows: [leadA] } = await db.query(`SELECT id FROM crm_leads WHERE tenant_id = $1`, [A.id]);
    const own = await request(app).get(`/api/crm/consents/people/leads/${leadA.id}`).set(auth(A.salesTok));
    expect(own.status).toBe(200);
    await db.query(`UPDATE crm_leads SET assigned_to = $2 WHERE id = $1`, [leadA.id, A.adminId]);
    const other = await request(app).get(`/api/crm/consents/people/leads/${leadA.id}`).set(auth(A.salesTok));
    expect(other.status).toBe(403);
    await db.query(`UPDATE crm_leads SET assigned_to = $2 WHERE id = $1`, [leadA.id, A.salesId]);
  });

  it('sends only to the tenant own recipients with tenant id in custom_args', async () => {
    await request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(A.adminTok))
      .send({ api_key: FAKE_API_KEY, from_email: 'a@example.com', asm_group_id: 7 });
    const templateId = 'd-' + 'b'.repeat(32);
    const sent = [];
    global.fetch = jest.fn(async (url, opts = {}) => {
      if (String(url).includes('/mail/send')) {
        sent.push(JSON.parse(opts.body));
        return { status: 202, headers: { get: () => 'msg-1' }, text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ id: templateId, name: 'Szablon', versions: [{ id: 'v1', active: 1, subject: 'S', updated_at: 'u1' }] }) };
    });
    const draft = await request(app).post('/api/crm/email-campaigns').set(auth(A.adminTok))
      .send({ name: 'Wysyłka A', sendgrid_template_id: templateId, filter_criteria: { audience: 'leads' } });
    const id = draft.body.id;
    expect((await request(app).post(`/api/crm/email-campaigns/${id}/send`).set(auth(A.adminTok))).status).toBe(409);   // not tested yet
    expect((await request(app).post(`/api/crm/email-campaigns/${id}/test-send`).set(auth(A.adminTok))).status).toBe(200);
    sent.length = 0;
    const res = await request(app).post(`/api/crm/email-campaigns/${id}/send`).set(auth(A.adminTok));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, queued: 1 });

    const status = await waitFor(async () => (await db.query(`SELECT status FROM crm_email_campaigns WHERE id = $1`, [id])).rows[0].status === 'sent');
    expect(status).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].personalizations).toHaveLength(1);
    expect(sent[0].personalizations[0].to).toEqual([{ email: SHARED_EMAIL }]);
    expect(sent[0].personalizations[0].custom_args).toMatchObject({ tenant_id: A.id, campaign_id: String(id) });
    const { rows: acts } = await db.query(
      `SELECT tenant_id, email_provider FROM crm_lead_activities WHERE type = 'marketing_email' AND tenant_id = ANY($1)`, [[A.id, B.id]]);
    expect(acts).toEqual([{ tenant_id: A.id, email_provider: 'sendgrid' }]);

    const resultsB = await request(app).get('/api/crm/email-campaigns/results').set(auth(B.adminTok));
    expect(resultsB.body.campaigns.map(c => c.id)).not.toContain(id);
    const resultsA = await request(app).get('/api/crm/email-campaigns/results').set(auth(A.adminTok));
    expect(resultsA.body.campaigns.map(c => c.id)).toContain(id);
  });
});

// ── Webhook ──────────────────────────────────────────────────────────────────
describe('SendGrid webhook', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  let tokenA, tokenB, campaignId, recipientId;

  const sign = (body, ts) => crypto.sign('sha256', Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString('base64');
  const tokenOf = url => url.split('/').pop();

  beforeAll(async () => {
    const a = await request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(A.adminTok))
      .send({ from_email: 'a@example.com', asm_group_id: 7 });
    tokenA = tokenOf(a.body.webhook_url);
    const b = await request(app).put('/api/crm/email-campaigns/sendgrid/settings').set(auth(B.adminTok))
      .send({ from_email: 'marketing@example.com', asm_group_id: 123, webhook_public_key: publicKeyB64 });
    tokenB = tokenOf(b.body.webhook_url);
    expect(tokenA).not.toBe(tokenB);

    const { rows: [lead] } = await db.query(`SELECT id FROM crm_leads WHERE tenant_id = $1 LIMIT 1`, [A.id]);
    const { rows: [c] } = await db.query(
      `INSERT INTO crm_email_campaigns (tenant_id, name, status, sent_at) VALUES ($1, 'Webhook A', 'sent', NOW()) RETURNING id`, [A.id]);
    campaignId = c.id;
    const { rows: [r] } = await db.query(
      `INSERT INTO crm_campaign_recipients (tenant_id, campaign_id, entity_type, lead_id, email, status, sent_at)
       VALUES ($1, $2, 'lead', $3, $4, 'sent', NOW()) RETURNING id`, [A.id, campaignId, lead.id, SHARED_EMAIL]);
    recipientId = r.id;
  });

  const event = (overrides = {}) => ({
    event: 'delivered', timestamp: Math.floor(Date.now() / 1000), sg_event_id: crypto.randomUUID(),
    tenant_id: A.id, campaign_id: String(campaignId), recipient_id: String(recipientId), crm: sendgrid.ENV_TAG, ...overrides,
  });
  const post = (token, body, headers = {}) => request(app).post(`/api/webhooks/sendgrid/${token}`)
    .set('Content-Type', 'application/json').set(headers).send(body);

  it('answers 404 for an unknown token', async () => {
    expect((await post('f'.repeat(64), '[]')).status).toBe(404);
    expect((await post('not-hex', '[]')).status).toBe(404);
  });

  it('accepts unsigned events while the tenant has no verification key', async () => {
    const res = await post(tokenA, JSON.stringify([event()]));
    expect(res.status).toBe(200);
    const delivered = await waitFor(async () =>
      (await db.query(`SELECT delivered_at FROM crm_campaign_recipients WHERE id = $1`, [recipientId])).rows[0].delivered_at);
    expect(delivered).toBeTruthy();
  });

  it('requires a valid signature once the tenant saved the key', async () => {
    const body = JSON.stringify([]);
    const ts = String(Math.floor(Date.now() / 1000));
    expect((await post(tokenB, body)).status).toBe(403);
    expect((await post(tokenB, body, {
      'X-Twilio-Email-Event-Webhook-Signature': sign('[1]', ts), 'X-Twilio-Email-Event-Webhook-Timestamp': ts,
    })).status).toBe(403);
    expect((await post(tokenB, body, {
      'X-Twilio-Email-Event-Webhook-Signature': sign(body, ts), 'X-Twilio-Email-Event-Webhook-Timestamp': ts,
    })).status).toBe(200);
  });

  it('ignores events of another tenant, campaign or environment', async () => {
    await processEvents(B.id, [event({ event: 'unsubscribe' })]);                            // token of B, event of A
    await processEvents(A.id, [event({ event: 'unsubscribe', tenant_id: B.id })]);           // claims tenant B
    await processEvents(A.id, [event({ event: 'unsubscribe', campaign_id: '999999999' })]);  // wrong campaign
    await processEvents(A.id, [event({ event: 'unsubscribe', crm: 'other-env.example' })]);
    const { rows } = await db.query(`SELECT status FROM crm_campaign_recipients WHERE id = $1`, [recipientId]);
    expect(rows[0].status).not.toBe('unsubscribed');
    const { rows: consent } = await db.query(
      `SELECT value FROM crm_contact_consents WHERE tenant_id = $1 AND email = $2 AND consent_key = 'email newsletter'`, [A.id, SHARED_EMAIL]);
    expect(consent[0].value).toBe('granted');
  });

  it('withdraws the campaign consent of that person on unsubscribe, once per event id', async () => {
    const e = event({ event: 'group_unsubscribe' });
    await processEvents(A.id, [e, e]);
    const { rows: [r] } = await db.query(`SELECT status FROM crm_campaign_recipients WHERE id = $1`, [recipientId]);
    expect(r.status).toBe('unsubscribed');
    const { rows: consent } = await db.query(
      `SELECT tenant_id, value, source FROM crm_contact_consents WHERE email = $1 AND consent_key = 'email newsletter' AND tenant_id = ANY($2)
       ORDER BY tenant_id = $3 DESC`, [SHARED_EMAIL, [A.id, B.id], A.id]);
    expect(consent[0]).toMatchObject({ tenant_id: A.id, value: 'denied', source: 'sendgrid_unsubscribe' });
    expect(consent[1]).toMatchObject({ tenant_id: B.id, value: 'denied', source: 'crm' });   // untouched
    const { rows: acts } = await db.query(
      `SELECT count(*)::int AS n FROM crm_lead_activities WHERE tenant_id = $1 AND type = 'marketing_email' AND title LIKE 'Wypisał%'`, [A.id]);
    expect(acts[0].n).toBe(1);
  });
});
