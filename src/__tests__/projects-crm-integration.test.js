'use strict';

// Projects ↔ CRM: linking a project to a lead or a partner, project tasks on
// the lead / partner card, tasks assigned to a person ("my tasks", calendar),
// and reminders sent by the CRM reminder job.
//
// Multi-tenant: everything is created under one dedicated test tenant and
// cleaned up by tenant_id.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const { signAccessToken } = require('../middleware/auth');
const crmReminderService = require('../services/crmReminderService');
const projectCrmLinkService = require('../services/projectCrmLinkService');

const SLUG         = 'zz-projects-crm-test';
const EMAIL_DOMAIN = '@projects-crm-test.crmtree.local';

let tenantId;
let admin, pm, accountOwner, otherSalesperson, engineer, external;
let project, ownLeadId, foreignLeadId, partnerId;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);

async function mkUser(local, { isAdmin = false, role = null, canCreate = false, isExternal = false } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, tenant_id,
                        can_create_projects, is_external)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5, $6, $7) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, isAdmin, role, tenantId, canCreate, isExternal],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

async function mkLead(company, ownerId) {
  const { rows: [lead] } = await db.query(
    `INSERT INTO crm_leads (company, stage, assigned_to, created_by, tenant_id)
     VALUES ($1, 'new', $2, $2, $3) RETURNING id`,
    [company, ownerId, tenantId],
  );
  return lead.id;
}

