'use strict';

// POST /api/crm/partners/:id/withdraw-onboarding — a Partner in onboarding goes
// back to the sales funnel: its Lead returns to the chosen stage (validated
// against the tenant's own lead stages) and the Partner is deleted.

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const leadStageSvc = require('../services/leadStageService');
const { signAccessToken } = require('../middleware/auth');

const SLUGS = ['zz-withdraw-onb-a', 'zz-withdraw-onb-b'];
const EMAIL_DOMAIN = '@withdraw-onb-test.crmtree.local';

let tenantA, tenantB;
let managerA, managerB, salespersonA;
let customStageKey;
const tokens = {};

const withdraw = (user, partnerId, body) =>
  request(app)
    .post(`/api/crm/partners/${partnerId}/withdraw-onboarding`)
    .set('Authorization', `Bearer ${tokens[user.id]}`)
    .send(body);

async function mkTenant(slug) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [slug],
  );
  return tenant.id;
}

async function mkUser(local, tenantId, role) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, tenant_id)
     VALUES ($1, $2, 'Test', FALSE, TRUE, $3, $4) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, role, tenantId],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

// A sales manager without a group is refused by loadCrmScope.
async function addToGroup(tenantId, userIds) {
  const { rows: [group] } = await db.query(
    `INSERT INTO group_profiles (name, display_name, tenant_id) VALUES ('WithdrawGroup', 'Withdraw Group', $1) RETURNING id`,
    [tenantId],
  );
  for (const userId of userIds) {
    await db.query(
      `INSERT INTO user_group_roles (user_id, group_id, access_level, tenant_id) VALUES ($1, $2, 'full', $3)`,
      [userId, group.id, tenantId],
    );
  }
}

// A lead converted to a partner in onboarding, as POST /crm/leads/:id/migrate leaves it.
async function mkOnboardingPartner(tenantId, ownerId, { status = 'onboarding', withLead = true } = {}) {
  const company = `Withdraw Co ${Math.random().toString(36).slice(2, 8)}`;
  let leadId = null;
  if (withLead) {
    const { rows: [lead] } = await db.query(
      `INSERT INTO crm_leads (company, stage, converted_at, close_date, assigned_to, created_by, tenant_id)
       VALUES ($1, 'onboarding', now(), '2026-01-15', $2, $2, $3) RETURNING id`,
      [company, ownerId, tenantId],
    );
    leadId = lead.id;
  }
  const { rows: [partner] } = await db.query(
    `INSERT INTO crm_partners (company, lead_id, status, onboarding_step, tenant_id)
     VALUES ($1, $2, $3, 0, $4) RETURNING id`,
    [company, leadId, status, tenantId],
  );
  await db.query(
    `INSERT INTO crm_onboarding_tasks (partner_id, step, title, created_by, tenant_id)
     VALUES ($1, 0, 'Kick-off call', $2, $3)`,
    [partner.id, ownerId, tenantId],
  );
  return { partnerId: partner.id, leadId };
}

const leadOf = async (leadId) =>
  (await db.query('SELECT stage, converted_at, close_date FROM crm_leads WHERE id = $1', [leadId])).rows[0];
const partnerExists = async (partnerId) =>
  (await db.query('SELECT 1 FROM crm_partners WHERE id = $1', [partnerId])).rows.length > 0;

