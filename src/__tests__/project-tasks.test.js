'use strict';

// Project tasks — per-role permissions (content vs. status vs. structure),
// the status transition matrix, task visibility of external participants,
// hierarchy rules, custom field values, history and assignment emails.
//
// Multi-tenant: everything is created under one dedicated test tenant and
// cleaned up by tenant_id.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const { signAccessToken } = require('../middleware/auth');

const SLUG         = 'zz-project-tasks-test';
const EMAIL_DOMAIN = '@project-tasks-test.crmtree.local';

let tenantId;
let admin, pm, worker, reader, external, controller, outsider;
let project, config, statusByName;
let assignmentEmailSpy;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);
const tasksUrl = (suffix = '') => `/api/projects/${project.id}/tasks${suffix}`;

async function mkUser(local, { isAdmin = false, isExternal = false, canCreate = false } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id, is_external, can_create_projects)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5, $6) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, isAdmin, tenantId, isExternal, canCreate],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

async function cleanup() {
  await db.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_field_definitions WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_statuses WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_types WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_priorities WHERE tenant_id = $1', [tenantId]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

async function createTask(body = {}) {
  const res = await api('post', tasksUrl(), pm).send({ name: 'Zadanie', ...body });
  expect(res.status).toBe(201);
  return res.body;
}

const patchTask = (user, task, body) => api('patch', tasksUrl(`/${task.id}`), user).send(body);

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Project Tasks Test', $1, TRUE)
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

  admin      = await mkUser('tadmin', { isAdmin: true });
  pm         = await mkUser('tpm', { canCreate: true });
  worker     = await mkUser('tworker');
  reader     = await mkUser('treader');
  external   = await mkUser('texternal', { isExternal: true });
  controller = await mkUser('tcontroller');
  outsider   = await mkUser('toutsider');

  config = (await api('get', '/api/projects/config', admin)).body;
  statusByName = Object.fromEntries(config.statuses.map((status) => [status.name, status.id]));

  project = (await api('post', '/api/projects', pm).send({ name: 'Test Zadań' })).body;
  const members = [
    { user_id: worker.id,     role: 'internal_participant', access_level: 'full' },
    { user_id: reader.id,     role: 'internal_participant', access_level: 'read' },
    { user_id: external.id,   role: 'external_participant', access_level: 'full' },
    { user_id: controller.id, role: 'controller' },
  ];
  for (const member of members) {
    await api('post', `/api/projects/${project.id}/members`, pm).send(member);
  }
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

beforeEach(async () => {
  await db.query('DELETE FROM project_tasks WHERE project_id = $1', [project.id]);
  assignmentEmailSpy = jest.spyOn(emailUtil, 'sendProjectTaskAssigned').mockResolvedValue();
});

afterEach(() => jest.restoreAllMocks());

describe('creating tasks', () => {
  test('PM creates tasks numbered consecutively, starting in the first "todo" status', async () => {
    const first = await createTask();
    const second = await createTask();
    expect(second.task_number).toBe(first.task_number + 1);
    expect(first.status_id).toBe(statusByName['Do zrobienia']);
    expect(first.parent_task_id).toBeNull();
  });

  test('a participant cannot create a task', async () => {
    expect((await api('post', tasksUrl(), worker).send({ name: 'X' })).status).toBe(403);
  });

  test('assignees must be project members', async () => {
    const res = await api('post', tasksUrl(), pm).send({ name: 'X', assignee_ids: [outsider.id] });
    expect(res.status).toBe(400);
  });

  test('new assignees are notified by email, the assigning PM is not', async () => {
    await createTask({ assignee_ids: [worker.id, pm.id] });
    expect(assignmentEmailSpy).toHaveBeenCalledTimes(1);
    expect(assignmentEmailSpy.mock.calls[0][0]).toMatchObject({ to: worker.email, projectName: 'Test Zadań' });
  });

  test('end date before start date is rejected', async () => {
    const res = await api('post', tasksUrl(), pm)
      .send({ name: 'X', start_date: '2026-10-10', end_date: '2026-10-01' });
    expect(res.status).toBe(400);
  });
});

describe('editing content', () => {
  test('a full-access participant edits only tasks assigned to them', async () => {
    const mine = await createTask({ assignee_ids: [worker.id] });
    const notMine = await createTask();
    expect((await patchTask(worker, mine, { description: 'Postęp' })).status).toBe(200);
    expect((await patchTask(worker, notMine, { description: 'Postęp' })).status).toBe(403);
  });

  test('a read-access participant edits nothing, not even the status', async () => {
    const task = await createTask({ assignee_ids: [reader.id] });
    expect((await patchTask(reader, task, { description: 'X' })).status).toBe(403);
    expect((await patchTask(reader, task, { status_id: statusByName['W toku'] })).status).toBe(403);
  });

  test('only the PM changes assignees and the parent task', async () => {
    const task = await createTask({ assignee_ids: [worker.id] });
    expect((await patchTask(worker, task, { assignee_ids: [worker.id, reader.id] })).status).toBe(403);
    expect((await patchTask(pm, task, { assignee_ids: [worker.id, reader.id] })).status).toBe(200);
  });

  test('a task cannot be edited in a closed project', async () => {
    const task = await createTask();
    await api('post', `/api/projects/${project.id}/close`, pm);
    try {
      expect((await patchTask(pm, task, { name: 'Y' })).status).toBe(409);
      const detail = await api('get', tasksUrl(`/${task.id}`), pm);
      expect(detail.body.permissions).toEqual({
        can_edit_content: false, can_edit_structure: false, allowed_status_ids: [],
      });
    } finally {
      await api('post', `/api/projects/${project.id}/reopen`, pm);
    }
  });
});

describe('status transitions', () => {
  test('a participant moves an assigned task only along the matrix', async () => {
    const task = await createTask({ assignee_ids: [worker.id] });
    const detail = await api('get', tasksUrl(`/${task.id}`), worker);
    expect(detail.body.permissions.allowed_status_ids).toEqual([statusByName['W toku']]);

    expect((await patchTask(worker, task, { status_id: statusByName['Zakończone'] })).status).toBe(403);
    expect((await patchTask(worker, task, { status_id: statusByName['W toku'] })).status).toBe(200);
  });

  test('a controller changes status on any task along the matrix but never edits content', async () => {
    const task = await createTask({ status_id: statusByName['Do weryfikacji'] });
    expect((await patchTask(controller, task, { name: 'Zmiana' })).status).toBe(403);
    expect((await patchTask(controller, task, { status_id: statusByName['Zakończone'] })).status).toBe(200);
    expect((await patchTask(controller, task, { status_id: statusByName['W toku'] })).status).toBe(403);
  });

  test('the PM and the tenant admin move a task to any status', async () => {
    const task = await createTask();
    expect((await patchTask(pm, task, { status_id: statusByName['Zakończone'] })).status).toBe(200);
    expect((await patchTask(admin, task, { status_id: statusByName['Do zrobienia'] })).status).toBe(200);
  });
});

describe('visibility', () => {
  test('an external participant sees only tasks assigned to them', async () => {
    const assigned = await createTask({ assignee_ids: [external.id] });
    const other = await createTask({ assignee_ids: [worker.id] });

    const list = await api('get', tasksUrl(), external);
    expect(list.body.map((task) => task.id)).toEqual([assigned.id]);
    expect((await api('get', tasksUrl(`/${other.id}`), external)).status).toBe(404);
    expect((await patchTask(external, other, { status_id: statusByName['W toku'] })).status).toBe(404);
  });

  test('"mine" narrows the list for an internal participant who otherwise sees everything', async () => {
    const mine = await createTask({ assignee_ids: [worker.id] });
    await createTask();
    expect((await api('get', tasksUrl(), worker)).body).toHaveLength(2);
    const onlyMine = await api('get', tasksUrl('?mine=true'), worker);
    expect(onlyMine.body.map((task) => task.id)).toEqual([mine.id]);
  });

  test('a non-member cannot reach the tasks at all', async () => {
    expect((await api('get', tasksUrl(), outsider)).status).toBe(404);
  });
});

describe('hierarchy', () => {
  test('a task cannot become a child of its own descendant or of a task from another project', async () => {
    const parent = await createTask();
    const child = await createTask({ parent_task_id: parent.id });
    expect(child.parent_task_id).toBe(parent.id);

    expect((await patchTask(pm, parent, { parent_task_id: child.id })).status).toBe(400);
    expect((await patchTask(pm, parent, { parent_task_id: parent.id })).status).toBe(400);

    const otherProject = (await api('post', '/api/projects', pm).send({ name: 'Inny Projekt' })).body;
    const foreign = (await api('post', `/api/projects/${otherProject.id}/tasks`, pm).send({ name: 'Obce' })).body;
    expect((await patchTask(pm, child, { parent_task_id: foreign.id })).status).toBe(400);
  });
});

describe('custom fields', () => {
  let budget, stage;

  beforeAll(async () => {
    const withBudget = await api('post', '/api/admin/project-config/fields', admin)
      .send({ name: 'Budżet', field_type: 'money' });
    const withStage = await api('post', '/api/admin/project-config/fields', admin)
      .send({ name: 'Etap', field_type: 'list', options: ['Analiza', 'Wdrożenie'] });
    budget = withBudget.body.field_definitions.find((field) => field.name === 'Budżet');
    stage = withStage.body.field_definitions.find((field) => field.name === 'Etap');
    await api('put', `/api/projects/${project.id}/fields`, pm).send({
      fields: [{ field_definition_id: budget.id, is_required: true }, { field_definition_id: stage.id }],
    });
  });

  afterAll(async () => {
    await api('put', `/api/projects/${project.id}/fields`, pm).send({ fields: [] });
  });

  test('a required field must be filled when the task is created', async () => {
    const res = await api('post', tasksUrl(), pm).send({ name: 'Bez budżetu' });
    expect(res.status).toBe(400);
  });

  test('values are validated against the field type', async () => {
    const validBudget = { amount: 1500.5, currency: 'PLN' };
    const badCurrency = await api('post', tasksUrl(), pm)
      .send({ name: 'X', custom_values: { [budget.id]: { amount: 10, currency: 'zł' } } });
    expect(badCurrency.status).toBe(400);

    const badOption = await api('post', tasksUrl(), pm)
      .send({ name: 'X', custom_values: { [budget.id]: validBudget, [stage.id]: 'Nieznany' } });
    expect(badOption.status).toBe(400);

    const created = await api('post', tasksUrl(), pm)
      .send({ name: 'X', custom_values: { [budget.id]: validBudget, [stage.id]: 'Analiza' } });
    expect(created.status).toBe(201);
    expect(created.body.custom_values).toEqual({ [budget.id]: validBudget, [stage.id]: 'Analiza' });

    const cleared = await patchTask(pm, created.body, { custom_values: { [stage.id]: null } });
    expect(cleared.body.custom_values).toEqual({ [budget.id]: validBudget });
  });
});

describe('chat', () => {
  test('members talk in the project thread; a non-member cannot read it', async () => {
    const posted = await api('post', `/api/projects/${project.id}/messages`, reader).send({ body: 'Dzień dobry' });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ body: 'Dzień dobry', author_id: reader.id });

    const thread = await api('get', `/api/projects/${project.id}/messages`, external);
    expect(thread.body.map((message) => message.body)).toEqual(['Dzień dobry']);
    expect((await api('get', `/api/projects/${project.id}/messages`, outsider)).status).toBe(404);
  });

  test('a task thread is separate and as visible as the task', async () => {
    const task = await createTask({ assignee_ids: [worker.id] });
    await api('post', tasksUrl(`/${task.id}/messages`), worker).send({ body: 'Pytanie do zadania' });

    const taskThread = await api('get', tasksUrl(`/${task.id}/messages`), pm);
    expect(taskThread.body.map((message) => message.body)).toEqual(['Pytanie do zadania']);
    const projectThread = await api('get', `/api/projects/${project.id}/messages`, pm);
    expect(projectThread.body.map((message) => message.body)).not.toContain('Pytanie do zadania');

    expect((await api('get', tasksUrl(`/${task.id}/messages`), external)).status).toBe(404);
    expect((await api('post', tasksUrl(`/${task.id}/messages`), external).send({ body: 'x' })).status).toBe(404);
  });

  test('an empty message is rejected', async () => {
    expect((await api('post', `/api/projects/${project.id}/messages`, pm).send({ body: '   ' })).status).toBe(400);
  });
});

