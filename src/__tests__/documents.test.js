'use strict';

const request = require('supertest');
const app     = require('../../app');
const db      = require('../../config/database');

// ─── Setup / Teardown ─────────────────────────────────────
let adminToken, userToken, adminId, userId, groupId, documentId;

beforeAll(async () => {
  // Clean slate
  await db.query(`DELETE FROM audit_logs`);
  await db.query(`DELETE FROM workflow_tasks`);
  await db.query(`DELETE FROM document_tags`);
  await db.query(`DELETE FROM document_versions`);
  await db.query(`DELETE FROM documents`);
  await db.query(`DELETE FROM user_group_roles`);
  await db.query(`DELETE FROM users WHERE email LIKE '%@test.worktrips.com'`);
  await db.query(`DELETE FROM group_profiles WHERE name LIKE 'Test%'`);

  // Create test admin
  const { rows: adminRows } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin)
     VALUES ('admin@test.worktrips.com','Admin','User',TRUE) RETURNING *`
  );
  adminId = adminRows[0].id;

  // Create test regular user
  const { rows: userRows } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin)
     VALUES ('user@test.worktrips.com','Regular','User',FALSE) RETURNING *`
  );
  userId = userRows[0].id;

  // Create test group
  const { rows: groupRows } = await db.query(
    `INSERT INTO group_profiles (name, display_name) VALUES ('TestGroup','Test Group') RETURNING *`
  );
  groupId = groupRows[0].id;

  // Assign full access to regular user
  await db.query(
    `INSERT INTO user_group_roles (user_id, group_id, access_level) VALUES ($1,$2,'full')`,
    [userId, groupId]
  );

  // Generate tokens directly
  const { signAccessToken } = require('../../middleware/auth');
  adminToken = signAccessToken(adminRows[0]);
  userToken  = signAccessToken(userRows[0]);
});

afterAll(async () => {
  await db.pool.end();
});

// ─── Documents ────────────────────────────────────────────
describe('Documents API', () => {

  test('POST /api/documents — create document', async () => {
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${userToken}`)
      .field('name', 'Test Agreement 001')
      .field('doc_type', 'nda')
      .field('gdpr_type', 'no_gdpr')
      .field('group_id', groupId)
      .field('entities[]', 'WorkTrips Sp. z o.o.')
      .field('entities[]', 'Test Partner Ltd.');

    expect(res.status).toBe(201);
    expect(res.body.doc_number).toMatch(/^DOC-\d{4}-\d{4}$/);
    expect(res.body.status).toBe('new');
    documentId = res.body.id;
  });

  test('GET /api/documents — list documents', async () => {
    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/documents/:id — get document', async () => {
    const res = await request(app)
      .get(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(documentId);
    expect(res.body._access).toBe('full');
  });

  test('PATCH /api/documents/:id — update metadata', async () => {
    const res = await request(app)
      .patch(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Updated Test Agreement', status: 'being_edited' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Test Agreement');
    expect(res.body.status).toBe('being_edited');
  });

  test('GET /api/documents — search by name', async () => {
    const res = await request(app)
      .get('/api/documents?search=Updated+Test')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some(d => d.id === documentId)).toBe(true);
  });

  test('GET /api/documents — filter by status', async () => {
    const res = await request(app)
      .get('/api/documents?status=being_edited')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every(d => d.status === 'being_edited')).toBe(true);
  });

  // ─── Tags ───────────────────────────────────────────────
  let tagId;
  test('POST /api/documents/:id/tags — add tag', async () => {
    const res = await request(app)
      .post(`/api/documents/${documentId}/tags`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ key: 'project', value: 'alpha-2025' });
    expect(res.status).toBe(201);
    tagId = res.body.id;
  });

  test('GET /api/documents/:id/tags — list tags', async () => {
    const res = await request(app)
      .get(`/api/documents/${documentId}/tags`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test('PATCH /api/documents/:id/tags/:tagId — update tag', async () => {
    const res = await request(app)
      .patch(`/api/documents/${documentId}/tags/${tagId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ value: 'beta-2025' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('beta-2025');
  });

  test('DELETE /api/documents/:id/tags/:tagId — delete tag', async () => {
    const res = await request(app)
      .delete(`/api/documents/${documentId}/tags/${tagId}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
  });

  // ─── Workflow ───────────────────────────────────────────
  let taskId;
  test('POST /api/documents/:id/workflow — assign task', async () => {
    const res = await request(app)
      .post(`/api/documents/${documentId}/workflow`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        assigned_to: userId,
        task_type:   'read',
        message:     'Please review this document',
      });
    expect(res.status).toBe(201);
    expect(res.body.task_status).toBe('pending');
    taskId = res.body.id;
  });

  test('PATCH /api/documents/:id/workflow/:taskId — complete task', async () => {
    const res = await request(app)
      .patch(`/api/documents/${documentId}/workflow/${taskId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ task_status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.task_status).toBe('completed');
  });

  // ─── Permissions ────────────────────────────────────────
  test('GET /api/documents/:id — 403 for unauthorized user', async () => {
    // Create user with no roles
    const { rows } = await db.query(
      `INSERT INTO users (email,first_name,last_name) VALUES ('nogroup@test.worktrips.com','No','Group') RETURNING *`
    );
    const { signAccessToken } = require('../../middleware/auth');
    const noGroupToken = signAccessToken(rows[0]);

    const res = await request(app)
      .get(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${noGroupToken}`);
    expect(res.status).toBe(403);
  });

  // ─── Delete ─────────────────────────────────────────────
  test('DELETE /api/documents/:id — soft delete', async () => {
    const res = await request(app)
      .delete(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);

    // Verify soft-deleted (should return 404)
    const check = await request(app)
      .get(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(check.status).toBe(404);
  });
});

// ─── Groups (admin) ───────────────────────────────────────
describe('Groups API (admin)', () => {
  let newGroupId;

  test('POST /api/groups — create group', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'TestNewGroup', display_name: 'Test New Group', has_owner_restriction: false });
    expect(res.status).toBe(201);
    newGroupId = res.body.id;
  });

  test('PATCH /api/groups/:id — update group', async () => {
    const res = await request(app)
      .patch(`/api/groups/${newGroupId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ display_name: 'Updated Test Group' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Updated Test Group');
  });

  test('POST /api/groups — 409 duplicate name', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'TestNewGroup' });
    expect(res.status).toBe(409);
  });

  test('POST /api/groups — 403 for non-admin', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'ShouldFail' });
    expect(res.status).toBe(403);
  });

  test('DELETE /api/groups/:id — deactivate', async () => {
    const res = await request(app)
      .delete(`/api/groups/${newGroupId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

// ─── Audit Logs ───────────────────────────────────────────
describe('Audit Logs API', () => {
  test('GET /api/admin/logs — admin can access', async () => {
    const res = await request(app)
      .get('/api/admin/logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  test('GET /api/admin/logs — non-admin 403', async () => {
    const res = await request(app)
      .get('/api/admin/logs')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });
});