async function cleanup() {
  const tenantIds = [tenantA, tenantB].filter(Boolean);
  await db.query('DELETE FROM projects WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM crm_partners WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM crm_leads WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM tenant_lead_stages WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM user_group_roles WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM group_profiles WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

beforeAll(async () => {
  tenantA = await mkTenant(SLUGS[0]);
  tenantB = await mkTenant(SLUGS[1]);
  await cleanup();

  managerA     = await mkUser('manager-a', tenantA, 'sales_manager');
  managerB     = await mkUser('manager-b', tenantB, 'sales_manager');
  salespersonA = await mkUser('sales-a', tenantA, 'salesperson');
  await addToGroup(tenantA, [managerA.id, salespersonA.id]);
  await addToGroup(tenantB, [managerB.id]);

  // Tenant A has its own funnel stage; tenant B keeps the defaults.
  customStageKey = (await leadStageSvc.addStage(tenantA, { label: 'Pilot wdrozenia' })).key;
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = ANY($1::text[])', [SLUGS]);
});

describe('access', () => {
  test("a manager of another tenant cannot withdraw the partner — 404, nothing changes", async () => {
    const { partnerId, leadId } = await mkOnboardingPartner(tenantA, managerA.id);

    const res = await withdraw(managerB, partnerId, { target_stage: 'qualification' });

    expect(res.status).toBe(404);
    expect(await partnerExists(partnerId)).toBe(true);
    expect((await leadOf(leadId)).stage).toBe('onboarding');
  });

  test('a salesperson cannot withdraw — 403', async () => {
    const { partnerId } = await mkOnboardingPartner(tenantA, salespersonA.id);

    const res = await withdraw(salespersonA, partnerId, { target_stage: 'qualification' });

    expect(res.status).toBe(403);
    expect(await partnerExists(partnerId)).toBe(true);
  });
});

describe('partner preconditions', () => {
  test("a partner that is no longer in 'onboarding' status — 409", async () => {
    const { partnerId, leadId } = await mkOnboardingPartner(tenantA, managerA.id, { status: 'active' });

    const res = await withdraw(managerA, partnerId, { target_stage: 'qualification' });

    expect(res.status).toBe(409);
    expect(await partnerExists(partnerId)).toBe(true);
    expect((await leadOf(leadId)).stage).toBe('onboarding');
  });

  test('a partner not created from a lead — 409', async () => {
    const { partnerId } = await mkOnboardingPartner(tenantA, managerA.id, { withLead: false });

    const res = await withdraw(managerA, partnerId, { target_stage: 'qualification' });

    expect(res.status).toBe(409);
    expect(await partnerExists(partnerId)).toBe(true);
  });
});

describe('target stage validation', () => {
  test.each([
    ['missing', undefined],
    ['unknown', 'no_such_stage'],
    ['a code-written conversion state', 'onboarding'],
    ['the archive state', 'archived'],
  ])('%s target stage — 400, nothing changes', async (_label, targetStage) => {
    const { partnerId, leadId } = await mkOnboardingPartner(tenantA, managerA.id);

    const res = await withdraw(managerA, partnerId, { target_stage: targetStage });

    expect(res.status).toBe(400);
    expect(await partnerExists(partnerId)).toBe(true);
    expect((await leadOf(leadId)).stage).toBe('onboarding');
  });

  test("another tenant's custom stage is not valid for this tenant", async () => {
    const { partnerId } = await mkOnboardingPartner(tenantB, managerB.id);

    const res = await withdraw(managerB, partnerId, { target_stage: customStageKey });

    expect(res.status).toBe(400);
    expect(await partnerExists(partnerId)).toBe(true);
  });
});

describe('successful withdrawal', () => {
  test('lead goes back to an open stage, partner and its onboarding tasks are deleted', async () => {
    const { partnerId, leadId } = await mkOnboardingPartner(tenantA, managerA.id);
    const { rows: [project] } = await db.query(
      `INSERT INTO projects (tenant_id, key, name, partner_id) VALUES ($1, 'WOB', 'Rollout', $2) RETURNING id`,
      [tenantA, partnerId],
    );

    const res = await withdraw(managerA, partnerId, { target_stage: 'qualification' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lead_id: leadId, stage: 'qualification' });
    expect(await leadOf(leadId)).toMatchObject({ stage: 'qualification', converted_at: null, close_date: null });
    expect(await partnerExists(partnerId)).toBe(false);
    const { rows: tasks } = await db.query('SELECT 1 FROM crm_onboarding_tasks WHERE partner_id = $1', [partnerId]);
    expect(tasks).toHaveLength(0);
    const { rows: [movedProject] } = await db.query('SELECT lead_id, partner_id FROM projects WHERE id = $1', [project.id]);
    expect(movedProject).toEqual({ lead_id: leadId, partner_id: null });
    const { rows: auditRows } = await db.query(
      `SELECT metadata FROM audit_logs WHERE action = 'crm_partner_onboarding_withdrawn' AND user_id = $1`,
      [managerA.id],
    );
    expect(auditRows.map(r => r.metadata.partner_id)).toContain(partnerId);
  });

  test('withdrawing to a closed stage sets close_date to today', async () => {
    const { partnerId, leadId } = await mkOnboardingPartner(tenantA, managerA.id);

    const res = await withdraw(managerA, partnerId, { target_stage: 'closed_lost' });

    expect(res.status).toBe(200);
    const { rows: [lead] } = await db.query(
      'SELECT stage, close_date = CURRENT_DATE AS closed_today FROM crm_leads WHERE id = $1', [leadId],
    );
    expect(lead).toEqual({ stage: 'closed_lost', closed_today: true });
  });

  test("the tenant's own custom stage is a valid target", async () => {
    const { partnerId, leadId } = await mkOnboardingPartner(tenantA, managerA.id);

    const res = await withdraw(managerA, partnerId, { target_stage: customStageKey });

    expect(res.status).toBe(200);
    expect((await leadOf(leadId)).stage).toBe(customStageKey);
    expect(await partnerExists(partnerId)).toBe(false);
  });
});