describe('external account', () => {
  test('is refused outside the Projects, auth, profile and settings APIs', async () => {
    expect((await api('get', '/api/groups', external)).status).toBe(403);
    expect((await api('get', '/api/admin/users', external)).status).toBe(403);
    expect((await api('get', '/api/auth/me', external)).status).toBe(200);
    expect((await api('get', '/api/projects', external)).status).toBe(200);
    expect((await api('get', '/api/groups', worker)).status).not.toBe(403);
  });
});

describe('history', () => {
  test('records creation and each change with before/after values', async () => {
    const task = await createTask();
    await patchTask(pm, task, { name: 'Nowa nazwa', status_id: statusByName['W toku'] });

    const history = await api('get', tasksUrl(`/${task.id}/history`), pm);
    expect(history.status).toBe(200);
    expect(history.body.map((entry) => entry.action)).toEqual(['project_task_updated', 'project_task_created']);
    expect(history.body[0].before_state).toEqual({ name: 'Zadanie', status_id: statusByName['Do zrobienia'] });
    expect(history.body[0].after_state).toEqual({ name: 'Nowa nazwa', status_id: statusByName['W toku'] });
  });

  test('a request that changes nothing leaves no history entry', async () => {
    const task = await createTask();
    await patchTask(pm, task, { name: 'Zadanie' });
    const history = await api('get', tasksUrl(`/${task.id}/history`), pm);
    expect(history.body).toHaveLength(1);
  });
});
