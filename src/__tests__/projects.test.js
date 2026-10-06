'use strict';

// Projects module — who may create and see projects, member role rules,
// tenant isolation, project closing and the tenant-admin configuration.
//
// Multi-tenant: everything is created under dedicated test tenants and
// cleaned up by tenant_id.

const request = require('supertest');
const app     = require('../app');
const db      = require('../config/database');
const { signAccessToken } = require('../middleware/auth');
const { buildKeyBase } = require('../services/projectService');

const SLUG         = 'zz-projects-test';
const OTHER_SLUG   = 'zz-projects-test-other';
const EMAIL_DOMAIN = '@projects-test.crmtree.local';

let tenantId, otherTenantId;
let admin, creator, employee, external, outsider, otherTenantAdmin;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);

async function mkUser(local, tenant, { isAdmin = false, isExternal = false, canCreate = false } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id,
                        is_external, can_create_projects, phone, company, department)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5, $6, '+48 600 100 200', 'Acme', 'IT') RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, isAdmin, tenant, isExternal, canCreate],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

async function cleanup() {
  const tenantIds = [tenantId, otherTenantId];
  await db.query('DELETE FROM projects WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM project_field_definitions WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM project_task_statuses WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM project_task_types WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query('DELETE FROM project_task_priorities WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

async function mkTenant(slug) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [`Projects Test ${slug}`, slug],
  );
  await db.query(
    `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', TRUE)
     ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE`,
    [tenant.id],
  );
  return tenant.id;
}

async function createProject(user, name = 'Wdrożenie Systemu CRM') {
  const res = await api('post', '/api/projects', user).send({ name, description: 'Opis' });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  tenantId = await mkTenant(SLUG);
  otherTenantId = await mkTenant(OTHER_SLUG);
  await cleanup();

  admin    = await mkUser('padmin',    tenantId, { isAdmin: true });
  creator  = await mkUser('pcreator',  tenantId, { canCreate: true });
  employee = await mkUser('pemployee', tenantId);
  external = await mkUser('pexternal', tenantId, { isExternal: true });
  outsider = await mkUser('poutsider', tenantId);
  otherTenantAdmin = await mkUser('pother', otherTenantId, { isAdmin: true });
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = ANY($1::text[])', [[SLUG, OTHER_SLUG]]);
});

beforeEach(async () => {
  await db.query('DELETE FROM projects WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
});

describe('project key', () => {
  test('is built from initials, without diacritics', () => {
    expect(buildKeyBase('Wdrożenie Systemu CRM')).toBe('WSC');
    expect(buildKeyBase('Łódź')).toBe('LOD');
    expect(buildKeyBase('2026 !!!')).toBe('PRJ');
  });

  test('gets a numeric suffix when the base is taken', async () => {
    const first  = await createProject(creator);
    const second = await createProject(creator);
    expect(first.key).toBe('WSC');
    expect(second.key).toBe('WSC2');
  });
});

describe('creating and seeing projects', () => {
  test('a user without the permission cannot create a project', async () => {
    const res = await api('post', '/api/projects', employee).send({ name: 'X' });
    expect(res.status).toBe(403);
  });

  test('the creator becomes PM with full access', async () => {
    const project = await createProject(creator);
    const res = await api('get', `/api/projects/${project.id}`, creator);
    expect(res.status).toBe(200);
    expect(res.body.my_role).toBe('pm');
    expect(res.body.can_manage).toBe(true);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0]).toMatchObject({ role: 'pm', access_level: 'full', company: 'Acme' });
  });

  test('a non-member neither lists nor opens the project; the admin does both', async () => {
    const project = await createProject(creator);

    const list = await api('get', '/api/projects', outsider);
    expect(list.body.items).toHaveLength(0);
    expect(list.body.can_create).toBe(false);
    expect((await api('get', `/api/projects/${project.id}`, outsider)).status).toBe(404);

    const adminList = await api('get', '/api/projects', admin);
    expect(adminList.body.items.map((p) => p.id)).toContain(project.id);
    expect((await api('get', `/api/projects/${project.id}`, admin)).body.can_manage).toBe(true);
  });

  test('a project is invisible from another tenant', async () => {
    const project = await createProject(creator);
    expect((await api('get', `/api/projects/${project.id}`, otherTenantAdmin)).status).toBe(404);
    expect((await api('get', '/api/projects', otherTenantAdmin)).body.items).toHaveLength(0);
  });

  test('the module is refused when the feature is switched off', async () => {
    await db.query(
      `UPDATE tenant_features SET is_enabled = FALSE WHERE tenant_id = $1 AND feature = 'projects'`,
      [tenantId],
    );
    try {
      expect((await api('get', '/api/projects', admin)).status).toBe(403);
    } finally {
      await db.query(
        `UPDATE tenant_features SET is_enabled = TRUE WHERE tenant_id = $1 AND feature = 'projects'`,
        [tenantId],
      );
    }
  });
});

