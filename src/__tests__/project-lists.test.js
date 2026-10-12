'use strict';

// Lists of the Projects module — one convention everywhere: paging (page,
// page_size ≤ 50 → { items, total, page, page_size }), server-side sorting
// (sort, order) and filtering. Covers paging and sorting of the task lists,
// the flat rows with their parent, the unpaged Gantt mode with its cap, the
// original-end-date and slip filters, and the filters of the projects list.
// The task filters themselves are covered in project-deadlines.test.js.
//
// Multi-tenant: everything is created under one dedicated test tenant and
// cleaned up by tenant_id.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const { signAccessToken } = require('../middleware/auth');
const { todayInWarsaw } = require('../services/projectDeadlineService');

const SLUG         = 'zz-project-lists-test';
const EMAIL_DOMAIN = '@project-lists-test.crmtree.local';
const DAY_MS       = 86_400_000;

let tenantId;
let admin, pm, worker, external;
let project, statusByName, config;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);
const tasksUrl = (suffix = '', target = project) => `/api/projects/${target.id}/tasks${suffix}`;
const day = (offset) =>
  new Date(Date.parse(`${todayInWarsaw()}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);

async function mkUser(local, firstName, { isAdmin = false, isExternal = false, canCreate = false } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id, is_external, can_create_projects)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5, $6) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, firstName, isAdmin, tenantId, isExternal, canCreate],
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
  await db.query('DELETE FROM crm_partners WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [tenantId]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

async function mkProject(body, members = []) {
  const res = await api('post', '/api/projects', pm).send(body);
  expect(res.status).toBe(201);
  for (const member of members) {
    expect((await api('post', `/api/projects/${res.body.id}/members`, pm).send(member)).status).toBe(201);
  }
  return res.body;
}

async function createTask(body = {}, target = project) {
  const res = await api('post', tasksUrl('', target), pm).send({ name: 'Zadanie', ...body });
  expect(res.status).toBe(201);
  return res.body;
}

const search = async (queryString = '', user = pm) => {
  const res = await api('get', tasksUrl(`/search${queryString}`), user);
  expect(res.status).toBe(200);
  return res.body;
};
const namesOf = async (queryString, user = pm) => (await search(queryString, user)).items.map((task) => task.name);
const setFinance = (isEnabled) => api('put', '/api/admin/project-config/finance', admin).send({ is_enabled: isEnabled });

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Project Lists Test', $1, TRUE)
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

  admin    = await mkUser('ladmin', 'Admin', { isAdmin: true });
  pm       = await mkUser('lpm', 'Piotr', { canCreate: true });
  worker   = await mkUser('lworker', 'Anna');
  external = await mkUser('lexternal', 'Zenon', { isExternal: true });

  config = (await api('get', '/api/projects/config', admin)).body;
  statusByName = Object.fromEntries(config.statuses.map((status) => [status.name, status.id]));
  project = await mkProject({ name: 'Listy Zadań' }, [
    { user_id: worker.id,   role: 'internal_participant', access_level: 'full' },
    { user_id: external.id, role: 'external_participant', access_level: 'full' },
  ]);
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

beforeEach(async () => {
  await db.query('DELETE FROM project_tasks WHERE project_id = $1', [project.id]);
  await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [tenantId]);
  jest.spyOn(emailUtil, 'sendMail').mockResolvedValue();
});

afterEach(() => jest.restoreAllMocks());

describe('paging of task lists', () => {
  beforeEach(async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) await createTask({ name, assignee_ids: [worker.id] });
  });

  test('a page holds page_size items and says how many match in total', async () => {
    const first = await search('?page_size=2');
    expect(first).toMatchObject({ total: 5, page: 1, page_size: 2 });
    expect(first.items.map((task) => task.name)).toEqual(['A', 'B']);
    expect((await search('?page_size=2&page=3')).items.map((task) => task.name)).toEqual(['E']);

    const beyond = await search('?page_size=2&page=4');
    expect(beyond).toMatchObject({ items: [], total: 5, page: 4, page_size: 2 });
  });

  test('defaults to the first page of 50 and counts only what the filters leave', async () => {
    expect(await search()).toMatchObject({ total: 5, page: 1, page_size: 50 });
    expect(await search('?name=c&page_size=1')).toMatchObject({ total: 1, items: [expect.objectContaining({ name: 'C' })] });
  });

  test('a page may not exceed 50 items; page and page_size must be positive integers', async () => {
    for (const queryString of ['?page_size=51', '?page_size=0', '?page=0', '?page=-1', '?page=x', '?page_size=many']) {
      expect((await api('get', tasksUrl(`/search${queryString}`), pm)).status).toBe(400);
    }
    expect((await api('get', tasksUrl('/search?page_size=50'), pm)).status).toBe(200);
  });

  test('"my tasks" and the cross-project list are paged the same way', async () => {
    const mine = (await api('get', '/api/projects/my-tasks?page_size=2&page=2&sort=name', worker)).body;
    expect(mine).toMatchObject({ total: 5, page: 2, page_size: 2 });
    expect(mine.items.map((task) => task.name)).toEqual(['C', 'D']);

    const portfolio = (await api('get', `/api/projects/portfolio/tasks?project_ids=${project.id}&page_size=3&sort=name&order=desc`, pm)).body;
    expect(portfolio).toMatchObject({ total: 5, page: 1, page_size: 3 });
    expect(portfolio.items.map((task) => task.name)).toEqual(['E', 'D', 'C']);
    expect((await api('get', '/api/projects/portfolio/tasks?page_size=500', pm)).status).toBe(400);
    expect((await api('get', '/api/projects/my-tasks?page_size=500', worker)).status).toBe(400);
  });

  test('the whole-project list of the project view stays an unpaged array', async () => {
    const res = await api('get', tasksUrl('?page_size=2'), pm);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
  });
});

describe('sorting of task lists', () => {
  let priorities;

  beforeEach(async () => {
    priorities = config.priorities;
    await createTask({ name: 'beta', end_date: day(10), start_date: day(1), assignee_ids: [external.id],
      status_id: statusByName['W toku'], priority_id: priorities[2].id });
    await createTask({ name: 'Alfa', end_date: day(-2), start_date: day(-5), assignee_ids: [worker.id, external.id],
      priority_id: priorities[0].id });
    await createTask({ name: 'gamma', status_id: statusByName['Zakończone'] });
    await createTask({ name: 'Delta', end_date: day(1), start_date: day(0), assignee_ids: [pm.id],
      status_id: statusByName['Do weryfikacji'], priority_id: priorities[3].id });
  });

  test('by number by default, in creation order', async () => {
    expect(await namesOf('')).toEqual(['beta', 'Alfa', 'gamma', 'Delta']);
    expect(await namesOf('?sort=number&order=desc')).toEqual(['Delta', 'gamma', 'Alfa', 'beta']);
  });

  test('by name, ignoring case', async () => {
    expect(await namesOf('?sort=name')).toEqual(['Alfa', 'beta', 'Delta', 'gamma']);
    expect(await namesOf('?sort=name&order=desc')).toEqual(['gamma', 'Delta', 'beta', 'Alfa']);
  });

  test('by dates, with undated tasks last in both directions', async () => {
    expect(await namesOf('?sort=end_date')).toEqual(['Alfa', 'Delta', 'beta', 'gamma']);
    expect(await namesOf('?sort=end_date&order=desc')).toEqual(['beta', 'Delta', 'Alfa', 'gamma']);
    expect(await namesOf('?sort=start_date')).toEqual(['Alfa', 'Delta', 'beta', 'gamma']);
    expect(await namesOf('?sort=original_end_date&order=desc')).toEqual(['beta', 'Delta', 'Alfa', 'gamma']);
  });

  test('by timeliness: overdue, at risk, on time, then tasks without one', async () => {
    // "Delta" is started, so it is on time; "beta" too; they keep their number order.
    expect(await namesOf('?sort=timeliness')).toEqual(['Alfa', 'beta', 'Delta', 'gamma']);
    expect(await namesOf('?sort=days_overdue&order=desc')).toEqual(['Alfa', 'beta', 'gamma', 'Delta']);
  });

  test('by status and priority in dictionary order, by assignee by name', async () => {
    expect(await namesOf('?sort=status')).toEqual(['Alfa', 'beta', 'Delta', 'gamma']);
    expect(await namesOf('?sort=status&order=desc')).toEqual(['gamma', 'Delta', 'beta', 'Alfa']);
    expect(await namesOf('?sort=priority')).toEqual(['Alfa', 'beta', 'Delta', 'gamma']);
    // First assignee by name: Anna (Alfa), Piotr (Delta), Zenon (beta); nobody (gamma) last.
    expect(await namesOf('?sort=assignee')).toEqual(['Alfa', 'Delta', 'beta', 'gamma']);
  });

  test('by slip and by cost', async () => {
    const [beta, alfa] = (await search()).items;
    await api('patch', tasksUrl(`/${beta.id}`), pm).send({ end_date: day(15) });
    await api('patch', tasksUrl(`/${alfa.id}`), pm).send({ end_date: day(-4) });
    expect(await namesOf('?sort=slip_days')).toEqual(['Alfa', 'beta', 'gamma', 'Delta']);
    expect(await namesOf('?sort=slip_days&order=desc')).toEqual(['beta', 'Alfa', 'gamma', 'Delta']);

    const categoryId = (await setFinance(true)).body.cost_categories[0].id;
    for (const [task, amount] of [[beta, 20], [alfa, 300]]) {
      await api('post', `/api/projects/${project.id}/finance/costs`, pm)
        .send({ date: day(0), amount, category_id: categoryId, task_id: task.id });
    }
    expect(await namesOf('?sort=cost&order=desc')).toEqual(['Alfa', 'beta', 'gamma', 'Delta']);
  });

  test('by parent: subtasks grouped by their parent, top-level tasks last in both directions', async () => {
    const [beta, alfa, gamma, delta] = (await search()).items;
    await api('patch', tasksUrl(`/${gamma.id}`), pm).send({ parent_task_id: alfa.id });
    await api('patch', tasksUrl(`/${delta.id}`), pm).send({ parent_task_id: beta.id });
    expect(await namesOf('?sort=parent')).toEqual(['Delta', 'gamma', 'beta', 'Alfa']);
    expect(await namesOf('?sort=parent&order=desc')).toEqual(['gamma', 'Delta', 'beta', 'Alfa']);
  });

  test('an unknown sort key or direction is rejected', async () => {
    expect((await api('get', tasksUrl('/search?sort=size'), pm)).status).toBe(400);
    expect((await api('get', tasksUrl('/search?sort=name&order=up'), pm)).status).toBe(400);
    expect((await api('get', '/api/projects/my-tasks?sort=project&order=desc', worker)).status).toBe(200);
  });
});

describe('flat rows and the hierarchy', () => {
  test('a row names its parent, so a filtered page can show the relation', async () => {
    const parent = await createTask({ name: 'Etap pierwszy' });
    const child = await createTask({ name: 'Krok', parent_task_id: parent.id, end_date: day(-1) });

    const page = await search('?timeliness=overdue');
    expect(page.items).toEqual([expect.objectContaining({
      id: child.id, parent_task_id: parent.id, parent_task_number: parent.task_number, parent_task_name: 'Etap pierwszy',
      project_id: project.id, project_key: project.key, project_name: 'Listy Zadań', status_name: 'Do zrobienia',
    })]);
    expect((await search('?name=etap')).items[0]).toMatchObject({ parent_task_id: null, parent_task_number: null, has_overdue_subtasks: true });
  });

  test('an external participant gets only own tasks and no name of a parent that is not theirs', async () => {
    const parent = await createTask({ name: 'Tajny etap' });
    const own = await createTask({ name: 'Moje', parent_task_id: parent.id, assignee_ids: [external.id] });
    await createTask({ name: 'Cudze', assignee_ids: [worker.id] });

    const page = await search('', external);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id: own.id, parent_task_id: parent.id, parent_task_number: null, parent_task_name: null });
    expect((await api('get', tasksUrl('/gantt'), external)).body.items.map((task) => task.id)).toEqual([own.id]);

    await api('patch', tasksUrl(`/${parent.id}`), pm).send({ assignee_ids: [external.id] });
    expect((await search('?name=moje', external)).items[0].parent_task_name).toBe('Tajny etap');
  });

  test('"mine" narrows the paged list for a member who otherwise sees everything', async () => {
    await createTask({ name: 'Moje', assignee_ids: [worker.id] });
    await createTask({ name: 'Cudze' });
    expect((await search('', worker)).total).toBe(2);
    expect(await namesOf('?mine=true', worker)).toEqual(['Moje']);
  });
});

describe('Gantt mode', () => {
  test('returns the whole filtered set at once, without paging', async () => {
    const overdue = await createTask({ name: 'Po terminie', end_date: day(-1) });
    await createTask({ name: 'W terminie', end_date: day(30) });

    const all = (await api('get', tasksUrl('/gantt'), pm)).body;
    expect(all).toMatchObject({ truncated: false, limit: 500 });
    expect(all.items).toHaveLength(2);
    expect(all).not.toHaveProperty('total');

    const filtered = (await api('get', tasksUrl('/gantt?timeliness=overdue'), pm)).body;
    expect(filtered.items).toEqual([expect.objectContaining({ id: overdue.id, end_date: day(-1), timeliness: 'overdue' })]);
    expect((await api('get', tasksUrl('/gantt?end_from=soon'), pm)).status).toBe(400);
  });

  test('is cut at 500 tasks and says so; the paged list still counts them all', async () => {
    await db.query(
      `INSERT INTO project_tasks (tenant_id, project_id, task_number, name, status_id, end_date, original_end_date)
       SELECT $1, $2, number, 'Masowe ' || number, $3, $4::date, $4::date
       FROM generate_series(10001, 10501) AS number`,
      [tenantId, project.id, statusByName['Do zrobienia'], day(5)],
    );
    const gantt = (await api('get', tasksUrl('/gantt'), pm)).body;
    expect(gantt).toMatchObject({ truncated: true, limit: 500 });
    expect(gantt.items).toHaveLength(500);

    expect(await search('?page_size=50&page=11')).toMatchObject({ total: 501, items: [expect.any(Object)] });
    const portfolio = (await api('get', `/api/projects/portfolio/gantt?project_ids=${project.id}&name=masowe%201050`, pm)).body;
    expect(portfolio).toMatchObject({ truncated: false, limit: 500 });
    expect(portfolio.items.map((task) => task.task_number)).toEqual([10500, 10501]);
  });
});

describe('original end date and slip filters', () => {
  test('filter by the original end date and by the slip in days', async () => {
    const unchanged = await createTask({ name: 'Bez zmian', end_date: day(5) });
    const later = await createTask({ name: 'Później', end_date: day(5) });
    const earlier = await createTask({ name: 'Wcześniej', end_date: day(20) });
    await createTask({ name: 'Bez terminu' });
    await api('patch', tasksUrl(`/${later.id}`), pm).send({ end_date: day(12) });
    await api('patch', tasksUrl(`/${earlier.id}`), pm).send({ end_date: day(17) });

    expect(await namesOf(`?original_end_from=${day(5)}&original_end_to=${day(5)}`)).toEqual(['Bez zmian', 'Później']);
    expect(await namesOf(`?original_end_from=${day(6)}`)).toEqual(['Wcześniej']);
    expect(await namesOf('?slip_min=1')).toEqual(['Później']);
    expect(await namesOf('?slip_max=-1')).toEqual(['Wcześniej']);
    expect(await namesOf('?slip_min=0&slip_max=0')).toEqual(['Bez zmian']);
    expect(await namesOf('?slip_min=-3&slip_max=7')).toEqual(['Bez zmian', 'Później', 'Wcześniej']);
    expect((await search('?slip_min=7')).items[0]).toMatchObject({ id: later.id, slip_days: 7, original_end_date: day(5) });
    expect(unchanged.slip_days).toBeNull();
    expect((await api('get', tasksUrl('/search?slip_min=1.5'), pm)).status).toBe(400);
    expect((await api('get', tasksUrl('/search?original_end_to=2026-02-30'), pm)).status).toBe(400);
  });
});

describe('projects list', () => {
  let alfa, beta, closed, leadId, partnerId;

  const listProjects = (user, queryString = '') => api('get', `/api/projects${queryString}`, user);
  const projectNames = async (user, queryString = '') => {
    const res = await listProjects(user, queryString);
    expect(res.status).toBe(200);
    return res.body.items.map((row) => row.name);
  };

  beforeAll(async () => {
    // Costs booked by the sorting tests above would count towards this project's cost.
    await db.query('DELETE FROM project_cost_items WHERE project_id = $1', [project.id]);
    alfa = await mkProject({ name: 'Alfa Wdrożenie', start_date: day(-30), end_date: day(-3) }, [
      { user_id: worker.id, role: 'internal_participant', access_level: 'full' },
    ]);
    beta = await mkProject({ name: 'Beta Serwis', start_date: day(5), end_date: day(60) }, [
      { user_id: worker.id, role: 'controller' },
    ]);
    closed = await mkProject({ name: 'Gamma Archiwum', end_date: day(-90) });
    await createTask({ name: 'Otwarte', end_date: day(-10), assignee_ids: [worker.id] }, alfa);
    await createTask({ name: 'Zrobione', status_id: statusByName['Zakończone'] }, alfa);
    await createTask({ name: 'W zamkniętym' }, closed);
    await api('post', `/api/projects/${closed.id}/close`, pm);

    const { rows: [lead] } = await db.query(
      `INSERT INTO crm_leads (company, stage, assigned_to, created_by, tenant_id)
       VALUES ('Lead Alfy', 'new', $1, $1, $2) RETURNING id`,
      [admin.id, tenantId],
    );
    const { rows: [partner] } = await db.query(
      `INSERT INTO crm_partners (company, status, manager_id, tenant_id)
       VALUES ('Partner Bety', 'active', $1, $2) RETURNING id`,
      [admin.id, tenantId],
    );
    leadId = lead.id;
    partnerId = partner.id;
    await db.query('UPDATE projects SET lead_id = $1 WHERE id = $2', [leadId, alfa.id]);
    await db.query('UPDATE projects SET partner_id = $1 WHERE id = $2', [partnerId, beta.id]);
  });

  test('is paged: { items, total, page, page_size } next to can_create', async () => {
    const res = await listProjects(pm, '?page_size=2&sort=name');
    expect(res.body).toMatchObject({ total: 3, page: 1, page_size: 2, can_create: true });
    expect(res.body.items.map((row) => row.name)).toEqual(['Alfa Wdrożenie', 'Beta Serwis']);
    expect((await listProjects(pm, '?page_size=2&page=2&sort=name')).body.items.map((row) => row.name)).toEqual(['Listy Zadań']);
    // The released mobile app reads the same page from the old field name.
    expect(res.body.projects).toEqual(res.body.items);
    expect((await listProjects(pm, '?page_size=51')).status).toBe(400);
    expect((await listProjects(pm, '?page=0')).status).toBe(400);
  });

  test('a row carries dates, task counts, delay and the PMs', async () => {
    const [row] = (await listProjects(pm, '?name=alfa')).body.items;
    expect(row).toMatchObject({
      id: alfa.id, key: alfa.key, status: 'open', start_date: day(-30), end_date: day(-3),
      lead_id: leadId, lead_name: 'Lead Alfy', my_role: 'pm', member_count: 2,
      task_count: 2, done_task_count: 1, overdue_task_count: 1, at_risk_task_count: 0, my_open_task_count: 0,
      is_delayed: true, delay_reasons: ['end_passed'],
      delay_details: { open_task_count: 1, tasks_after_end_count: 0, latest_task_end_date: null, days_after_end: null, days_past_end: 3 },
      project_managers: [{ user_id: pm.id, display_name: pm.display_name }],
      finance: null,
    });
    for (const helper of ['has_end_passed', 'has_task_after_end', 'days_since_end', 'filter_cost', 'filter_revenue']) {
      expect(row).not.toHaveProperty(helper);
    }
  });

  test('status: open by default, closed or all on request', async () => {
    expect(await projectNames(pm)).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    expect(await projectNames(pm, '?status=closed')).toEqual(['Gamma Archiwum']);
    expect(await projectNames(pm, '?status=all')).toEqual(['Gamma Archiwum', 'Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    expect((await listProjects(pm, '?status=archived')).status).toBe(400);
  });

  test('by name or key, partially and ignoring case', async () => {
    expect(await projectNames(pm, '?name=serwis')).toEqual(['Beta Serwis']);
    expect(await projectNames(pm, `?name=${alfa.key.toLowerCase()}`)).toEqual(['Alfa Wdrożenie']);
    expect(await projectNames(pm, '?name=nie%20ma%20takiego')).toEqual([]);
  });

  test('by start and end date ranges', async () => {
    expect(await projectNames(pm, `?start_from=${day(0)}`)).toEqual(['Beta Serwis']);
    expect(await projectNames(pm, `?start_to=${day(-30)}`)).toEqual(['Alfa Wdrożenie']);
    expect(await projectNames(pm, `?end_from=${day(-3)}&end_to=${day(60)}`)).toEqual(['Alfa Wdrożenie', 'Beta Serwis']);
    expect(await projectNames(pm, `?end_to=${day(-4)}&status=all`)).toEqual(['Gamma Archiwum']);
    expect((await listProjects(pm, '?end_from=jutro')).status).toBe(400);
  });

  test('by delay — the filter agrees with the is_delayed flag of the rows', async () => {
    expect(await projectNames(pm, '?delayed=true')).toEqual(['Alfa Wdrożenie']);
    expect(await projectNames(pm, '?delayed=false')).toEqual(['Beta Serwis', 'Listy Zadań']);
    // A closed project is never delayed, even with its end date long gone.
    expect(await projectNames(pm, '?delayed=true&status=all')).toEqual(['Alfa Wdrożenie']);
    const all = (await listProjects(pm, '?status=all')).body.items;
    expect(all.filter((row) => row.is_delayed).map((row) => row.name)).toEqual(['Alfa Wdrożenie']);
    expect((await listProjects(pm, '?delayed=maybe')).status).toBe(400);
  });

  test('by linked lead or partner', async () => {
    expect(await projectNames(pm, `?lead_id=${leadId}`)).toEqual(['Alfa Wdrożenie']);
    expect(await projectNames(pm, `?partner_id=${partnerId}`)).toEqual(['Beta Serwis']);
    expect(await projectNames(pm, `?lead_id=${leadId}&partner_id=${partnerId}`)).toEqual([]);
    expect((await listProjects(pm, '?lead_id=abc')).status).toBe(400);
    expect((await listProjects(pm, '?partner_id=12')).status).toBe(400);
  });

  test('by my role in the project', async () => {
    expect(await projectNames(worker)).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    expect(await projectNames(worker, '?my_role=participant')).toEqual(['Alfa Wdrożenie', 'Listy Zadań']);
    expect(await projectNames(worker, '?my_role=controller')).toEqual(['Beta Serwis']);
    expect(await projectNames(worker, '?my_role=pm')).toEqual([]);
    expect(await projectNames(worker, '?my_role=pm,controller')).toEqual(['Beta Serwis']);
    expect(await projectNames(external, '?my_role=participant')).toEqual(['Listy Zadań']);
    // The admin sees every project but has no role in any.
    expect(await projectNames(admin)).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    expect(await projectNames(admin, '?my_role=pm')).toEqual([]);
    expect((await listProjects(pm, '?my_role=boss')).status).toBe(400);
  });

  test('by actual cost and revenue, for those who may read the project finance', async () => {
    const categoryId = (await setFinance(true)).body.cost_categories[0].id;
    const post = (target, kind, body) => api('post', `/api/projects/${target.id}/finance/${kind}`, pm).send(body);
    expect((await post(alfa, 'costs', { date: day(-5), amount: 500, category_id: categoryId })).status).toBe(201);
    expect((await post(alfa, 'costs', { date: day(-5), amount: 9000, category_id: categoryId, status: 'planned' })).status).toBe(201);
    expect((await post(beta, 'revenues', { date: day(-5), amount: 2000, status: 'invoiced' })).status).toBe(201);
    expect((await post(beta, 'revenues', { date: day(-5), amount: 7000, status: 'planned' })).status).toBe(201);
    try {
      expect(await projectNames(pm, '?cost_min=100')).toEqual(['Alfa Wdrożenie']);
      // Planned items do not count: Alfa's cost is 500, not 9500.
      expect(await projectNames(pm, '?cost_min=501')).toEqual([]);
      expect(await projectNames(pm, '?cost_max=0')).toEqual(['Beta Serwis', 'Listy Zadań']);
      expect(await projectNames(pm, '?revenue_min=1000&revenue_max=2000')).toEqual(['Beta Serwis']);
      expect(await projectNames(admin, '?revenue_min=2001')).toEqual([]);

      // The worker reads finance only where they are controller (Beta); elsewhere the filter lets the project through.
      expect(await projectNames(worker, '?cost_min=100')).toEqual(['Alfa Wdrożenie', 'Listy Zadań']);
      expect(await projectNames(worker, '?revenue_min=1000')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
      expect((await listProjects(pm, '?cost_min=-1')).status).toBe(400);
      expect((await listProjects(pm, '?revenue_max=lots')).status).toBe(400);
    } finally {
      await setFinance(false);
    }
    // With finance switched off the amounts are unknown to everyone: nothing is filtered out.
    expect(await projectNames(pm, '?cost_min=100')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
  });

  test('sortable by name, key, dates and delay', async () => {
    expect(await projectNames(pm, '?sort=name&order=desc')).toEqual(['Listy Zadań', 'Beta Serwis', 'Alfa Wdrożenie']);
    expect(await projectNames(pm, '?sort=key')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    expect(await projectNames(pm, '?sort=end_date')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    expect(await projectNames(pm, '?sort=end_date&order=desc')).toEqual(['Beta Serwis', 'Alfa Wdrożenie', 'Listy Zadań']);
    expect(await projectNames(pm, '?sort=start_date&order=desc')).toEqual(['Beta Serwis', 'Alfa Wdrożenie', 'Listy Zadań']);
    expect(await projectNames(pm, '?sort=delay')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    expect(await projectNames(pm, '?sort=delay&order=desc')).toEqual(['Beta Serwis', 'Listy Zadań', 'Alfa Wdrożenie']);
    expect((await listProjects(pm, '?sort=budget')).status).toBe(400);
  });

  test('the projects of the cross-project view take the same filters, sorting and paging', async () => {
    const overview = (queryString = '') => api('get', `/api/projects/portfolio/projects${queryString}`, pm);
    const res = await overview('?page_size=2&sort=name&order=desc');
    expect(res.body).toMatchObject({ total: 3, page: 1, page_size: 2 });
    expect(res.body.items.map((row) => row.name)).toEqual(['Listy Zadań', 'Beta Serwis']);
    expect((await overview('?delayed=true')).body.items.map((row) => row.name)).toEqual(['Alfa Wdrożenie']);
    expect((await overview(`?partner_id=${partnerId}`)).body.items.map((row) => row.name)).toEqual(['Beta Serwis']);
    // Closed projects are never in the view, whatever status is asked for.
    expect((await overview('?status=all')).body.total).toBe(3);
    expect((await overview('?page_size=100')).status).toBe(400);

    // The worker is controller of Beta only.
    const asController = await api('get', '/api/projects/portfolio/projects', worker);
    expect(asController.body.items.map((row) => row.name)).toEqual(['Beta Serwis']);
  });

  describe('every column of the overview: filters, sorting and lookups', () => {
    let secondPm, atRiskTask;
    const overviewNames = async (user, queryString = '') => {
      const res = await api('get', `/api/projects/portfolio/projects${queryString}`, user);
      expect(res.status).toBe(200);
      return res.body.items.map((row) => row.name);
    };

    // Alfa: 1 overdue + 1 done task (50 %), end date passed. Beta: 2 at-risk, 1 done and 1 task
    // ending after the project (25 %), PMs Adam and Piotr. "Listy Zadań": no tasks.
    beforeAll(async () => {
      secondPm = await mkUser('lpm2', 'Adam');
      expect((await api('post', `/api/projects/${beta.id}/members`, pm).send({ user_id: secondPm.id, role: 'pm' })).status).toBe(201);
      jest.spyOn(emailUtil, 'sendMail').mockResolvedValue();
      atRiskTask = await createTask({ name: 'Ryzyko 1', end_date: day(1) }, beta);
      await createTask({ name: 'Ryzyko 2', end_date: day(2) }, beta);
      await createTask({ name: 'Gotowe', status_id: statusByName['Zakończone'] }, beta);
      await createTask({ name: 'Po końcu projektu', end_date: day(70), status_id: statusByName['W toku'] }, beta);
    });

    afterAll(async () => {
      await db.query('DELETE FROM project_tasks WHERE project_id = $1', [beta.id]);
      await db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [beta.id, secondPm.id]);
    });

    test('a row carries progress_percent, the number the progress filter and sort use', async () => {
      const rows = (await listProjects(pm, '?sort=name')).body.items;
      expect(rows.map((row) => [row.name, row.progress_percent])).toEqual([
        ['Alfa Wdrożenie', 50], ['Beta Serwis', 25], ['Listy Zadań', 0],
      ]);
      expect(rows[0]).not.toHaveProperty('first_manager_name');
    });

    test('by PM', async () => {
      expect(await projectNames(pm, `?pm=${secondPm.id}`)).toEqual(['Beta Serwis']);
      expect(await projectNames(pm, `?pm=${pm.id}`)).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
      // A member who is not a PM of the project does not match.
      expect(await projectNames(admin, `?pm=${worker.id}`)).toEqual([]);
      expect(await overviewNames(pm, `?pm=${secondPm.id}`)).toEqual(['Beta Serwis']);
      expect((await listProjects(pm, '?pm=adam')).status).toBe(400);
    });

    test('by the number of overdue and at-risk tasks', async () => {
      expect(await projectNames(pm, '?overdue_min=1')).toEqual(['Alfa Wdrożenie']);
      expect(await projectNames(pm, '?overdue_max=0')).toEqual(['Beta Serwis', 'Listy Zadań']);
      expect(await projectNames(pm, '?overdue_min=2')).toEqual([]);
      expect(await projectNames(pm, '?at_risk_min=2&at_risk_max=2')).toEqual(['Beta Serwis']);
      expect(await projectNames(pm, '?at_risk_max=1')).toEqual(['Alfa Wdrożenie', 'Listy Zadań']);
      expect(await overviewNames(pm, '?at_risk_min=1')).toEqual(['Beta Serwis']);
      for (const queryString of ['?overdue_min=-1', '?overdue_max=many', '?at_risk_min=1.5', '?at_risk_max=-2']) {
        expect((await listProjects(pm, queryString)).status).toBe(400);
      }
    });

    test('by progress in percent; a project without tasks counts as 0', async () => {
      expect(await projectNames(pm, '?progress_min=25&progress_max=25')).toEqual(['Beta Serwis']);
      expect(await projectNames(pm, '?progress_min=26')).toEqual(['Alfa Wdrożenie']);
      expect(await projectNames(pm, '?progress_max=0')).toEqual(['Listy Zadań']);
      expect(await projectNames(pm, '?progress_min=0&progress_max=100')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
      expect(await overviewNames(pm, '?progress_min=50')).toEqual(['Alfa Wdrożenie']);
      for (const queryString of ['?progress_min=101', '?progress_max=-1', '?progress_min=half', '?progress_max=12.5']) {
        expect((await listProjects(pm, queryString)).status).toBe(400);
      }
    });

    test('by delay reason — any of the listed ones', async () => {
      expect(await projectNames(pm, '?delay_reason=end_passed')).toEqual(['Alfa Wdrożenie']);
      expect(await projectNames(pm, '?delay_reason=task_after_end')).toEqual(['Beta Serwis']);
      expect(await projectNames(pm, '?delay_reason=task_after_end,end_passed')).toEqual(['Alfa Wdrożenie', 'Beta Serwis']);
      expect(await projectNames(pm, '?delay_reason=end_passed&delayed=false')).toEqual([]);
      expect(await overviewNames(pm, '?delay_reason=task_after_end')).toEqual(['Beta Serwis']);
      expect((await listProjects(pm, '?delay_reason=late')).status).toBe(400);
      expect((await listProjects(pm, '?delay_reason=end_passed,late')).status).toBe(400);
    });

    test('sortable by PM, progress and the overdue and at-risk counts', async () => {
      // Alphabetically first PM: Adam (Beta), Piotr (the other two, kept in name order).
      expect(await projectNames(pm, '?sort=pm')).toEqual(['Beta Serwis', 'Alfa Wdrożenie', 'Listy Zadań']);
      expect(await projectNames(pm, '?sort=pm&order=desc')).toEqual(['Alfa Wdrożenie', 'Listy Zadań', 'Beta Serwis']);
      expect(await projectNames(pm, '?sort=progress')).toEqual(['Listy Zadań', 'Beta Serwis', 'Alfa Wdrożenie']);
      expect(await projectNames(pm, '?sort=progress&order=desc')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
      expect(await projectNames(pm, '?sort=overdue&order=desc')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
      expect(await projectNames(pm, '?sort=at_risk&order=desc')).toEqual(['Beta Serwis', 'Alfa Wdrożenie', 'Listy Zadań']);
      expect(await projectNames(pm, '?sort=at_risk')).toEqual(['Alfa Wdrożenie', 'Listy Zadań', 'Beta Serwis']);
      expect(await overviewNames(pm, '?sort=progress&order=desc')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    });

    test('sortable by cost and revenue; projects whose finance the viewer cannot read go last', async () => {
      const categoryId = (await setFinance(true)).body.cost_categories[0].id;
      const projectIds = [alfa.id, beta.id, project.id];
      await db.query('DELETE FROM project_cost_items WHERE project_id = ANY($1::uuid[])', [projectIds]);
      await db.query('DELETE FROM project_revenue_items WHERE project_id = ANY($1::uuid[])', [projectIds]);
      const post = (target, kind, body) => api('post', `/api/projects/${target.id}/finance/${kind}`, pm).send(body);
      expect((await post(alfa, 'costs', { date: day(-5), amount: 500, category_id: categoryId })).status).toBe(201);
      expect((await post(beta, 'costs', { date: day(-5), amount: 100, category_id: categoryId })).status).toBe(201);
      expect((await post(beta, 'revenues', { date: day(-5), amount: 2000, status: 'invoiced' })).status).toBe(201);
      expect((await post(project, 'revenues', { date: day(-5), amount: 300, status: 'paid' })).status).toBe(201);

      expect(await projectNames(pm, '?sort=cost')).toEqual(['Listy Zadań', 'Beta Serwis', 'Alfa Wdrożenie']);
      expect(await projectNames(pm, '?sort=cost&order=desc')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
      expect(await projectNames(admin, '?sort=revenue&order=desc')).toEqual(['Beta Serwis', 'Listy Zadań', 'Alfa Wdrożenie']);
      expect(await overviewNames(pm, '?sort=revenue')).toEqual(['Alfa Wdrożenie', 'Listy Zadań', 'Beta Serwis']);
      // The worker reads the finance of Beta only: it leads in both directions.
      expect(await projectNames(worker, '?sort=cost')).toEqual(['Beta Serwis', 'Alfa Wdrożenie', 'Listy Zadań']);
      expect(await projectNames(worker, '?sort=cost&order=desc')).toEqual(['Beta Serwis', 'Alfa Wdrożenie', 'Listy Zadań']);

      await setFinance(false);
      // Nobody reads finance now: the order falls back to the name.
      expect(await projectNames(pm, '?sort=cost&order=desc')).toEqual(['Alfa Wdrożenie', 'Beta Serwis', 'Listy Zadań']);
    });

    test('can_filter_finance: finance is on and the caller reads the finance of some project', async () => {
      const canFilter = async (user, url = '/api/projects') => (await api('get', url, user)).body.can_filter_finance;
      const closedOnlyPm = await mkUser('lclosedpm', 'Celina');
      await db.query(
        `INSERT INTO project_members (project_id, user_id, tenant_id, role, access_level) VALUES ($1, $2, $3, 'pm', 'full')`,
        [closed.id, closedOnlyPm.id, tenantId],
      );

      for (const user of [admin, pm, worker, external, closedOnlyPm]) expect(await canFilter(user)).toBe(false);
      expect(await canFilter(pm, '/api/projects/portfolio/projects')).toBe(false);

      await setFinance(true);
      expect(await canFilter(admin)).toBe(true);
      expect(await canFilter(pm)).toBe(true);
      // Controller of Beta; plain participant elsewhere.
      expect(await canFilter(worker)).toBe(true);
      expect(await canFilter(external)).toBe(false);
      // PM of a closed project only: nothing on the default list, but its finance is readable.
      expect((await listProjects(closedOnlyPm)).body).toMatchObject({ total: 0, can_filter_finance: true });
      expect(await canFilter(pm, '/api/projects/portfolio/projects')).toBe(true);
      expect(await canFilter(worker, '/api/projects/portfolio/projects')).toBe(true);
    });

    test('people of the scope: members and task assignees, by name', async () => {
      const peopleOf = (user) => api('get', '/api/projects/portfolio/people', user);
      const names = (res) => res.body.people.map((person) => person.display_name);

      const asPm = await peopleOf(pm);
      expect(asPm.status).toBe(200);
      expect(asPm.body).toMatchObject({ truncated: false, limit: 500 });
      expect(names(asPm)).toEqual(['Adam Test', 'Anna Test', 'Piotr Test', 'Zenon Test']);
      expect(asPm.body.people[0]).toEqual({ user_id: secondPm.id, display_name: 'Adam Test' });

      // The worker controls Beta only; the external participant of another project is out of that scope.
      expect(names(await peopleOf(worker))).toEqual(['Adam Test', 'Anna Test', 'Piotr Test']);
      // The scope of the admin is every open project; the admin is a member of none.
      expect(names(await peopleOf(admin))).toEqual(['Adam Test', 'Anna Test', 'Piotr Test', 'Zenon Test']);

      // Someone assigned to a task without being a member still counts.
      await db.query(
        'INSERT INTO project_task_assignees (task_id, user_id, tenant_id) VALUES ($1, $2, $3)',
        [atRiskTask.id, admin.id, tenantId],
      );
      expect(names(await peopleOf(worker))).toEqual(['Adam Test', 'Admin Test', 'Anna Test', 'Piotr Test']);

      expect((await peopleOf(external)).status).toBe(403);
    });

    test('project options of the scope: every project with its dates, by key', async () => {
      const optionsOf = (user) => api('get', '/api/projects/portfolio/project-options', user);

      const asPm = await optionsOf(pm);
      expect(asPm.status).toBe(200);
      expect(asPm.body).toMatchObject({ truncated: false, limit: 500 });
      const expectedKeys = [alfa, beta, project].map((option) => option.key).sort();
      expect(asPm.body.projects.map((option) => option.key)).toEqual(expectedKeys);
      expect(asPm.body.projects.find((option) => option.id === alfa.id)).toEqual({
        id: alfa.id, key: alfa.key, name: 'Alfa Wdrożenie', start_date: day(-30), end_date: day(-3),
      });
      expect(asPm.body.projects.find((option) => option.id === project.id)).toMatchObject({ start_date: null, end_date: null });
      // Closed projects are not in the scope.
      expect(asPm.body.projects.map((option) => option.id)).not.toContain(closed.id);

      expect((await optionsOf(worker)).body.projects.map((option) => option.name)).toEqual(['Beta Serwis']);
      expect((await optionsOf(external)).status).toBe(403);
    });

    test('both lookups are cut at 500 entries and say so', async () => {
      const { rows: bulkProjects } = await db.query(
        `INSERT INTO projects (tenant_id, key, name)
         SELECT $1, 'ZZ' || number, 'Masowy ' || number FROM generate_series(1000, 1500) AS number
         RETURNING id`,
        [tenantId],
      );
      await db.query(
        `INSERT INTO users (email, first_name, last_name, is_active, tenant_id)
         SELECT 'bulk' || number || $1, 'Masowy', 'Nr' || number, TRUE, $2 FROM generate_series(1000, 1500) AS number`,
        [EMAIL_DOMAIN, tenantId],
      );
      await db.query(
        `INSERT INTO project_members (project_id, user_id, tenant_id, role, access_level)
         SELECT $1, id, $2, 'internal_participant', 'full' FROM users WHERE email LIKE $3`,
        [bulkProjects[0].id, tenantId, `bulk%${EMAIL_DOMAIN}`],
      );
      try {
        const options = (await api('get', '/api/projects/portfolio/project-options', admin)).body;
        expect(options).toMatchObject({ truncated: true, limit: 500 });
        expect(options.projects).toHaveLength(500);

        const people = (await api('get', '/api/projects/portfolio/people', admin)).body;
        expect(people).toMatchObject({ truncated: true, limit: 500 });
        expect(people.people).toHaveLength(500);
      } finally {
        await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [bulkProjects.map((row) => row.id)]);
        await db.query('DELETE FROM users WHERE email LIKE $1', [`bulk%${EMAIL_DOMAIN}`]);
      }
    });
  });
});