async function cleanup() {
  await db.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_statuses WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_types WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_priorities WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM crm_leads WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM crm_partners WHERE tenant_id = $1', [tenantId]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

const setLink = (user, body) => api('put', `/api/projects/${project.id}/crm-link`, user).send(body);
const createTask = async (body) => {
  const res = await api('post', `/api/projects/${project.id}/tasks`, pm).send({ name: 'Zadanie', ...body });
  expect(res.status).toBe(201);
  return res.body;
};

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Projects CRM Test', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
  await db.query(
    `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', TRUE)
     ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE`,
    [tenantId],
  );
  await cleanup();

  admin            = await mkUser('cadmin', { isAdmin: true });
  pm               = await mkUser('cpm', { role: 'salesperson', canCreate: true });
  accountOwner     = await mkUser('cowner', { role: 'salesperson' });
  otherSalesperson = await mkUser('cother', { role: 'salesperson' });
  engineer         = await mkUser('cengineer');
  external         = await mkUser('cexternal', { isExternal: true });

  ownLeadId     = await mkLead('Lead PM-a', pm.id);
  foreignLeadId = await mkLead('Lead cudzy', accountOwner.id);
  const { rows: [partner] } = await db.query(
    `INSERT INTO crm_partners (company, status, manager_id, tenant_id)
     VALUES ('Partner Testowy', 'active', $1, $2) RETURNING id`,
    [accountOwner.id, tenantId],
  );
  partnerId = partner.id;

  project = (await api('post', '/api/projects', pm).send({ name: 'Wdrożenie Klienta' })).body;
  for (const member of [
    { user_id: engineer.id, role: 'internal_participant', access_level: 'full' },
    { user_id: external.id, role: 'external_participant', access_level: 'full' },
  ]) {
    await api('post', `/api/projects/${project.id}/members`, pm).send(member);
  }
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

beforeEach(async () => {
  await db.query('DELETE FROM project_tasks WHERE project_id = $1', [project.id]);
  await db.query('UPDATE projects SET lead_id = NULL, partner_id = NULL WHERE id = $1', [project.id]);
  jest.spyOn(emailUtil, 'sendProjectTaskAssigned').mockResolvedValue();
});

afterEach(() => jest.restoreAllMocks());

describe('linking a project', () => {
  test('PM links the project to a lead they can see, then to a partner instead', async () => {
    const toLead = await setLink(pm, { lead_id: ownLeadId });
    expect(toLead.status).toBe(200);
    expect(toLead.body).toMatchObject({ lead_id: ownLeadId, partner_id: null });

    const toPartner = await setLink(pm, { partner_ref: partnerId });
    expect(toPartner.body).toMatchObject({ lead_id: null, partner_id: partnerId });

    const detail = await api('get', `/api/projects/${project.id}`, pm);
    expect(detail.body.project).toMatchObject({ partner_id: partnerId, partner_name: 'Partner Testowy', lead_id: null });

    expect((await setLink(pm, {})).body).toMatchObject({ lead_id: null, partner_id: null });
  });

  test('a lead and a partner at once are rejected', async () => {
    expect((await setLink(pm, { lead_id: ownLeadId, partner_ref: partnerId })).status).toBe(400);
  });

  test('a lead outside the PM’s CRM scope cannot be linked', async () => {
    expect((await setLink(pm, { lead_id: foreignLeadId })).status).toBe(400);
    expect((await setLink(admin, { lead_id: foreignLeadId })).status).toBe(200);
  });

  test('a participant cannot link, and neither can a PM without CRM access', async () => {
    expect((await setLink(engineer, { lead_id: ownLeadId })).status).toBe(403);

    await api('patch', `/api/projects/${project.id}/members/${engineer.id}`, pm).send({ role: 'pm' });
    try {
      expect((await setLink(engineer, { lead_id: ownLeadId })).status).toBe(403);
    } finally {
      await api('patch', `/api/projects/${project.id}/members/${engineer.id}`, pm)
        .send({ role: 'internal_participant', access_level: 'full' });
    }
  });

  test('projects of a converted lead follow it to the partner', async () => {
    await setLink(pm, { lead_id: ownLeadId });
    await projectCrmLinkService.moveLeadProjectsToPartner({ tenantId, leadId: ownLeadId, partnerId });
    const detail = await api('get', `/api/projects/${project.id}`, pm);
    expect(detail.body.project).toMatchObject({ lead_id: null, partner_id: partnerId });
  });
});

describe('project tasks on the lead and partner card', () => {
  test('whoever can see the lead sees its projects and tasks, member or not', async () => {
    await setLink(admin, { lead_id: foreignLeadId });
    const task = await createTask({ name: 'Konfiguracja', assignee_ids: [engineer.id], end_date: '2026-11-14' });

    const res = await api('get', `/api/crm/leads/${foreignLeadId}/projects`, accountOwner);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // The account owner is not a project member: sees the tasks, cannot enter the project.
    expect(res.body[0]).toMatchObject({ id: project.id, key: project.key, status: 'open', can_open: false });
    const asAdmin = await api('get', `/api/crm/leads/${foreignLeadId}/projects`, admin);
    expect(asAdmin.body[0].can_open).toBe(true);
    expect(res.body[0].tasks).toEqual([
      expect.objectContaining({
        id: task.id, name: 'Konfiguracja', end_date: '2026-11-14', status_category: 'todo',
        assignees: [expect.objectContaining({ user_id: engineer.id })],
      }),
    ]);
  });

  test('someone who cannot see the lead gets nothing', async () => {
    await setLink(admin, { lead_id: foreignLeadId });
    expect((await api('get', `/api/crm/leads/${foreignLeadId}/projects`, otherSalesperson)).status).toBe(404);
    expect((await api('get', `/api/crm/leads/${foreignLeadId}/projects`, engineer)).status).toBe(403);
  });

  test('the partner card lists linked projects, open ones first', async () => {
    await setLink(pm, { partner_ref: partnerId });
    const closed = (await api('post', '/api/projects', pm).send({ name: 'Stary Projekt' })).body;
    await api('put', `/api/projects/${closed.id}/crm-link`, pm).send({ partner_ref: partnerId });
    await api('post', `/api/projects/${closed.id}/close`, pm);

    const res = await api('get', `/api/crm/partners/${partnerId}/projects`, otherSalesperson);
    expect(res.status).toBe(200);
    expect(res.body.map((linked) => linked.status)).toEqual(['open', 'closed']);
  });
});

describe('tasks assigned to a person', () => {
  test('by default returns my open tasks with their project', async () => {
    const mine = await createTask({ assignee_ids: [engineer.id], end_date: '2026-11-20' });
    await createTask({ assignee_ids: [pm.id] });

    const res = await api('get', '/api/projects/assigned-tasks', engineer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: mine.id, project_id: project.id, project_key: project.key, end_date: '2026-11-20' }),
    ]);
  });

  test('finished tasks are left out unless asked for', async () => {
    const { body: config } = await api('get', '/api/projects/config', pm);
    const done = config.statuses.find((status) => status.category === 'done');
    await createTask({ assignee_ids: [engineer.id], status_id: done.id });

    expect((await api('get', '/api/projects/assigned-tasks', engineer)).body).toHaveLength(0);
    expect((await api('get', '/api/projects/assigned-tasks?include_done=true', engineer)).body).toHaveLength(1);
  });

  test('another person’s tasks are visible only to project members and the admin', async () => {
    await createTask({ assignee_ids: [engineer.id] });
    const url = `/api/projects/assigned-tasks?assigned_to=${engineer.id}`;

    expect((await api('get', url, pm)).body).toHaveLength(1);
    expect((await api('get', url, admin)).body).toHaveLength(1);
    expect((await api('get', url, accountOwner)).body).toHaveLength(0);
    expect((await api('get', url, external)).body).toHaveLength(0);
  });
});

