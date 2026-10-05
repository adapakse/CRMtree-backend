'use strict';

// Project finance — the tenant switch, cost categories, budget and currency
// lock, cost and revenue items, currency conversion, the summary figures, and
// who may see or change what (project roles, the "participants may add costs"
// option, closed projects, the CRM card of a non-member).
//
// Multi-tenant: everything is created under one dedicated test tenant and
// cleaned up by tenant_id. Exchange-rate fixtures live in 1999, before the NBP
// archive starts, so they never collide with real rates; the NBP API is
// always replaced.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const { signAccessToken } = require('../middleware/auth');
const exchangeRateService = require('../services/exchangeRateService');

const SLUG            = 'zz-project-finance-test';
const EMAIL_DOMAIN    = '@project-finance-test.crmtree.local';
const FIXTURE_ERA_END = '2000-01-01';
const DEFAULT_CATEGORY_NAMES = ['Praca własna', 'Podwykonawcy', 'Materiały', 'Licencje', 'Podróże', 'Inne'];

let tenantId;
let admin, pm, worker, external, controller, outsider, accountOwner;
let project, categoryByName, leadId, partnerId;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);
const financeUrl = (suffix = '') => `/api/projects/${project.id}/finance${suffix}`;
const setFinanceSwitch = (isEnabled, user = admin) =>
  api('put', '/api/admin/project-config/finance', user).send({ is_enabled: isEnabled });
const patchPlan = (user, body) => api('patch', financeUrl(), user).send(body);
const getSummary = async (user = pm) => (await api('get', financeUrl(), user)).body;

async function mkUser(local, { isAdmin = false, isExternal = false, canCreate = false, crmRole = null } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id, is_external,
                        can_create_projects, crm_role)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5, $6, $7) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, isAdmin, tenantId, isExternal, canCreate, crmRole],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

async function clearRateFixtures() {
  await db.query('DELETE FROM nbp_exchange_rates WHERE rate_date < $1', [FIXTURE_ERA_END]);
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
  await clearRateFixtures();
}

async function createTask(body = {}) {
  const res = await api('post', `/api/projects/${project.id}/tasks`, pm).send({ name: 'Zadanie', ...body });
  expect(res.status).toBe(201);
  return res.body;
}

const costBody = (overrides = {}) => ({
  date: '2026-09-15', amount: 100, category_id: categoryByName['Materiały'], ...overrides,
});

async function addCost(overrides = {}, user = pm) {
  const res = await api('post', financeUrl('/costs'), user).send(costBody(overrides));
  expect(res.status).toBe(201);
  return res.body;
}