describe('members', () => {
  let project;
  const addMember = (actor, body) => api('post', `/api/projects/${project.id}/members`, actor).send(body);

  beforeEach(async () => { project = await createProject(creator); });

  test('PM adds members; controller is always read-only', async () => {
    const added = await addMember(creator, { user_id: employee.id, role: 'internal_participant', access_level: 'full' });
    expect(added.status).toBe(201);

    const controller = await addMember(creator, { user_id: outsider.id, role: 'controller', access_level: 'full' });
    expect(controller.status).toBe(201);
    expect(controller.body.find((m) => m.user_id === outsider.id).access_level).toBe('read');

    const employeeView = await api('get', '/api/projects', employee);
    expect(employeeView.body.items.map((p) => p.id)).toEqual([project.id]);
  });

  test('a participant cannot manage members', async () => {
    await addMember(creator, { user_id: employee.id, role: 'internal_participant', access_level: 'full' });
    const res = await addMember(employee, { user_id: outsider.id, role: 'internal_participant', access_level: 'read' });
    expect(res.status).toBe(403);
  });

  test('role must match the account kind', async () => {
    expect((await addMember(creator, { user_id: external.id, role: 'pm' })).status).toBe(400);
    expect((await addMember(creator, { user_id: external.id, role: 'internal_participant', access_level: 'read' })).status).toBe(400);
    expect((await addMember(creator, { user_id: employee.id, role: 'external_participant', access_level: 'read' })).status).toBe(400);
    expect((await addMember(creator, { user_id: external.id, role: 'external_participant', access_level: 'read' })).status).toBe(201);
  });

  test('a user from another tenant cannot be added', async () => {
    const res = await addMember(creator, { user_id: otherTenantAdmin.id, role: 'controller' });
    expect(res.status).toBe(400);
  });

  test('the last PM can be neither removed nor demoted', async () => {
    const removal = await api('delete', `/api/projects/${project.id}/members/${creator.id}`, creator);
    expect(removal.status).toBe(409);
    const demotion = await api('patch', `/api/projects/${project.id}/members/${creator.id}`, creator)
      .send({ role: 'controller' });
    expect(demotion.status).toBe(409);
  });

  test('member candidates exclude current members and other tenants', async () => {
    const res = await api('get', `/api/projects/${project.id}/member-candidates`, creator);
    const ids = res.body.map((u) => u.id);
    expect(ids).toContain(employee.id);
    expect(ids).not.toContain(creator.id);
    expect(ids).not.toContain(otherTenantAdmin.id);
  });
});

