'use strict';

// Deadline control of the Projects module — computed task timeliness and its
// date boundaries, the at-risk threshold, the overdue-subtasks marker, the
// shared task filters, paging and sorting (a project's tasks, "my tasks",
// cross-project view), the per-person summary, project dates and delay, the
// filters of the projects list, the original end date and slip, and the
// cross-project view's scope per role.
//
// "Today" is the current date in Europe/Warsaw, so every date here is relative
// to it. Multi-tenant: everything is created under one dedicated test tenant
// and cleaned up by tenant_id.

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const { signAccessToken } = require('../middleware/auth');
const { todayInWarsaw } = require('../services/projectDeadlineService');

const SLUG         = 'zz-project-deadlines-test';
const EMAIL_DOMAIN = '@project-deadlines-test.crmtree.local';
const DAY_MS       = 86_400_000;

let tenantId;
let admin, pm, worker, external, controller, outsider;
let project, statusByName;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);
const tasksUrl = (suffix = '', target = project) => `/api/projects/${target.id}/tasks${suffix}`;

// Calendar day relative to today in Europe/Warsaw.
const day = (offset) =>
  new Date(Date.parse(`${todayInWarsaw()}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);

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
  await db.query('DELETE FROM project_cost_categories WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_statuses WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_types WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_priorities WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM crm_leads WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [tenantId]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

async function mkProject(name, members = []) {
  const created = (await api('post', '/api/projects', pm).send({ name })).body;
  for (const member of members) {
    const res = await api('post', `/api/projects/${created.id}/members`, pm).send(member);
    expect(res.status).toBe(201);
  }
  return created;
}

async function createTask(body = {}, target = project) {
  const res = await api('post', tasksUrl('', target), pm).send({ name: 'Zadanie', ...body });
  expect(res.status).toBe(201);
  return res.body;
}

const patchTask = (user, task, body) => api('patch', tasksUrl(`/${task.id}`), user).send(body);
const getTask = async (task, user = pm) => (await api('get', tasksUrl(`/${task.id}`), user)).body;
const searchUrl = (queryString = '') => tasksUrl(`/search${queryString}`);
const search = async (queryString = '', user = pm) => {
  const res = await api('get', searchUrl(queryString), user);
  expect(res.status).toBe(200);
  return res.body;
};
const searchIds = async (queryString, user = pm) => (await search(queryString, user)).items.map((task) => task.id);
const patchProject = (user, body, target = project) => api('patch', `/api/projects/${target.id}`, user).send(body);
const projectDetail = async (target = project) => (await api('get', `/api/projects/${target.id}`, pm)).body.project;
const setThreshold = (user, days) =>
  api('put', '/api/admin/project-config/deadlines', user).send({ at_risk_threshold_days: days });

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Project Deadlines Test', $1, TRUE)
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

  admin      = await mkUser('dadmin', { isAdmin: true });
  pm         = await mkUser('dpm', { canCreate: true });
  worker     = await mkUser('dworker');
  external   = await mkUser('dexternal', { isExternal: true });
  controller = await mkUser('dcontroller');
  outsider   = await mkUser('doutsider');

  const config = (await api('get', '/api/projects/config', admin)).body;
  statusByName = Object.fromEntries(config.statuses.map((status) => [status.name, status.id]));

  project = await mkProject('Kontrola Terminów', [
    { user_id: worker.id,     role: 'internal_participant', access_level: 'full' },
    { user_id: external.id,   role: 'external_participant', access_level: 'full' },
    { user_id: controller.id, role: 'controller' },
  ]);
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

beforeEach(async () => {
  await db.query('DELETE FROM project_tasks WHERE project_id = $1', [project.id]);
  await db.query('UPDATE projects SET start_date = NULL, end_date = NULL WHERE id = $1', [project.id]);
  await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [tenantId]);
  // These tests are not about mails; the mail tests live in project-deadline-emails.test.js.
  jest.spyOn(emailUtil, 'sendMail').mockResolvedValue();
});

afterEach(() => jest.restoreAllMocks());

describe('task timeliness', () => {
  test('follows the date boundaries: yesterday is overdue, today … today+3 at risk, later on time', async () => {
    const timelinessOf = async (endDate) => {
      const task = await createTask({ end_date: endDate });
      return { timeliness: task.timeliness, days_overdue: task.days_overdue };
    };
    expect(await timelinessOf(day(-1))).toEqual({ timeliness: 'overdue', days_overdue: 1 });
    expect(await timelinessOf(day(-10))).toEqual({ timeliness: 'overdue', days_overdue: 10 });
    expect(await timelinessOf(day(0))).toEqual({ timeliness: 'at_risk', days_overdue: null });
    expect(await timelinessOf(day(3))).toEqual({ timeliness: 'at_risk', days_overdue: null });
    expect(await timelinessOf(day(4))).toEqual({ timeliness: 'on_time', days_overdue: null });
    expect(await timelinessOf(null)).toEqual({ timeliness: null, days_overdue: null });
  });

  test('only a not-started task is at risk; a started one is on time until its end date passes', async () => {
    const started = await createTask({ end_date: day(1), status_id: statusByName['W toku'] });
    expect(started).toMatchObject({ timeliness: 'on_time', status_category: 'in_progress' });
    const startedLate = await createTask({ end_date: day(-2), status_id: statusByName['W toku'] });
    expect(startedLate).toMatchObject({ timeliness: 'overdue', days_overdue: 2 });
  });

  test('a done task has no timeliness; it is "completed late" when finished after its end date', async () => {
    const late = await createTask({ end_date: day(-1) });
    const onTime = await createTask({ end_date: day(0) });
    const undated = await createTask();
    for (const task of [late, onTime, undated]) {
      expect((await patchTask(pm, task, { status_id: statusByName['Zakończone'] })).status).toBe(200);
    }
    expect(await getTask(late)).toMatchObject({ timeliness: null, days_overdue: null, is_completed_late: true });
    expect(await getTask(onTime)).toMatchObject({ timeliness: null, is_completed_late: false });
    expect(await getTask(undated)).toMatchObject({ timeliness: null, is_completed_late: false });
    expect((await getTask(late)).completed_at).not.toBeNull();
  });

  test('reopening clears the completion date and brings the timeliness back', async () => {
    const task = await createTask({ end_date: day(-1) });
    await patchTask(pm, task, { status_id: statusByName['Zakończone'] });
    await patchTask(pm, task, { status_id: statusByName['W toku'] });
    expect(await getTask(task)).toMatchObject({
      timeliness: 'overdue', days_overdue: 1, is_completed_late: false, completed_at: null,
    });
  });

  test('a done task without a known completion date is not "completed late"', async () => {
    const task = await createTask({ end_date: day(-5), status_id: statusByName['Zakończone'] });
    await db.query('UPDATE project_tasks SET completed_at = NULL WHERE id = $1', [task.id]);
    expect(await getTask(task)).toMatchObject({ timeliness: null, is_completed_late: false });
  });

  test('a task created in a done status is completed at once', async () => {
    const task = await createTask({ end_date: day(2), status_id: statusByName['Zakończone'] });
    expect(task.completed_at).not.toBeNull();
    expect(task.is_completed_late).toBe(false);
  });

  test('re-categorising a status as done completes its tasks, and back', async () => {
    const task = await createTask({ end_date: day(2), status_id: statusByName['Do weryfikacji'] });
    const recategorise = (category) =>
      api('patch', `/api/admin/project-config/dictionaries/statuses/${statusByName['Do weryfikacji']}`, admin).send({ category });
    try {
      expect((await recategorise('done')).status).toBe(200);
      expect(await getTask(task)).toMatchObject({ timeliness: null, status_category: 'done' });
      expect((await getTask(task)).completed_at).not.toBeNull();
    } finally {
      await recategorise('in_progress');
    }
    expect(await getTask(task)).toMatchObject({ timeliness: 'on_time', completed_at: null });
  });
});

describe('at-risk threshold', () => {
  test('defaults to 3 days and is part of the configuration', async () => {
    const config = (await api('get', '/api/projects/config', worker)).body;
    expect(config.at_risk_threshold_days).toBe(3);
  });

  test('the tenant admin changes it and timeliness follows', async () => {
    const tomorrow = await createTask({ end_date: day(1) });
    const inTenDays = await createTask({ end_date: day(10) });
    const today = await createTask({ end_date: day(0) });

    const widened = await setThreshold(admin, 10);
    expect(widened.status).toBe(200);
    expect(widened.body.at_risk_threshold_days).toBe(10);
    expect((await getTask(inTenDays)).timeliness).toBe('at_risk');

    await setThreshold(admin, 0);
    expect((await getTask(tomorrow)).timeliness).toBe('on_time');
    expect((await getTask(today)).timeliness).toBe('at_risk');
  });

  test('accepts 0–30 from the tenant admin only', async () => {
    expect((await setThreshold(admin, 30)).status).toBe(200);
    expect((await setThreshold(admin, 31)).status).toBe(400);
    expect((await setThreshold(admin, -1)).status).toBe(400);
    expect((await setThreshold(admin, 'soon')).status).toBe(400);
    expect((await setThreshold(pm, 5)).status).toBe(403);
  });
});

describe('overdue subtasks marker', () => {
  test('an overdue descendant marks its ancestors without making them overdue', async () => {
    const parent = await createTask({ name: 'Rodzic', end_date: day(20) });
    const child = await createTask({ name: 'Dziecko', parent_task_id: parent.id });
    const grandchild = await createTask({ name: 'Wnuk', parent_task_id: child.id, end_date: day(-1) });

    expect(await getTask(parent)).toMatchObject({ has_overdue_subtasks: true, timeliness: 'on_time' });
    expect(await getTask(child)).toMatchObject({ has_overdue_subtasks: true, timeliness: null });
    expect(await getTask(grandchild)).toMatchObject({ has_overdue_subtasks: false, timeliness: 'overdue' });

    await patchTask(pm, grandchild, { status_id: statusByName['Zakończone'] });
    expect((await getTask(parent)).has_overdue_subtasks).toBe(false);
  });

  test('an external participant sees only own tasks, and the marker only for own subtasks', async () => {
    const parent = await createTask({ name: 'Rodzic', assignee_ids: [external.id], end_date: day(-1) });
    await createTask({ name: 'Cudze', parent_task_id: parent.id, end_date: day(-1), assignee_ids: [worker.id] });

    const asExternal = await api('get', tasksUrl(), external);
    expect(asExternal.body).toEqual([
      expect.objectContaining({ id: parent.id, timeliness: 'overdue', days_overdue: 1, has_overdue_subtasks: false }),
    ]);
    expect((await getTask(parent, pm)).has_overdue_subtasks).toBe(true);

    await createTask({ name: 'Własne', parent_task_id: parent.id, end_date: day(-1), assignee_ids: [external.id] });
    expect((await getTask(parent, external)).has_overdue_subtasks).toBe(true);
  });
});

describe('filters of a project task list', () => {
  let overdue, atRisk, onTime, done, undated;

  beforeEach(async () => {
    overdue = await createTask({ name: 'Import danych', end_date: day(-2), start_date: day(-9), assignee_ids: [worker.id] });
    atRisk  = await createTask({ name: 'Konfiguracja', end_date: day(1), assignee_ids: [worker.id, external.id] });
    onTime  = await createTask({ name: 'Szkolenie zespołu', end_date: day(15), start_date: day(10), status_id: statusByName['W toku'] });
    done    = await createTask({ name: 'Analiza', end_date: day(-3), status_id: statusByName['Zakończone'], assignee_ids: [external.id] });
    undated = await createTask({ name: 'Import archiwum' });
  });

  test('by timeliness', async () => {
    expect(await searchIds('?timeliness=overdue')).toEqual([overdue.id]);
    expect(await searchIds('?timeliness=at_risk')).toEqual([atRisk.id]);
    expect(await searchIds('?timeliness=on_time')).toEqual([onTime.id]);
    expect(await searchIds('?timeliness=overdue,at_risk')).toEqual([overdue.id, atRisk.id]);
  });

  test('by assignee, including nobody', async () => {
    expect(await searchIds(`?assignee=${worker.id}`)).toEqual([overdue.id, atRisk.id]);
    expect(await searchIds(`?assignee=${external.id}`)).toEqual([atRisk.id, done.id]);
    expect(await searchIds('?assignee=unassigned')).toEqual([onTime.id, undated.id]);
  });

  test('by status, name and number', async () => {
    expect(await searchIds(`?status_ids=${statusByName['W toku']},${statusByName['Zakończone']}`)).toEqual([onTime.id, done.id]);
    expect(await searchIds('?status_category=done')).toEqual([done.id]);
    expect(await searchIds('?name=import')).toEqual([overdue.id, undated.id]);
    expect(await searchIds('?name=100%25')).toEqual([]);
    expect(await searchIds(`?number=${project.key}-${atRisk.task_number}`)).toEqual([atRisk.id]);
  });

  test('by end and start date ranges, both ends inclusive', async () => {
    expect(await searchIds(`?end_from=${day(-2)}&end_to=${day(1)}`)).toEqual([overdue.id, atRisk.id]);
    expect(await searchIds(`?end_to=${day(-3)}`)).toEqual([done.id]);
    expect(await searchIds(`?start_from=${day(-9)}`)).toEqual([overdue.id, onTime.id]);
    expect(await searchIds(`?start_from=${day(0)}&start_to=${day(10)}`)).toEqual([onTime.id]);
  });

  test('filters combine, and every project member who lists tasks may use them', async () => {
    expect(await searchIds(`?assignee=${worker.id}&timeliness=overdue&status_ids=${statusByName['Do zrobienia']}`))
      .toEqual([overdue.id]);
    expect(await searchIds(`?assignee=${worker.id}&timeliness=on_time`)).toEqual([]);
    expect(await searchIds('?timeliness=overdue', worker)).toEqual([overdue.id]);
    expect(await searchIds('?timeliness=at_risk', external)).toEqual([atRisk.id]);
    expect(await searchIds('?timeliness=overdue', external)).toEqual([]);
  });

  test('malformed values are rejected', async () => {
    for (const queryString of [
      '?timeliness=late', '?assignee=somebody', '?status_ids=1,2', '?status_category=open',
      '?end_from=2026-13-40', '?start_to=14.10.2026', '?cost_min=dużo', '?cost_max=-5', '?priority_ids=x',
    ]) {
      expect((await api('get', searchUrl(queryString), pm)).status).toBe(400);
    }
    expect((await api('get', searchUrl('?name=&timeliness=&cost_min=&page='), pm)).status).toBe(200);
  });

  test('per-person summary counts open, overdue and at-risk tasks for PM, admin and controller', async () => {
    const summary = await api('get', tasksUrl('/assignee-summary'), pm);
    expect(summary.status).toBe(200);
    const byUser = Object.fromEntries(summary.body.people.map((person) => [person.user_id, person]));
    expect(byUser[worker.id]).toMatchObject({
      display_name: worker.display_name, open_task_count: 2, overdue_task_count: 1, at_risk_task_count: 1,
    });
    // The external person's done task does not count.
    expect(byUser[external.id]).toMatchObject({ open_task_count: 1, overdue_task_count: 0, at_risk_task_count: 1 });
    expect(summary.body.people).toHaveLength(2);
    expect(summary.body.unassigned).toEqual({ open_task_count: 2, overdue_task_count: 0, at_risk_task_count: 0 });

    expect((await api('get', tasksUrl('/assignee-summary'), admin)).status).toBe(200);
    expect((await api('get', tasksUrl('/assignee-summary'), controller)).status).toBe(200);
    expect((await api('get', tasksUrl('/assignee-summary'), worker)).status).toBe(403);
    expect((await api('get', tasksUrl('/assignee-summary'), external)).status).toBe(403);
    expect((await api('get', tasksUrl('/assignee-summary'), outsider)).status).toBe(404);
  });

  describe('task cost', () => {
    const setFinance = (isEnabled) =>
      api('put', '/api/admin/project-config/finance', admin).send({ is_enabled: isEnabled });

    beforeEach(async () => {
      const config = (await setFinance(true)).body;
      const categoryId = config.cost_categories[0].id;
      const addCost = async (task, amount, status) => {
        const res = await api('post', `/api/projects/${project.id}/finance/costs`, pm)
          .send({ date: day(-1), amount, category_id: categoryId, task_id: task.id, status });
        expect(res.status).toBe(201);
      };
      await addCost(overdue, 100, 'incurred');
      await addCost(overdue, 50.5, 'planned');
      await addCost(atRisk, 1000, 'incurred');
    });

    test('rows carry the sum of the task’s own planned and incurred costs for finance readers', async () => {
      const rows = (await search()).items;
      const costOf = (task) => rows.find((row) => row.id === task.id);
      expect(costOf(overdue)).toMatchObject({ cost_total: 150.5, cost_currency: 'PLN' });
      expect(costOf(atRisk)).toMatchObject({ cost_total: 1000, cost_currency: 'PLN' });
      expect(costOf(undated)).toMatchObject({ cost_total: 0, cost_currency: 'PLN' });
      expect((await search('', controller)).items[0].cost_total).toBe(150.5);
      // The whole-project list of the project view carries no cost.
      expect((await api('get', tasksUrl(), pm)).body[0]).not.toHaveProperty('cost_total');
    });

    test('the cost range filters for finance readers', async () => {
      expect(await searchIds('?cost_min=150.5')).toEqual([overdue.id, atRisk.id]);
      expect(await searchIds('?cost_min=100&cost_max=500')).toEqual([overdue.id]);
      expect(await searchIds('?cost_max=0')).toEqual([onTime.id, done.id, undated.id]);
      expect(await searchIds('?cost_min=1&timeliness=at_risk', controller)).toEqual([atRisk.id]);
    });

    test('a participant gets no cost and the cost filter is ignored for them', async () => {
      const rows = (await search('?cost_min=500', worker)).items;
      expect(rows).toHaveLength(5);
      expect(rows[0]).toMatchObject({ cost_total: null, cost_currency: null });
    });

    test('with project finance switched off nobody gets the cost', async () => {
      await setFinance(false);
      const rows = (await search('?cost_min=500')).items;
      expect(rows).toHaveLength(5);
      expect(rows[0]).toMatchObject({ cost_total: null, cost_currency: null });
    });

    test('"my tasks" shows the cost only in projects whose finance the viewer may read', async () => {
      const mine = await createTask({ name: 'Zadanie PM-a', assignee_ids: [pm.id], end_date: day(5) });
      const asPm = (await api('get', '/api/projects/my-tasks', pm)).body.items;
      expect(asPm).toEqual([expect.objectContaining({ id: mine.id, cost_total: 0, cost_currency: 'PLN' })]);
      expect((await api('get', '/api/projects/my-tasks?cost_min=10', pm)).body.items).toEqual([]);

      const asWorker = (await api('get', '/api/projects/my-tasks?cost_min=5000', worker)).body.items;
      expect(asWorker.map((task) => task.id)).toEqual([overdue.id, atRisk.id]);
      expect(asWorker[0]).toMatchObject({ cost_total: null, cost_currency: null });
    });
  });

  test('"my tasks" takes the same filters and carries the deadline fields', async () => {
    const myTasks = async (queryString) => {
      const res = await api('get', `/api/projects/my-tasks${queryString}`, worker);
      expect(res.status).toBe(200);
      return res.body.items.map((task) => task.id);
    };
    const page = (await api('get', '/api/projects/my-tasks', worker)).body;
    expect(page).toMatchObject({ total: 2, page: 1, page_size: 50 });
    expect(page.items).toEqual([
      expect.objectContaining({ id: overdue.id, timeliness: 'overdue', days_overdue: 2, slip_days: null }),
      expect.objectContaining({ id: atRisk.id, timeliness: 'at_risk', original_end_date: day(1) }),
    ]);
    expect(await myTasks('?timeliness=overdue')).toEqual([overdue.id]);
    expect(await myTasks('?name=konfig')).toEqual([atRisk.id]);
    expect(await myTasks(`?end_from=${day(0)}`)).toEqual([atRisk.id]);
    expect(await myTasks(`?start_to=${day(-9)}`)).toEqual([overdue.id]);
    expect(await myTasks(`?project_ids=${project.id}&status_category=todo`)).toEqual([overdue.id, atRisk.id]);
    expect(await myTasks(`?project_ids=${tenantId}`)).toEqual([]);
    // "Assignee" has no meaning in a list of one's own tasks.
    expect(await myTasks('?assignee=unassigned')).toEqual([overdue.id, atRisk.id]);
    expect((await api('get', '/api/projects/my-tasks?end_to=tomorrow', worker)).status).toBe(400);

    // The unpaged feed of the CRM calendar keeps its shape and gains the deadline fields.
    const feed = (await api('get', '/api/projects/assigned-tasks', worker)).body;
    expect(feed).toEqual([
      expect.objectContaining({ id: overdue.id, timeliness: 'overdue', days_overdue: 2 }),
      expect.objectContaining({ id: atRisk.id, timeliness: 'at_risk' }),
    ]);
  });
});

describe('project dates', () => {
  test('PM and tenant admin set them; the end may not precede the start', async () => {
    const res = await patchProject(pm, { start_date: day(0), end_date: day(30) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ start_date: day(0), end_date: day(30) });

    expect((await patchProject(pm, { end_date: day(-1) })).status).toBe(400);
    expect((await patchProject(pm, { start_date: day(31) })).status).toBe(400);
    expect((await patchProject(pm, { end_date: '30.10.2026' })).status).toBe(400);
    expect((await patchProject(admin, { end_date: null })).body.end_date).toBeNull();
    expect((await patchProject(worker, { end_date: day(40) })).status).toBe(403);
    expect((await patchProject(controller, { end_date: day(40) })).status).toBe(403);
  });

  test('can be given when the project is created', async () => {
    const res = await api('post', '/api/projects', pm).send({ name: 'Z Datami', start_date: day(1), end_date: day(2) });
    expect(res.body).toMatchObject({ start_date: day(1), end_date: day(2) });
    const invalid = await api('post', '/api/projects', pm).send({ name: 'Odwrotnie', start_date: day(2), end_date: day(1) });
    expect(invalid.status).toBe(400);
  });

  test('a change is audited with the old and the new dates', async () => {
    await patchProject(pm, { start_date: day(0), end_date: day(30) });
    await patchProject(pm, { end_date: day(45) });
    const { rows: [entry] } = await db.query(
      `SELECT before_state, after_state FROM audit_logs
       WHERE action = 'project_updated' AND metadata->>'project_id' = $1 ORDER BY created_at DESC LIMIT 1`,
      [project.id],
    );
    expect(entry.before_state).toMatchObject({ start_date: day(0), end_date: day(30) });
    expect(entry.after_state).toMatchObject({ start_date: day(0), end_date: day(45) });
  });

  test('cannot be edited in a closed project, and never block a task date', async () => {
    await patchProject(pm, { end_date: day(10) });
    expect((await createTask({ end_date: day(60) })).end_date).toBe(day(60));

    await api('post', `/api/projects/${project.id}/close`, pm);
    try {
      expect((await patchProject(pm, { end_date: day(20) })).status).toBe(409);
    } finally {
      await api('post', `/api/projects/${project.id}/reopen`, pm);
    }
  });
});

describe('project delay', () => {
  const NOT_DELAYED = { is_delayed: false, delay_reasons: [] };

  test('a project without an end date is never delayed', async () => {
    await createTask({ end_date: day(-30) });
    expect(await projectDetail()).toMatchObject(NOT_DELAYED);
  });

  test('task_after_end: a not-done task ends after the project, with the worst date explained', async () => {
    await patchProject(pm, { end_date: day(10) });
    await createTask({ end_date: day(10) });
    expect(await projectDetail()).toMatchObject(NOT_DELAYED);

    await createTask({ end_date: day(12) });
    const worst = await createTask({ end_date: day(17) });
    const finished = await createTask({ end_date: day(40), status_id: statusByName['Zakończone'] });
    expect(await projectDetail()).toMatchObject({
      is_delayed: true,
      delay_reasons: ['task_after_end'],
      delay_details: {
        open_task_count: 3, tasks_after_end_count: 2, latest_task_end_date: day(17), days_after_end: 7, days_past_end: null,
      },
    });

    // The done task did not count; reopening it makes it the worst one.
    await patchTask(pm, finished, { status_id: statusByName['W toku'] });
    expect((await projectDetail()).delay_details).toMatchObject({ tasks_after_end_count: 3, days_after_end: 30 });
    await patchTask(pm, finished, { status_id: statusByName['Zakończone'] });
    await patchTask(pm, worst, { end_date: day(9) });
    expect((await projectDetail()).delay_details).toMatchObject({ tasks_after_end_count: 1, latest_task_end_date: day(12) });
  });

  test('end_passed: the end date is behind and not-done tasks remain', async () => {
    await patchProject(pm, { end_date: day(-4) });
    const leftover = await createTask();
    expect(await projectDetail()).toMatchObject({
      is_delayed: true,
      delay_reasons: ['end_passed'],
      delay_details: { open_task_count: 1, tasks_after_end_count: 0, latest_task_end_date: null, days_after_end: null, days_past_end: 4 },
    });

    await patchTask(pm, leftover, { status_id: statusByName['Zakończone'] });
    expect(await projectDetail()).toMatchObject(NOT_DELAYED);
  });

  test('the end date being today is not yet passed, and both reasons can hold at once', async () => {
    await patchProject(pm, { end_date: day(0) });
    await createTask();
    expect(await projectDetail()).toMatchObject(NOT_DELAYED);

    await patchProject(pm, { end_date: day(-1) });
    await createTask({ end_date: day(3) });
    expect((await projectDetail()).delay_reasons).toEqual(['task_after_end', 'end_passed']);
  });

  test('a closed project is not delayed', async () => {
    await patchProject(pm, { end_date: day(-4) });
    await createTask({ end_date: day(5) });
    await api('post', `/api/projects/${project.id}/close`, pm);
    try {
      expect(await projectDetail()).toMatchObject(NOT_DELAYED);
      const listed = (await api('get', '/api/projects?status=closed', pm)).body.items;
      expect(listed.find((row) => row.id === project.id)).toMatchObject(NOT_DELAYED);
      // Tasks of a closed project keep their computed fields for display.
      expect((await api('get', tasksUrl(), pm)).body[0]).toMatchObject({ timeliness: 'on_time' });
    } finally {
      await api('post', `/api/projects/${project.id}/reopen`, pm);
    }
  });

  test('is exposed on the project list and on the linked projects of a lead card', async () => {
    await patchProject(pm, { start_date: day(-20), end_date: day(-4) });
    const task = await createTask({ end_date: day(-6) });

    const listed = (await api('get', '/api/projects', pm)).body.items.find((row) => row.id === project.id);
    expect(listed).toMatchObject({
      start_date: day(-20), end_date: day(-4), is_delayed: true, delay_reasons: ['end_passed'],
      delay_details: expect.objectContaining({ days_past_end: 4 }),
    });

    const { rows: [lead] } = await db.query(
      `INSERT INTO crm_leads (company, stage, assigned_to, created_by, tenant_id)
       VALUES ('Lead Terminów', 'new', $1, $1, $2) RETURNING id`,
      [admin.id, tenantId],
    );
    await db.query('UPDATE projects SET lead_id = $1 WHERE id = $2', [lead.id, project.id]);
    try {
      const [linked] = (await api('get', `/api/crm/leads/${lead.id}/projects`, admin)).body;
      expect(linked).toMatchObject({ id: project.id, end_date: day(-4), is_delayed: true, delay_reasons: ['end_passed'] });
      expect(linked.tasks).toEqual([expect.objectContaining({ id: task.id, timeliness: 'overdue', days_overdue: 6 })]);
    } finally {
      await db.query('UPDATE projects SET lead_id = NULL WHERE id = $1', [project.id]);
    }
  });
});

describe('original end date and slip', () => {
  test('the first end date is remembered; later changes only move the slip', async () => {
    const task = await createTask({ end_date: day(5) });
    expect(task).toMatchObject({ original_end_date: day(5), slip_days: null });

    const pushed = (await patchTask(pm, task, { end_date: day(12) })).body;
    expect(pushed).toMatchObject({ end_date: day(12), original_end_date: day(5), slip_days: 7 });
    const pulledIn = (await patchTask(pm, task, { end_date: day(3) })).body;
    expect(pulledIn).toMatchObject({ original_end_date: day(5), slip_days: -2 });
    const back = (await patchTask(pm, task, { end_date: day(5) })).body;
    expect(back).toMatchObject({ original_end_date: day(5), slip_days: null });
  });

  test('clearing the end date keeps the original; a new date slips against it', async () => {
    const task = await createTask({ end_date: day(5) });
    const cleared = (await patchTask(pm, task, { end_date: null })).body;
    expect(cleared).toMatchObject({ end_date: null, original_end_date: day(5), slip_days: null });
    const redated = (await patchTask(pm, task, { end_date: day(8) })).body;
    expect(redated).toMatchObject({ original_end_date: day(5), slip_days: 3 });
  });

  test('a task created without a date gets its original when a date is first set', async () => {
    const task = await createTask();
    expect(task.original_end_date).toBeNull();
    await patchTask(pm, task, { name: 'Inna nazwa' });
    expect((await getTask(task)).original_end_date).toBeNull();

    expect((await patchTask(pm, task, { end_date: day(4) })).body).toMatchObject({ original_end_date: day(4), slip_days: null });
    expect((await patchTask(pm, task, { end_date: day(6) })).body).toMatchObject({ original_end_date: day(4), slip_days: 2 });
  });

  test('the start date is not tracked', async () => {
    const task = await createTask({ start_date: day(1), end_date: day(5) });
    const moved = (await patchTask(pm, task, { start_date: day(3) })).body;
    expect(moved).toMatchObject({ original_end_date: day(5), slip_days: null });
  });

  test('who may change the date is unchanged: an assigned participant yes, a controller no', async () => {
    const task = await createTask({ end_date: day(5), assignee_ids: [worker.id] });
    expect((await patchTask(worker, task, { end_date: day(6) })).status).toBe(200);
    expect((await patchTask(controller, task, { end_date: day(7) })).status).toBe(403);
  });

  test('the reason for a change is kept in the task history', async () => {
    const task = await createTask({ end_date: day(5) });
    await patchTask(pm, task, { end_date: day(9), end_date_change_reason: '  Klient przesunął odbiór  ' });
    await patchTask(pm, task, { end_date: day(10) });
    // Without a change of the end date there is nothing to explain.
    await patchTask(pm, task, { name: 'Nowa nazwa', end_date_change_reason: 'Bez znaczenia' });

    const history = (await api('get', tasksUrl(`/${task.id}/history`), pm)).body;
    expect(history.map((entry) => entry.end_date_change_reason)).toEqual([null, null, 'Klient przesunął odbiór', null]);
    expect(history[2]).toMatchObject({ before_state: { end_date: day(5) }, after_state: { end_date: day(9) } });

    const tooLong = await patchTask(pm, task, { end_date: day(11), end_date_change_reason: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);
  });

  describe('back-fill of existing tasks (migration 0321)', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '0321_project_deadlines.sql'), 'utf8',
    );
    const backfillSql = migration.slice(migration.indexOf('-- >>> backfill'), migration.indexOf('-- <<< backfill'));

    const stored = async (task) => {
      const { rows: [row] } = await db.query(
        'SELECT original_end_date, completed_at FROM project_tasks WHERE id = $1', [task.id],
      );
      return row;
    };
    const runBackfill = async () => {
      await db.query(
        'UPDATE project_tasks SET original_end_date = NULL, completed_at = NULL WHERE project_id = $1', [project.id],
      );
      await db.query(backfillSql);
    };

    test('derives the original end date from the first recorded change, else takes the current date', async () => {
      const changedTwice = await createTask({ end_date: day(5) });
      await patchTask(pm, changedTwice, { end_date: day(9) });
      await patchTask(pm, changedTwice, { end_date: day(14) });
      const datedLater = await createTask();
      await patchTask(pm, datedLater, { end_date: day(7) });
      await patchTask(pm, datedLater, { end_date: day(8) });
      const neverChanged = await createTask({ end_date: day(3) });
      const neverDated = await createTask();

      await runBackfill();
      expect((await stored(changedTwice)).original_end_date).toBe(day(5));
      expect((await stored(datedLater)).original_end_date).toBe(day(7));
      expect((await stored(neverChanged)).original_end_date).toBe(day(3));
      expect((await stored(neverDated)).original_end_date).toBeNull();
      expect((await getTask(changedTwice)).slip_days).toBe(9);
    });

    test('derives the completion date of done tasks from history, else leaves it empty', async () => {
      const finished = await createTask({ end_date: day(-2) });
      await patchTask(pm, finished, { status_id: statusByName['Zakończone'] });
      const { completed_at: recorded } = await stored(finished);
      const reopened = await createTask();
      await patchTask(pm, reopened, { status_id: statusByName['Zakończone'] });
      await patchTask(pm, reopened, { status_id: statusByName['W toku'] });
      const withoutHistory = await createTask({ end_date: day(-2) });
      await db.query('UPDATE project_tasks SET status_id = $1 WHERE id = $2', [statusByName['Zakończone'], withoutHistory.id]);

      await runBackfill();
      const restored = (await stored(finished)).completed_at;
      expect(Math.abs(restored.getTime() - recorded.getTime())).toBeLessThan(5000);
      expect((await getTask(finished)).is_completed_late).toBe(true);
      expect((await stored(reopened)).completed_at).toBeNull();
      expect((await stored(withoutHistory)).completed_at).toBeNull();
      expect((await getTask(withoutHistory)).is_completed_late).toBe(false);
    });
  });
});

describe('cross-project view', () => {
  let second, foreign, closed;
  let overdueTask, atRiskTask, doneTask, secondTask, foreignTask;
  let pmOfTwo, participant;

  const portfolioTasks = (user, queryString = '') => api('get', `/api/projects/portfolio/tasks${queryString}`, user);
  const portfolioIds = async (user, queryString = '') => {
    const res = await portfolioTasks(user, queryString);
    expect(res.status).toBe(200);
    return res.body.items.map((task) => task.id).sort();
  };
  const sorted = (...tasks) => tasks.map((task) => task.id).sort();
  const overviewOf = async (user, queryString = '') =>
    (await api('get', `/api/projects/portfolio/projects${queryString}`, user)).body.items;
  const hasView = async (user) => (await api('get', '/api/projects/config', user)).body.has_cross_project_view;

  beforeAll(async () => {
    pmOfTwo     = await mkUser('dpmoftwo');
    participant = await mkUser('dparticipant');
    second = await mkProject('Drugi Projekt', [
      { user_id: pmOfTwo.id, role: 'pm' },
      { user_id: participant.id, role: 'internal_participant', access_level: 'full' },
      { user_id: external.id, role: 'external_participant', access_level: 'full' },
    ]);
    foreign = await mkProject('Obcy Projekt');
    closed = await mkProject('Zamknięty Projekt', [{ user_id: pmOfTwo.id, role: 'pm' }]);
    await createTask({ name: 'W zamkniętym', end_date: day(-1) }, closed);
    await api('post', `/api/projects/${closed.id}/close`, pm);
    await api('post', `/api/projects/${project.id}/members`, pm).send({ user_id: pmOfTwo.id, role: 'pm' });
  });

  beforeEach(async () => {
    await db.query('DELETE FROM project_tasks WHERE project_id = ANY($1::uuid[])', [[second.id, foreign.id]]);
    overdueTask = await createTask({ name: 'Migracja bazy', end_date: day(-3), assignee_ids: [worker.id] });
    atRiskTask  = await createTask({ name: 'Testy odbiorcze', end_date: day(2), start_date: day(0) });
    doneTask    = await createTask({ name: 'Analiza wymagań', end_date: day(-8), status_id: statusByName['Zakończone'] });
    secondTask  = await createTask({ name: 'Migracja plików', end_date: day(20), parent_task_id: null, assignee_ids: [external.id] }, second);
    foreignTask = await createTask({ name: 'Zadanie obce', end_date: day(-1) }, foreign);
  });

  test('scope: the admin sees every open project, a PM or controller only their own', async () => {
    expect(await portfolioIds(admin)).toEqual(sorted(overdueTask, atRiskTask, doneTask, secondTask, foreignTask));
    expect(await portfolioIds(pmOfTwo)).toEqual(sorted(overdueTask, atRiskTask, doneTask, secondTask));
    expect(await portfolioIds(controller)).toEqual(sorted(overdueTask, atRiskTask, doneTask));
    expect(await portfolioIds(pm)).toEqual(sorted(overdueTask, atRiskTask, doneTask, secondTask, foreignTask));
  });

  test('a plain participant and an external participant do not have the view', async () => {
    for (const user of [participant, worker, external, outsider]) {
      expect((await portfolioTasks(user)).status).toBe(403);
      expect((await api('get', '/api/projects/portfolio/projects', user)).status).toBe(403);
      expect(await hasView(user)).toBe(false);
    }
    for (const user of [admin, pmOfTwo, controller]) expect(await hasView(user)).toBe(true);
  });

  test('an external account that is a controller gets the projects it controls', async () => {
    const externalController = await mkUser('dextcontroller', { isExternal: true });
    await api('post', `/api/projects/${second.id}/members`, pm).send({ user_id: externalController.id, role: 'controller' });
    expect(await portfolioIds(externalController)).toEqual(sorted(secondTask));
    expect(await hasView(externalController)).toBe(true);
  });

  test('closed projects are not part of the view', async () => {
    const overview = await overviewOf(pmOfTwo);
    expect(overview.map((row) => row.name)).toEqual(['Drugi Projekt', 'Kontrola Terminów']);
    expect((await portfolioTasks(admin)).body.items.map((task) => task.name)).not.toContain('W zamkniętym');
  });

  test('a task row carries what the list and the Gantt chart need', async () => {
    const res = await portfolioTasks(pmOfTwo, `?project_ids=${project.id}&timeliness=overdue`);
    expect(res.body).toMatchObject({ total: 1, page: 1, page_size: 50 });
    expect(res.body.items).toEqual([expect.objectContaining({
      id: overdueTask.id, project_id: project.id, project_key: project.key, project_name: 'Kontrola Terminów',
      task_number: overdueTask.task_number, name: 'Migracja bazy',
      status_id: statusByName['Do zrobienia'], status_name: 'Do zrobienia', status_category: 'todo', status_color: '#6B7280',
      priority_id: null, priority_name: null, type_id: null, type_name: null,
      assignees: [{ user_id: worker.id, display_name: worker.display_name }],
      start_date: null, end_date: day(-3), parent_task_id: null, parent_task_number: null, parent_task_name: null,
      original_end_date: day(-3), slip_days: null,
      timeliness: 'overdue', days_overdue: 3, is_completed_late: false, has_overdue_subtasks: false,
    })]);
  });

  test('filters: project, assignee, status category, timeliness, name, number and dates', async () => {
    expect(await portfolioIds(pmOfTwo, `?project_ids=${second.id}`)).toEqual(sorted(secondTask));
    // A project outside the caller's scope matches nothing.
    expect(await portfolioIds(pmOfTwo, `?project_ids=${foreign.id}`)).toEqual([]);
    expect(await portfolioIds(pmOfTwo, `?assignee=${external.id}`)).toEqual(sorted(secondTask));
    expect(await portfolioIds(pmOfTwo, '?assignee=unassigned')).toEqual(sorted(atRiskTask, doneTask));
    expect(await portfolioIds(pmOfTwo, '?status_category=done')).toEqual(sorted(doneTask));
    expect(await portfolioIds(pmOfTwo, '?status_category=todo,in_progress&timeliness=overdue,at_risk'))
      .toEqual(sorted(overdueTask, atRiskTask));
    expect(await portfolioIds(pmOfTwo, '?name=migracja')).toEqual(sorted(overdueTask, secondTask));
    expect(await portfolioIds(pmOfTwo, `?number=${second.key}-`)).toEqual(sorted(secondTask));
    expect(await portfolioIds(pmOfTwo, `?end_from=${day(0)}&end_to=${day(20)}`)).toEqual(sorted(atRiskTask, secondTask));
    expect(await portfolioIds(pmOfTwo, `?start_from=${day(0)}`)).toEqual(sorted(atRiskTask));
    expect(await portfolioIds(pmOfTwo, `?status_ids=${statusByName['Zakończone']}`)).toEqual(sorted(doneTask));
    expect((await portfolioTasks(pmOfTwo, '?timeliness=soon')).status).toBe(400);
    expect((await portfolioTasks(pmOfTwo, '?end_from=wczoraj')).status).toBe(400);
  });

  test('filters by priority and type', async () => {
    const config = (await api('get', '/api/projects/config', pm)).body;
    const [priority] = config.priorities;
    const [type] = config.types;
    const flagged = await createTask({ name: 'Z priorytetem', priority_id: priority.id, type_id: type.id }, second);
    expect(await portfolioIds(pmOfTwo, `?priority_ids=${priority.id}`)).toEqual(sorted(flagged));
    expect(await portfolioIds(pmOfTwo, `?type_ids=${type.id}&project_ids=${project.id}`)).toEqual([]);
    const [row] = (await portfolioTasks(pmOfTwo, `?type_ids=${type.id}`)).body.items;
    expect(row).toMatchObject({ priority_name: priority.name, priority_color: priority.color, type_name: type.name });
  });

  test('task cost and its filter follow the tenant finance switch', async () => {
    expect((await portfolioTasks(pmOfTwo, '?cost_min=10')).body.items).toHaveLength(4);
    expect((await portfolioTasks(pmOfTwo)).body.items[0]).toMatchObject({ cost_total: null, cost_currency: null });

    const config = (await api('put', '/api/admin/project-config/finance', admin).send({ is_enabled: true })).body;
    await api('post', `/api/projects/${second.id}/finance/costs`, pm)
      .send({ date: day(-1), amount: 250, category_id: config.cost_categories[0].id, task_id: secondTask.id });
    const costly = (await portfolioTasks(pmOfTwo, '?cost_min=10')).body.items;
    expect(costly).toEqual([expect.objectContaining({ id: secondTask.id, cost_total: 250, cost_currency: 'PLN' })]);
  });

  test('projects overview: dates, task counts, delay and PM names per project', async () => {
    await patchProject(pm, { start_date: day(-30), end_date: day(-5) });
    const overview = await overviewOf(pmOfTwo);
    expect(overview).toHaveLength(2);
    expect(overview.find((row) => row.id === project.id)).toMatchObject({
      key: project.key, name: 'Kontrola Terminów', status: 'open', start_date: day(-30), end_date: day(-5), my_role: 'pm',
      task_count: 3, done_task_count: 1, overdue_task_count: 1, at_risk_task_count: 1,
      is_delayed: true, delay_reasons: ['task_after_end', 'end_passed'],
      delay_details: expect.objectContaining({ latest_task_end_date: day(2), days_after_end: 7, days_past_end: 5 }),
      project_managers: expect.arrayContaining([
        { user_id: pm.id, display_name: pm.display_name }, { user_id: pmOfTwo.id, display_name: pmOfTwo.display_name },
      ]),
    });
    expect(overview.find((row) => row.id === second.id)).toMatchObject({
      end_date: null, task_count: 1, done_task_count: 0, overdue_task_count: 0, is_delayed: false, delay_reasons: [],
    });
    // The admin is not a member of anything: no role of their own, every open project listed.
    const asAdmin = await overviewOf(admin);
    expect(asAdmin.map((row) => row.name)).toEqual(expect.arrayContaining(['Drugi Projekt', 'Kontrola Terminów', 'Obcy Projekt']));
    expect(asAdmin.every((row) => row.my_role === null)).toBe(true);
  });
});