async function addRevenue(overrides = {}) {
  const res = await api('post', financeUrl('/revenues'), pm)
    .send({ date: '2026-09-20', amount: 1000, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

const allowParticipantCosts = () => patchPlan(pm, { participants_can_add_costs: true });

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Project Finance Test', $1, TRUE)
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

  admin        = await mkUser('fadmin', { isAdmin: true });
  pm           = await mkUser('fpm', { canCreate: true });
  worker       = await mkUser('fworker');
  external     = await mkUser('fexternal', { isExternal: true });
  controller   = await mkUser('fcontroller');
  outsider     = await mkUser('foutsider');
  accountOwner = await mkUser('fowner', { crmRole: 'salesperson' });

  const { rows: [lead] } = await db.query(
    `INSERT INTO crm_leads (company, stage, assigned_to, created_by, tenant_id)
     VALUES ('Lead Finansowy', 'new', $1, $1, $2) RETURNING id`,
    [accountOwner.id, tenantId],
  );
  leadId = lead.id;
  const { rows: [partner] } = await db.query(
    `INSERT INTO crm_partners (company, status, manager_id, tenant_id)
     VALUES ('Partner Finansowy', 'active', $1, $2) RETURNING id`,
    [accountOwner.id, tenantId],
  );
  partnerId = partner.id;

  project = (await api('post', '/api/projects', pm).send({ name: 'Projekt Finansowy' })).body;
  for (const member of [
    { user_id: worker.id,     role: 'internal_participant', access_level: 'full' },
    { user_id: external.id,   role: 'external_participant', access_level: 'full' },
    { user_id: controller.id, role: 'controller' },
  ]) {
    await api('post', `/api/projects/${project.id}/members`, pm).send(member);
  }

  expect((await setFinanceSwitch(true)).status).toBe(200);
  const { body: config } = await api('get', '/api/projects/config', admin);
  categoryByName = Object.fromEntries(config.cost_categories.map((category) => [category.name, category.id]));
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

beforeEach(async () => {
  for (const table of ['project_cost_items', 'project_revenue_items', 'project_category_budgets', 'project_finance', 'project_tasks']) {
    await db.query(`DELETE FROM ${table} WHERE project_id = $1`, [project.id]);
  }
  await db.query(
    `UPDATE projects SET status = 'open', closed_at = NULL, closed_by = NULL, lead_id = NULL, partner_id = NULL
     WHERE id = $1`,
    [project.id],
  );
  jest.spyOn(emailUtil, 'sendProjectTaskAssigned').mockResolvedValue();
  jest.spyOn(global, 'fetch').mockResolvedValue({ status: 404, ok: false, json: async () => null });
});

afterEach(() => jest.restoreAllMocks());

describe('tenant switch', () => {
  test('only the tenant admin switches project finance', async () => {
    expect((await setFinanceSwitch(false, pm)).status).toBe(403);
  });

  test('the configuration carries the switch and the six default cost categories', async () => {
    const { body: config } = await api('get', '/api/projects/config', worker);
    expect(config.finance_enabled).toBe(true);
    expect(config.cost_categories.map((category) => category.name)).toEqual(DEFAULT_CATEGORY_NAMES);
    expect(config.cost_categories.every((category) => category.is_active)).toBe(true);
  });

  test('switched off: every finance endpoint answers 403 and no response carries finance data', async () => {
    const cost = await addCost();
    const revenue = await addRevenue();
    await db.query('UPDATE projects SET lead_id = $1 WHERE id = $2', [leadId, project.id]);

    expect((await setFinanceSwitch(false)).body).toMatchObject({ finance_enabled: false, cost_categories: [] });
    try {
      const calls = [
        ['get', ''], ['patch', ''],
        ['get', '/costs'], ['post', '/costs'], ['patch', `/costs/${cost.id}`], ['delete', `/costs/${cost.id}`],
        ['get', '/revenues'], ['post', '/revenues'],
        ['patch', `/revenues/${revenue.id}`], ['delete', `/revenues/${revenue.id}`],
        ['put', `/tasks/${cost.id}/planned-cost`],
      ];
      for (const [method, suffix] of calls) {
        const pending = api(method, financeUrl(suffix), admin);
        const res = await (method === 'get' ? pending : pending.send(costBody()));
        expect([method, suffix, res.status]).toEqual([method, suffix, 403]);
      }
      const categoryAttempt = await api('post', '/api/admin/project-config/dictionaries/cost-categories', admin)
        .send({ name: 'Szkolenia' });
      expect(categoryAttempt.status).toBe(403);

      expect((await api('get', `/api/projects/${project.id}`, pm)).body.finance).toBeNull();
      const list = await api('get', '/api/projects', pm);
      expect(list.body.projects[0].finance).toBeNull();
      const card = await api('get', `/api/crm/leads/${leadId}/projects`, accountOwner);
      expect(card.body[0].finance).toBeNull();
    } finally {
      await setFinanceSwitch(true);
    }
    // Switching off hides the data; it does not remove it.
    expect((await api('get', financeUrl('/costs'), pm)).body).toHaveLength(1);
  });
});

describe('cost categories', () => {
  const categoriesUrl = '/api/admin/project-config/dictionaries/cost-categories';

  test('only the tenant admin edits the dictionary; names are unique', async () => {
    expect((await api('post', categoriesUrl, pm).send({ name: 'Marketing' })).status).toBe(403);

    const created = await api('post', categoriesUrl, admin).send({ name: 'Marketing' });
    expect(created.status).toBe(200);
    expect(created.body.cost_categories.at(-1)).toMatchObject({ name: 'Marketing', is_active: true });
    expect((await api('post', categoriesUrl, admin).send({ name: 'Marketing' })).status).toBe(409);
  });

  test('there is no endpoint to delete a category', async () => {
    const res = await api('delete', `${categoriesUrl}/${categoryByName.Inne}`, admin);
    expect(res.status).toBe(404);
  });

  test('a deactivated category stays on existing items and budgets, but cannot be chosen anew', async () => {
    const created = await api('post', categoriesUrl, admin).send({ name: 'Szkolenia' });
    const trainingId = created.body.cost_categories.find((category) => category.name === 'Szkolenia').id;
    const item = await addCost({ category_id: trainingId, amount: 70 });
    await patchPlan(pm, { category_budgets: [{ category_id: trainingId, planned_cost: 500 }] });

    const deactivated = await api('patch', `${categoriesUrl}/${trainingId}`, admin).send({ is_active: false });
    expect(deactivated.status).toBe(200);

    expect((await api('post', financeUrl('/costs'), pm).send(costBody({ category_id: trainingId }))).status).toBe(400);
    const moved = await addCost();
    expect((await api('patch', financeUrl(`/costs/${moved.id}`), pm).send({ category_id: trainingId })).status)
      .toBe(400);

    const listed = (await api('get', financeUrl('/costs'), pm)).body.find((cost) => cost.id === item.id);
    expect(listed).toMatchObject({ category_id: trainingId, category_name: 'Szkolenia' });
    expect((await api('patch', financeUrl(`/costs/${item.id}`), pm).send({ amount: 80 })).status).toBe(200);

    const resaved = await patchPlan(pm, { category_budgets: [{ category_id: trainingId, planned_cost: 600 }] });
    expect(resaved.status).toBe(200);
    expect(resaved.body.categories.find((row) => row.category_id === trainingId))
      .toMatchObject({ is_active: false, budget: 600, incurred: 80 });

    await patchPlan(pm, { category_budgets: [] });
    const anew = await patchPlan(pm, { category_budgets: [{ category_id: trainingId, planned_cost: 600 }] });
    expect(anew.status).toBe(400);
  });
});

describe('budget and currency', () => {
  test('PM sets the currency, planned revenue and category budgets', async () => {
    const res = await patchPlan(pm, {
      currency: 'EUR',
      planned_revenue: 10000,
      category_budgets: [
        { category_id: categoryByName['Materiały'], planned_cost: 3000 },
        { category_id: categoryByName.Podwykonawcy, planned_cost: 2000.559 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currency: 'EUR',
      is_currency_locked: false,
      revenue: { planned: 10000, actual: 0 },
      cost: { planned: 5000.56, actual: 0 },
    });
  });

  test('a project starts in PLN with no plan', async () => {
    expect(await getSummary()).toMatchObject({
      currency: 'PLN',
      participants_can_add_costs: false,
      revenue: { planned: null, actual: 0, by_status: { planned: 0, invoiced: 0, paid: 0 } },
      cost: { planned: 0, actual: 0, planned_items: 0, task_planned_total: 0 },
      margin: { planned: { amount: null, percent: null }, actual: { amount: 0, percent: null } },
      remaining_budget: 0,
      tasks: [],
    });
  });

  test('the currency is locked while the project has a cost or revenue item', async () => {
    const cost = await addCost();
    expect((await getSummary()).is_currency_locked).toBe(true);
    expect((await patchPlan(pm, { currency: 'EUR' })).status).toBe(409);
    // Sending the unchanged currency along with other fields is not a change.
    expect((await patchPlan(pm, { currency: 'PLN', planned_revenue: 5 })).status).toBe(200);

    await api('delete', financeUrl(`/costs/${cost.id}`), pm);
    const revenue = await addRevenue();
    expect((await patchPlan(pm, { currency: 'EUR' })).status).toBe(409);

    await api('delete', financeUrl(`/revenues/${revenue.id}`), pm);
    expect((await patchPlan(pm, { currency: 'EUR' })).body.currency).toBe('EUR');
  });

  test('invalid plans are rejected', async () => {
    expect((await patchPlan(pm, { currency: 'eur' })).status).toBe(400);
    expect((await patchPlan(pm, { currency: 'ABC' })).status).toBe(400);
    expect((await patchPlan(pm, { planned_revenue: -1 })).status).toBe(400);
    const category = categoryByName.Inne;
    expect((await patchPlan(pm, { category_budgets: [{ category_id: category, planned_cost: -5 }] })).status).toBe(400);
    expect((await patchPlan(pm, {
      category_budgets: [{ category_id: category, planned_cost: 1 }, { category_id: category, planned_cost: 2 }],
    })).status).toBe(400);
    expect((await patchPlan(pm, { category_budgets: [{ category_id: project.id, planned_cost: 1 }] })).status).toBe(400);
  });

  test('a task planned cost is reported next to the budget and stays out of task responses', async () => {
    const task = await createTask();
    await patchPlan(pm, { category_budgets: [{ category_id: categoryByName.Inne, planned_cost: 1000 }] });

    const res = await api('put', financeUrl(`/tasks/${task.id}/planned-cost`), pm).send({ planned_cost: 250 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ task_id: task.id, planned_cost: 250 });

    const summary = await getSummary();
    expect(summary.cost).toMatchObject({ planned: 1000, task_planned_total: 250 });
    expect(summary.tasks).toEqual([expect.objectContaining({ task_id: task.id, planned_cost: 250, total_incurred: 0 })]);

    const taskView = await api('get', `/api/projects/${project.id}/tasks/${task.id}`, worker);
    expect(taskView.body).not.toHaveProperty('planned_cost');

    await api('put', financeUrl(`/tasks/${task.id}/planned-cost`), pm).send({ planned_cost: null });
    expect((await getSummary()).tasks).toEqual([]);
    expect((await api('put', financeUrl(`/tasks/${project.id}/planned-cost`), pm).send({ planned_cost: 1 })).status)
      .toBe(404);
  });
});

describe('cost items', () => {
  test('PM adds, edits and deletes a cost item', async () => {
    const task = await createTask();
    const created = await addCost({
      task_id: task.id, description: 'Kable', supplier_name: 'Hurtownia', document_number: 'FV/1/2026', status: 'planned',
    });
    expect(created).toMatchObject({
      project_id: project.id, date: '2026-09-15', amount: 100, status: 'planned',
      category_id: categoryByName['Materiały'], category_name: 'Materiały',
      task_id: task.id, task_number: task.task_number, description: 'Kable',
      supplier_name: 'Hurtownia', document_number: 'FV/1/2026',
      original_amount: null, original_currency: null, exchange_rate: null, exchange_rate_date: null,
      created_by: pm.id,
    });

    const updated = await api('patch', financeUrl(`/costs/${created.id}`), pm)
      .send({ amount: 120.5, status: 'incurred', task_id: null });
    expect(updated.body).toMatchObject({ amount: 120.5, status: 'incurred', task_id: null, description: 'Kable' });

    expect((await api('delete', financeUrl(`/costs/${created.id}`), pm)).status).toBe(204);
    expect((await api('get', financeUrl('/costs'), pm)).body).toEqual([]);
    expect((await api('delete', financeUrl(`/costs/${created.id}`), pm)).status).toBe(404);
  });

  test('a new item is "incurred" unless said otherwise, and can be filtered by task', async () => {
    const task = await createTask();
    const onTask = await addCost({ task_id: task.id });
    await addCost();
    expect(onTask.status).toBe('incurred');

    const filtered = await api('get', financeUrl(`/costs?task_id=${task.id}`), pm);
    expect(filtered.body.map((cost) => cost.id)).toEqual([onTask.id]);
  });

  test('invalid items are rejected', async () => {
    const post = (body) => api('post', financeUrl('/costs'), pm).send(body);
    expect((await post(costBody({ amount: 0 }))).status).toBe(400);
    expect((await post(costBody({ amount: -10 }))).status).toBe(400);
    expect((await post(costBody({ amount: undefined }))).status).toBe(400);
    expect((await post(costBody({ category_id: undefined }))).status).toBe(400);
    expect((await post(costBody({ category_id: project.id }))).status).toBe(400);
    expect((await post(costBody({ date: '15.09.2026' }))).status).toBe(400);
    expect((await post(costBody({ status: 'paid' }))).status).toBe(400);
    expect((await post(costBody({ amount: undefined, original_amount: 10 }))).status).toBe(400);
  });

  test('the task must belong to the same project', async () => {
    const other = (await api('post', '/api/projects', pm).send({ name: 'Inny Projekt' })).body;
    const foreignTask = (await api('post', `/api/projects/${other.id}/tasks`, pm).send({ name: 'Obce' })).body;
    const res = await api('post', financeUrl('/costs'), pm).send(costBody({ task_id: foreignTask.id }));
    expect(res.status).toBe(400);
  });

  test('every change is in the audit log, but not in the history of the task', async () => {
    const task = await createTask();
    const cost = await addCost({ task_id: task.id });
    await api('patch', financeUrl(`/costs/${cost.id}`), pm).send({ amount: 150 });
    await api('delete', financeUrl(`/costs/${cost.id}`), pm);

    const { rows } = await db.query(
      `SELECT action, before_state, after_state, metadata FROM audit_logs
       WHERE tenant_id = $1 AND metadata->>'cost_item_id' = $2 ORDER BY created_at`,
      [tenantId, cost.id],
    );
    expect(rows.map((row) => row.action))
      .toEqual(['project_cost_created', 'project_cost_updated', 'project_cost_deleted']);
    expect(rows[0].after_state).toMatchObject({ amount: 100, task_id: task.id });
    expect(rows[1]).toMatchObject({ before_state: { amount: 100 }, after_state: { amount: 150 } });
    expect(rows[2].before_state).toMatchObject({ amount: 150 });
    expect(rows.every((row) => row.metadata.project_id === project.id && !('task_id' in row.metadata))).toBe(true);

    const history = await api('get', `/api/projects/${project.id}/tasks/${task.id}/history`, worker);
    expect(history.body.map((entry) => entry.action)).toEqual(['project_task_created']);
  });
});

describe('costs entered in another currency', () => {
  // 1999-03-06 and 07 are a weekend.
  beforeEach(async () => {
    await clearRateFixtures();
    for (const [currency, rateDate, midRate] of [
      ['EUR', '1999-03-05', 4.10], ['USD', '1999-03-05', 3.60], ['EUR', '1999-03-08', 4.20], ['USD', '1999-03-08', 3.70],
    ]) {
      await db.query(
        'INSERT INTO nbp_exchange_rates (currency, rate_date, mid_rate) VALUES ($1, $2, $3)',
        [currency, rateDate, midRate],
      );
    }
  });

  const foreignCost = (overrides = {}) => costBody({
    amount: undefined, original_amount: 100, original_currency: 'EUR', date: '1999-03-08', ...overrides,
  });

  test('the amount is computed with the NBP rate of the business day before the cost date', async () => {
    const res = await api('post', financeUrl('/costs'), pm).send(foreignCost());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amount: 410, original_amount: 100, original_currency: 'EUR',
      exchange_rate: 4.1, exchange_rate_date: '1999-03-05',
    });
  });

  test('an explicit amount always wins and no rate is recorded', async () => {
    const res = await api('post', financeUrl('/costs'), pm).send(foreignCost({ amount: 500 }));
    expect(res.body).toMatchObject({
      amount: 500, original_amount: 100, original_currency: 'EUR', exchange_rate: null, exchange_rate_date: null,
    });
  });

  test('the project currency itself needs no conversion', async () => {
    const res = await api('post', financeUrl('/costs'), pm).send(foreignCost({ original_currency: 'PLN' }));
    expect(res.body).toMatchObject({ amount: 100, original_amount: null, original_currency: null, exchange_rate: null });
  });

  test('a project in a foreign currency converts through PLN', async () => {
    await patchPlan(pm, { currency: 'USD' });
    const res = await api('post', financeUrl('/costs'), pm).send(foreignCost());
    expect(res.body).toMatchObject({ amount: 113.89, exchange_rate: 1.13888889, exchange_rate_date: '1999-03-05' });

    const fromPln = await api('post', financeUrl('/costs'), pm)
      .send(foreignCost({ original_amount: 360, original_currency: 'PLN' }));
    expect(fromPln.body).toMatchObject({ amount: 100, original_amount: 360, original_currency: 'PLN' });
  });

  test('no rate available is a 4xx with a message, never a silent rate of 1', async () => {
    const res = await api('post', financeUrl('/costs'), pm).send(foreignCost({ date: '1999-06-15' }));
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('EUR');
    expect((await api('post', financeUrl('/costs'), pm).send(foreignCost({ original_currency: 'ABC' }))).status)
      .toBe(400);
  });

  test('editing recalculates only when the request touches the money', async () => {
    const created = (await api('post', financeUrl('/costs'), pm).send(foreignCost())).body;
    const url = financeUrl(`/costs/${created.id}`);

    const moved = await api('patch', url, pm).send({ date: '1999-03-09' });
    expect(moved.body).toMatchObject({ date: '1999-03-09', amount: 410, exchange_rate_date: '1999-03-05' });

    const recalculated = await api('patch', url, pm).send({ original_amount: 200 });
    expect(recalculated.body).toMatchObject({
      amount: 840, original_amount: 200, exchange_rate: 4.2, exchange_rate_date: '1999-03-08',
    });

    const overridden = await api('patch', url, pm).send({ amount: 800 });
    expect(overridden.body).toMatchObject({
      amount: 800, original_amount: 200, original_currency: 'EUR', exchange_rate: null, exchange_rate_date: null,
    });
  });
});

describe('revenue items', () => {
  test('PM adds, edits and deletes a revenue item; statuses feed the summary', async () => {
    const planned = await addRevenue({ description: 'Etap 1' });
    expect(planned).toMatchObject({
      project_id: project.id, date: '2026-09-20', amount: 1000, status: 'planned', description: 'Etap 1', created_by: pm.id,
    });
    await addRevenue({ amount: 2000, status: 'invoiced' });
    const paid = await addRevenue({ amount: 1500, status: 'paid' });

    expect((await getSummary()).revenue).toEqual({
      planned: null, actual: 3500, by_status: { planned: 1000, invoiced: 2000, paid: 1500 },
    });

    const updated = await api('patch', financeUrl(`/revenues/${planned.id}`), pm).send({ status: 'invoiced', amount: 1100 });
    expect(updated.body).toMatchObject({ status: 'invoiced', amount: 1100 });
    expect((await api('delete', financeUrl(`/revenues/${paid.id}`), pm)).status).toBe(204);

    expect((await getSummary()).revenue).toMatchObject({ actual: 3100, by_status: { planned: 0, invoiced: 3100, paid: 0 } });
    expect((await api('get', financeUrl('/revenues'), pm)).body).toHaveLength(2);
  });

  test('invalid items are rejected and changes are audited', async () => {
    const post = (body) => api('post', financeUrl('/revenues'), pm).send(body);
    expect((await post({ date: '2026-09-20', amount: 0 })).status).toBe(400);
    expect((await post({ amount: 10 })).status).toBe(400);
    expect((await post({ date: '2026-09-20', amount: 10, status: 'incurred' })).status).toBe(400);

    const revenue = await addRevenue();
    await api('delete', financeUrl(`/revenues/${revenue.id}`), pm);
    const { rows } = await db.query(
      `SELECT action FROM audit_logs WHERE tenant_id = $1 AND metadata->>'revenue_item_id' = $2 ORDER BY created_at`,
      [tenantId, revenue.id],
    );
    expect(rows.map((row) => row.action)).toEqual(['project_revenue_created', 'project_revenue_deleted']);
  });
});

describe('summary', () => {
  test('plan, actuals, margins, the category table and the roll-up over subtasks', async () => {
    const parent = await createTask({ name: 'Etap' });
    const child = await createTask({ name: 'Podetap', parent_task_id: parent.id });
    const grandchild = await createTask({ name: 'Czynność', parent_task_id: child.id });
    const materials = categoryByName['Materiały'];
    const subcontractors = categoryByName.Podwykonawcy;
    const licences = categoryByName.Licencje;

    await patchPlan(pm, {
      planned_revenue: 10000,
      category_budgets: [
        { category_id: materials, planned_cost: 3000 },
        { category_id: subcontractors, planned_cost: 2000 },
      ],
    });
    await api('put', financeUrl(`/tasks/${parent.id}/planned-cost`), pm).send({ planned_cost: 700 });
    await addCost({ task_id: parent.id, amount: 100, category_id: materials });
    await addCost({ task_id: child.id, amount: 200, category_id: materials });
    await addCost({ task_id: child.id, amount: 50, category_id: subcontractors, status: 'planned' });
    await addCost({ task_id: grandchild.id, amount: 300, category_id: subcontractors });
    await addCost({ amount: 40, category_id: licences });
    await addRevenue({ amount: 1000, status: 'planned' });
    await addRevenue({ amount: 2000, status: 'invoiced' });
    await addRevenue({ amount: 1500, status: 'paid' });

    const summary = await getSummary(controller);
    expect(summary).toMatchObject({
      currency: 'PLN',
      is_currency_locked: true,
      revenue: { planned: 10000, actual: 3500, by_status: { planned: 1000, invoiced: 2000, paid: 1500 } },
      cost: { planned: 5000, actual: 640, planned_items: 50, task_planned_total: 700 },
      margin: {
        planned: { amount: 5000, percent: 50 },
        actual: { amount: 2860, percent: 81.71 },
      },
      remaining_budget: 4360,
      suggested_planned_revenue: null,
    });

    const categoryRow = (id) => summary.categories.find((row) => row.category_id === id);
    // Categories added by other tests of this suite sort after the defaults.
    expect(summary.categories.map((row) => row.name).slice(0, 6)).toEqual(DEFAULT_CATEGORY_NAMES);
    expect(categoryRow(materials))
      .toMatchObject({ budget: 3000, incurred: 300, planned: 0, variance: 2700, is_over_budget: false });
    expect(categoryRow(subcontractors))
      .toMatchObject({ budget: 2000, incurred: 300, planned: 50, variance: 1700, is_over_budget: false });
    expect(categoryRow(licences))
      .toMatchObject({ budget: 0, incurred: 40, planned: 0, variance: -40, is_over_budget: true });

    expect(summary.tasks).toEqual([
      expect.objectContaining({
        task_id: parent.id, parent_task_id: null, planned_cost: 700,
        own_incurred: 100, own_planned: 0, total_incurred: 600, total_planned: 50,
      }),
      expect.objectContaining({
        task_id: child.id, parent_task_id: parent.id, planned_cost: null,
        own_incurred: 200, own_planned: 50, total_incurred: 500, total_planned: 50,
      }),
      expect.objectContaining({
        task_id: grandchild.id, parent_task_id: child.id,
        own_incurred: 300, own_planned: 0, total_incurred: 300, total_planned: 0,
      }),
    ]);
  });

  test('suggests the linked lead’s value as planned revenue until one is set — and writes nothing', async () => {
    await db.query(
      `UPDATE crm_leads SET value_pln = 20000, annual_turnover_currency = 'PLN' WHERE id = $1`, [leadId],
    );
    expect((await getSummary()).suggested_planned_revenue).toBeNull();

    await db.query('UPDATE projects SET lead_id = $1 WHERE id = $2', [leadId, project.id]);
    const suggested = await getSummary();
    expect(suggested.suggested_planned_revenue).toBe(20000);
    expect(suggested.revenue.planned).toBeNull();

    await patchPlan(pm, { planned_revenue: 18000 });
    expect((await getSummary()).suggested_planned_revenue).toBeNull();
  });

  test('a lead valued in another currency is converted with the newest rate, or not suggested at all', async () => {
    await db.query(
      `UPDATE crm_leads SET value_pln = 1000, annual_turnover_currency = 'EUR' WHERE id = $1`, [leadId],
    );
    await db.query('UPDATE projects SET lead_id = $1 WHERE id = $2', [leadId, project.id]);
    const rate = await exchangeRateService.getLatestCrossRate('EUR', 'PLN');

    const { suggested_planned_revenue: suggestion } = await getSummary();
    if (rate === null) expect(suggestion).toBeNull();
    else expect(suggestion).toBeCloseTo(1000 * rate, 1);
  });
});

describe('permissions', () => {
  const expectStatuses = async (user, calls, status) => {
    for (const [method, suffix, body] of calls) {
      const pending = api(method, financeUrl(suffix), user);
      const res = await (body ? pending.send(body) : pending);
      expect([method, suffix, res.status]).toEqual([method, suffix, status]);
    }
  };

  test('PM and the tenant admin read and write everything', async () => {
    for (const user of [pm, admin]) {
      expect((await patchPlan(user, { planned_revenue: 100 })).status).toBe(200);
      const cost = await addCost({}, user);
      expect((await api('patch', financeUrl(`/costs/${cost.id}`), user).send({ amount: 5 })).status).toBe(200);
      expect((await api('post', financeUrl('/revenues'), user).send({ date: '2026-09-20', amount: 10 })).status)
        .toBe(201);
      expect((await api('get', financeUrl(), user)).status).toBe(200);
      expect((await api('get', `/api/projects/${project.id}`, user)).body.finance)
        .toEqual({ currency: 'PLN', can_read: true, can_write: true, can_add_own_costs: false });
    }
  });

  test('the controller reads everything and writes nothing', async () => {
    const task = await createTask();
    const cost = await addCost();
    const revenue = await addRevenue();

    await expectStatuses(controller, [['get', ''], ['get', '/costs'], ['get', '/revenues']], 200);
    expect((await api('get', financeUrl('/costs'), controller)).body).toHaveLength(1);
    await expectStatuses(controller, [
      ['patch', '', { planned_revenue: 1 }],
      ['put', `/tasks/${task.id}/planned-cost`, { planned_cost: 1 }],
      ['post', '/costs', costBody()],
      ['patch', `/costs/${cost.id}`, { amount: 1 }],
      ['delete', `/costs/${cost.id}`],
      ['post', '/revenues', { date: '2026-09-20', amount: 10 }],
      ['patch', `/revenues/${revenue.id}`, { amount: 1 }],
      ['delete', `/revenues/${revenue.id}`],
    ], 403);
    expect((await api('get', `/api/projects/${project.id}`, controller)).body.finance)
      .toEqual({ currency: 'PLN', can_read: true, can_write: false, can_add_own_costs: false });
  });

  test('an internal participant sees no finance at all by default', async () => {
    const task = await createTask({ assignee_ids: [worker.id] });
    await addCost({ task_id: task.id });

    await expectStatuses(worker, [
      ['get', ''], ['get', '/costs'], ['get', '/revenues'],
      ['post', '/costs', costBody({ task_id: task.id })],
      ['patch', '', { participants_can_add_costs: true }],
    ], 403);
    expect((await api('get', `/api/projects/${project.id}`, worker)).body.finance).toBeNull();
  });

  test('with the PM’s option on, a participant adds costs to own tasks and manages only own items', async () => {
    const ownTask = await createTask({ name: 'Moje', assignee_ids: [worker.id] });
    const foreignTask = await createTask({ name: 'Cudze', assignee_ids: [pm.id] });
    const pmCost = await addCost({ task_id: ownTask.id, amount: 999 });
    expect((await allowParticipantCosts()).body.participants_can_add_costs).toBe(true);

    expect((await api('get', `/api/projects/${project.id}`, worker)).body.finance)
      .toEqual({ currency: 'PLN', can_read: false, can_write: false, can_add_own_costs: true });

    const own = await addCost({ task_id: ownTask.id, amount: 30 }, worker);
    expect(own).toMatchObject({ task_id: ownTask.id, amount: 30, created_by: worker.id });
    expect((await api('post', financeUrl('/costs'), worker).send(costBody({ task_id: foreignTask.id }))).status).toBe(403);
    expect((await api('post', financeUrl('/costs'), worker).send(costBody())).status).toBe(403);

    const listed = await api('get', financeUrl('/costs'), worker);
    expect(listed.body.map((cost) => cost.id)).toEqual([own.id]);

    expect((await api('patch', financeUrl(`/costs/${own.id}`), worker).send({ amount: 35 })).body.amount).toBe(35);
    expect((await api('patch', financeUrl(`/costs/${own.id}`), worker).send({ task_id: foreignTask.id })).status).toBe(403);
    expect((await api('patch', financeUrl(`/costs/${own.id}`), worker).send({ task_id: null })).status).toBe(403);
    expect((await api('patch', financeUrl(`/costs/${pmCost.id}`), worker).send({ amount: 1 })).status).toBe(404);
    expect((await api('delete', financeUrl(`/costs/${pmCost.id}`), worker)).status).toBe(404);

    await expectStatuses(worker, [
      ['get', ''], ['get', '/revenues'],
      ['patch', '', { planned_revenue: 1 }],
      ['put', `/tasks/${ownTask.id}/planned-cost`, { planned_cost: 1 }],
      ['post', '/revenues', { date: '2026-09-20', amount: 10 }],
    ], 403);

    expect((await api('delete', financeUrl(`/costs/${own.id}`), worker)).status).toBe(204);
    // The PM still sees and owns everything, including what the participant entered.
    expect((await api('get', financeUrl('/costs'), pm)).body.map((cost) => cost.id)).toEqual([pmCost.id]);

    await patchPlan(pm, { participants_can_add_costs: false });
    expect((await api('get', financeUrl('/costs'), worker)).status).toBe(403);
  });

  test('an external participant never sees or writes anything financial, option or not', async () => {
    const task = await createTask({ assignee_ids: [external.id] });
    await allowParticipantCosts();

    await expectStatuses(external, [
      ['get', ''], ['get', '/costs'], ['get', '/revenues'],
      ['post', '/costs', costBody({ task_id: task.id })],
      ['post', '/revenues', { date: '2026-09-20', amount: 10 }],
    ], 403);
    const card = await api('get', `/api/projects/${project.id}`, external);
    expect(card.body.finance).toBeNull();
    expect(JSON.stringify(card.body)).not.toMatch(/planned_revenue|participants_can_add_costs|currency/);
  });

  test('someone outside the project gets 404, as for the project itself', async () => {
    await expectStatuses(outsider, [['get', ''], ['get', '/costs'], ['post', '/costs', costBody()]], 404);
  });

  test('a closed project is read-only', async () => {
    const task = await createTask({ assignee_ids: [worker.id] });
    const cost = await addCost();
    const revenue = await addRevenue();
    await allowParticipantCosts();
    await api('post', `/api/projects/${project.id}/close`, pm);

    await expectStatuses(pm, [['get', ''], ['get', '/costs'], ['get', '/revenues']], 200);
    await expectStatuses(pm, [
      ['patch', '', { planned_revenue: 1 }],
      ['put', `/tasks/${task.id}/planned-cost`, { planned_cost: 1 }],
      ['post', '/costs', costBody()],
      ['patch', `/costs/${cost.id}`, { amount: 1 }],
      ['delete', `/costs/${cost.id}`],
      ['post', '/revenues', { date: '2026-09-20', amount: 10 }],
      ['patch', `/revenues/${revenue.id}`, { amount: 1 }],
      ['delete', `/revenues/${revenue.id}`],
    ], 409);
    await expectStatuses(worker, [['post', '/costs', costBody({ task_id: task.id })]], 409);

    expect((await api('get', `/api/projects/${project.id}`, pm)).body.finance)
      .toMatchObject({ can_read: true, can_write: false });
    expect((await api('get', `/api/projects/${project.id}`, worker)).body.finance)
      .toMatchObject({ can_add_own_costs: false });
  });

  test('the project list carries totals only for PM, admin and controller', async () => {
    await patchPlan(pm, {
      planned_revenue: 1000,
      category_budgets: [{ category_id: categoryByName.Inne, planned_cost: 600 }],
      participants_can_add_costs: true,
    });
    await addCost({ amount: 200 });
    await addRevenue({ amount: 500, status: 'paid' });
    const totals = {
      currency: 'PLN',
      revenue: { planned: 1000, actual: 500 },
      cost: { planned: 600, actual: 200 },
      margin: { planned: { amount: 400, percent: 40 }, actual: { amount: 300, percent: 60 } },
    };
    const financeInList = async (user) =>
      (await api('get', '/api/projects', user)).body.projects.find((listed) => listed.id === project.id).finance;

    expect(await financeInList(pm)).toEqual(totals);
    expect(await financeInList(admin)).toEqual(totals);
    expect(await financeInList(controller)).toEqual(totals);
    expect(await financeInList(worker)).toBeNull();
    expect(await financeInList(external)).toBeNull();
  });

  test('whoever sees the lead or partner card sees the project totals there, member or not', async () => {
    await patchPlan(pm, {
      planned_revenue: 1000, category_budgets: [{ category_id: categoryByName.Inne, planned_cost: 600 }],
    });
    await addCost({ amount: 200 });
    await addCost({ amount: 75, status: 'planned' });
    await addRevenue({ amount: 500, status: 'invoiced' });
    const totals = {
      currency: 'PLN',
      revenue: { planned: 1000, actual: 500 },
      cost: { planned: 600, actual: 200 },
      margin: { planned: { amount: 400, percent: 40 }, actual: { amount: 300, percent: 60 } },
    };

    await db.query('UPDATE projects SET lead_id = $1 WHERE id = $2', [leadId, project.id]);
    const leadCard = await api('get', `/api/crm/leads/${leadId}/projects`, accountOwner);
    expect(leadCard.status).toBe(200);
    expect(leadCard.body[0]).toMatchObject({ id: project.id, can_open: false });
    expect(leadCard.body[0].finance).toEqual(totals);

    await db.query('UPDATE projects SET lead_id = NULL, partner_id = $1 WHERE id = $2', [partnerId, project.id]);
    const partnerCard = await api('get', `/api/crm/partners/${partnerId}/projects`, accountOwner);
    expect(partnerCard.status).toBe(200);
    expect(partnerCard.body[0].finance).toEqual(totals);

    // The account owner still cannot enter the project or its finance.
    expect((await api('get', financeUrl(), accountOwner)).status).toBe(404);
  });
});