describe('closing', () => {
  test('a closed project leaves the default list, is read-only and can be reopened', async () => {
    const project = await createProject(creator);
    expect((await api('post', `/api/projects/${project.id}/close`, creator)).body.status).toBe('closed');

    expect((await api('get', '/api/projects', creator)).body.items).toHaveLength(0);
    expect((await api('get', '/api/projects?status=closed', creator)).body.items).toHaveLength(1);
    expect((await api('patch', `/api/projects/${project.id}`, creator).send({ name: 'Nowa' })).status).toBe(409);

    expect((await api('post', `/api/projects/${project.id}/reopen`, creator)).body.status).toBe('open');
    expect((await api('patch', `/api/projects/${project.id}`, creator).send({ name: 'Nowa' })).status).toBe(200);
  });

  test('there is no endpoint to delete a project', async () => {
    const project = await createProject(creator);
    expect((await api('delete', `/api/projects/${project.id}`, admin)).status).toBe(404);
  });
});

describe('tenant configuration', () => {
  test('defaults are seeded on first read and are readable by any user', async () => {
    const res = await api('get', '/api/projects/config', employee);
    expect(res.status).toBe(200);
    expect(res.body.statuses.map((s) => s.category)).toEqual(['todo', 'in_progress', 'in_progress', 'done']);
    expect(res.body.priorities).toHaveLength(4);
    expect(res.body.transitions.length).toBeGreaterThan(0);
  });

  test('only the tenant admin edits the configuration', async () => {
    const res = await api('post', '/api/admin/project-config/dictionaries/types', creator).send({ name: 'Błąd' });
    expect(res.status).toBe(403);
  });

  test('admin adds a status, rejects a duplicate and keeps one active status', async () => {
    const created = await api('post', '/api/admin/project-config/dictionaries/statuses', admin)
      .send({ name: 'Wstrzymane', category: 'todo', color: '#111111' });
    expect(created.status).toBe(200);
    expect(created.body.statuses.map((s) => s.name)).toContain('Wstrzymane');

    const duplicate = await api('post', '/api/admin/project-config/dictionaries/statuses', admin)
      .send({ name: 'Wstrzymane', category: 'todo' });
    expect(duplicate.status).toBe(409);

    const noCategory = await api('post', '/api/admin/project-config/dictionaries/statuses', admin)
      .send({ name: 'Bez kategorii' });
    expect(noCategory.status).toBe(400);

    let lastResponse;
    for (const status of created.body.statuses) {
      lastResponse = await api('patch', `/api/admin/project-config/dictionaries/statuses/${status.id}`, admin)
        .send({ is_active: false });
    }
    expect(lastResponse.status).toBe(409);
  });

  test('admin replaces the transitions of a role', async () => {
    const { body: config } = await api('get', '/api/projects/config', admin);
    const [first, second] = config.statuses;
    const res = await api('put', '/api/admin/project-config/transitions/controller', admin)
      .send({ transitions: [{ from_status_id: first.id, to_status_id: second.id }] });
    expect(res.status).toBe(200);
    expect(res.body.transitions.filter((t) => t.role === 'controller')).toEqual([
      { role: 'controller', from_status_id: first.id, to_status_id: second.id },
    ]);
    expect((await api('put', '/api/admin/project-config/transitions/pm', admin).send({ transitions: [] })).status)
      .toBe(400);
  });

  test('custom fields: list needs options; PM attaches a field to a project as required', async () => {
    const withoutOptions = await api('post', '/api/admin/project-config/fields', admin)
      .send({ name: 'Etap', field_type: 'list' });
    expect(withoutOptions.status).toBe(400);

    const created = await api('post', '/api/admin/project-config/fields', admin)
      .send({ name: 'Budżet', field_type: 'money' });
    expect(created.status).toBe(200);
    const definition = created.body.field_definitions.find((f) => f.name === 'Budżet');

    const project = await createProject(creator);
    const attached = await api('put', `/api/projects/${project.id}/fields`, creator)
      .send({ fields: [{ field_definition_id: definition.id, is_required: true }] });
    expect(attached.status).toBe(200);
    expect(attached.body).toEqual([
      expect.objectContaining({ field_definition_id: definition.id, is_required: true, field_type: 'money' }),
    ]);
  });
});