describe('reminders', () => {
  const reminderAtOf = async (taskId) => {
    const { rows: [row] } = await db.query(
      `SELECT to_char(reminder_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS local_time, reminder_sent
       FROM project_tasks WHERE id = $1`,
      [taskId],
    );
    return row;
  };

  test('a relative reminder fires at 09:00 Warsaw time and moves with the due date', async () => {
    const task = await createTask({ end_date: '2026-11-14', reminder_type: '1d_before' });
    expect((await reminderAtOf(task.id)).local_time).toBe('2026-11-13 09:00');

    await api('patch', `/api/projects/${project.id}/tasks/${task.id}`, pm).send({ end_date: '2026-11-20' });
    expect((await reminderAtOf(task.id)).local_time).toBe('2026-11-19 09:00');

    await api('patch', `/api/projects/${project.id}/tasks/${task.id}`, pm).send({ reminder_type: null });
    expect((await reminderAtOf(task.id)).local_time).toBeNull();
  });

  test('a custom reminder needs a date', async () => {
    const res = await api('post', `/api/projects/${project.id}/tasks`, pm)
      .send({ name: 'X', end_date: '2026-11-14', reminder_type: 'custom' });
    expect(res.status).toBe(400);
  });

  test('the reminder job emails every assignee once', async () => {
    const reminderSpy = jest.spyOn(emailUtil, 'sendProjectTaskReminder').mockResolvedValue();
    jest.spyOn(emailUtil, 'sendActivityReminder').mockResolvedValue();
    const task = await createTask({
      name: 'Import danych', assignee_ids: [engineer.id, external.id],
      end_date: '2026-11-14', reminder_type: 'custom', reminder_at: '2020-01-01T08:00:00Z',
    });

    await crmReminderService.sendDueReminders();
    const ourCalls = reminderSpy.mock.calls.filter(([args]) => args.taskId === task.id);
    expect(ourCalls.map(([args]) => args.to).sort()).toEqual([engineer.email, external.email].sort());
    expect(ourCalls[0][0]).toMatchObject({ taskName: 'Import danych', taskLabel: `${project.key}-${task.task_number}` });
    expect((await reminderAtOf(task.id)).reminder_sent).toBe(true);

    reminderSpy.mockClear();
    await crmReminderService.sendDueReminders();
    expect(reminderSpy.mock.calls.filter(([args]) => args.taskId === task.id)).toHaveLength(0);
  });
});
