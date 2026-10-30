'use strict';

jest.mock('../services/storageService', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('stored'),
  downloadDocument: jest.fn().mockResolvedValue({ buffer: Buffer.from('attachment contents') }),
  deleteBlob: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const storage = require('../services/storageService');
const { signAccessToken } = require('../middleware/auth');
const { copyLeadActivitiesToPartner } = require('../services/entityAttachmentService');

let tenantId, otherTenantId, admin, owner, outsider, external, reader, otherAdmin;
let lead, partner, note, task, partnerNote, project, hiddenProject, projectTask, otherTask;
const tokens = {};
const prefix = `/api/entity-attachments`;
const api = (method, url, user = owner) => request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);
const upload = (type, id, filename, user = owner) => api('post', `${prefix}/${type}/${id}`, user)
  .attach('file', Buffer.from('attachment contents'), { filename, contentType: 'application/pdf' });

async function createUser(label, tenant, options = {}) {
  const { rows: [user] } = await db.query(`INSERT INTO users
    (tenant_id, email, first_name, last_name, is_active, is_admin, crm_role, is_external)
    VALUES ($1,$2,$3,'Attachments',true,$4,$5,$6) RETURNING *`,
  [tenant, `${label}-${tenant}@attachments.test`, label, Boolean(options.admin), options.external ? null : 'salesperson', Boolean(options.external)]);
  tokens[user.id] = signAccessToken(user);
  return user;
}

beforeAll(async () => {
  for (const other of [false, true]) {
    const slug = `zz-attachments-${other ? 'other-' : ''}${Date.now()}`;
    const { rows: [tenant] } = await db.query('INSERT INTO tenants (name, slug) VALUES ($1,$1) RETURNING id', [slug]);
    if (other) otherTenantId = tenant.id; else tenantId = tenant.id;
    await db.query("INSERT INTO tenant_features (tenant_id,feature,is_enabled) VALUES ($1,'projects',true)", [tenant.id]);
  }
  admin = await createUser('admin', tenantId, { admin: true });
  owner = await createUser('owner', tenantId);
  outsider = await createUser('outsider', tenantId);
  external = await createUser('external', tenantId, { external: true });
  reader = await createUser('reader', tenantId);
  otherAdmin = await createUser('other-admin', otherTenantId, { admin: true });
  ({ rows: [lead] } = await db.query("INSERT INTO crm_leads (tenant_id,company,assigned_to) VALUES ($1,'Attachments Lead',$2) RETURNING *", [tenantId, owner.id]));
  ({ rows: [partner] } = await db.query("INSERT INTO crm_partners (tenant_id,company,manager_id) VALUES ($1,'Attachments Partner',$2) RETURNING *", [tenantId, owner.id]));
  for (const type of ['note', 'task']) {
    const { rows: [activity] } = await db.query(`INSERT INTO crm_lead_activities
      (tenant_id,lead_id,type,title,created_by,assigned_to) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [tenantId, lead.id, type, `${type} attachment`, owner.id]);
    if (type === 'note') note = activity; else task = activity;
  }
  ({ rows: [partnerNote] } = await db.query(`INSERT INTO crm_partner_activities
    (tenant_id,partner_id,type,title,created_by) VALUES ($1,$2,'note','Partner note',$3) RETURNING *`, [tenantId, partner.id, owner.id]));
  const { rows: [status] } = await db.query("INSERT INTO project_task_statuses (tenant_id,name,category) VALUES ($1,'Attachment Test','todo') RETURNING id", [tenantId]);
  for (const hidden of [false, true]) {
    const { rows: [created] } = await db.query(`INSERT INTO projects (tenant_id,key,name,lead_id,created_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`, [tenantId, hidden ? 'HIDDEN' : 'FILES', hidden ? 'Hidden project' : 'Files project', lead.id, admin.id]);
    if (hidden) hiddenProject = created; else project = created;
  }
  for (const [user, role, access] of [[owner, 'internal_participant', 'full'], [external, 'external_participant', 'full'], [reader, 'internal_participant', 'read']]) {
    await db.query('INSERT INTO project_members (tenant_id,project_id,user_id,role,access_level) VALUES ($1,$2,$3,$4,$5)', [tenantId, project.id, user.id, role, access]);
  }
  for (const assigned of [true, false]) {
    const { rows: [created] } = await db.query(`INSERT INTO project_tasks (tenant_id,project_id,task_number,name,status_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`, [tenantId, project.id, assigned ? 1 : 2, assigned ? 'Assigned task' : 'Other task', status.id]);
    if (assigned) {
      projectTask = created;
      for (const user of [owner, external]) {
        await db.query('INSERT INTO project_task_assignees (task_id,user_id,tenant_id) VALUES ($1,$2,$3)', [created.id, user.id, tenantId]);
      }
    } else otherTask = created;
  }
}, 30000);

afterAll(async () => {
  const ids = [tenantId, otherTenantId].filter(Boolean);
  await db.query('DELETE FROM audit_logs WHERE tenant_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM projects WHERE tenant_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM crm_leads WHERE tenant_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM crm_partners WHERE tenant_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [ids]);
});

beforeEach(async () => {
  await db.query('DELETE FROM entity_attachments WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
  jest.clearAllMocks();
});

test('uploads, lists and downloads files at all requested sources', async () => {
  for (const [type, id] of [['lead', lead.id], ['partner', partner.id], ['lead-activity', task.id], ['lead-activity', note.id], ['partner-activity', partnerNote.id], ['project', project.id], ['project-task', projectTask.id]]) {
    const created = await upload(type, id, `${type}.pdf`);
    expect(created.status).toBe(201);
    expect(created.body.blob_path).toBeUndefined();
    const list = await api('get', `${prefix}/${type}/${id}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([expect.objectContaining({ id: created.body.id, source_type: type, source_id: String(id) })]);
    expect(list.body.can_write).toBe(true);
    const downloaded = await api('get', `${prefix}/${type}/${id}/${created.body.id}/download`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-disposition']).toContain('attachment;');
    expect(downloaded.body.toString()).toBe('attachment contents');
  }
});

test('collects lead files by source, respecting project membership and filters', async () => {
  const direct = await upload('lead', lead.id, 'direct.pdf');
  const taskFile = await upload('lead-activity', task.id, 'proposal.pdf');
  const noteFile = await upload('lead-activity', note.id, 'note.pdf');
  const projectFile = await upload('project', project.id, 'project.pdf');
  const taskProjectFile = await upload('project-task', projectTask.id, 'task.pdf');
  const hidden = await upload('project', hiddenProject.id, 'hidden.pdf', admin);
  await upload('partner', partner.id, 'partner.pdf');
  const list = await api('get', `${prefix}/lead/${lead.id}?aggregate=true`);
  expect(list.status).toBe(200);
  expect(list.body.total).toBe(5);
  expect(list.body.items.map(file => file.id).sort()).toEqual([direct, taskFile, noteFile, projectFile, taskProjectFile].map(file => file.body.id).sort());
  const all = await api('get', `${prefix}/lead/${lead.id}?aggregate=true`, admin);
  expect(all.body.items.map(file => file.id)).toContain(hidden.body.id);
  const filtered = await api('get', `${prefix}/lead/${lead.id}?aggregate=true&source=task&filename=proposal&place=lead-activity:${task.id}&author=${owner.id}&sort=created_at&order=desc`);
  expect(filtered.body.total).toBe(1);
  expect(filtered.body.items[0].id).toBe(taskFile.body.id);
});

test('collects partner notes and linked projects', async () => {
  await upload('partner', partner.id, 'direct.pdf');
  await upload('partner-activity', partnerNote.id, 'note.pdf');
  await db.query('UPDATE projects SET lead_id=NULL, partner_id=$1 WHERE id=$2', [partner.id, project.id]);
  try {
    await upload('project', project.id, 'project.pdf');
    await upload('project-task', projectTask.id, 'task.pdf');
    const list = await api('get', `${prefix}/partner/${partner.id}?aggregate=true`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(4);
  } finally {
    await db.query('UPDATE projects SET lead_id=$1, partner_id=NULL WHERE id=$2', [lead.id, project.id]);
  }
});

test('activity lists report how many files each task or note has', async () => {
  const { rows: [leadActivity] } = await db.query(`INSERT INTO crm_lead_activities
    (tenant_id,lead_id,type,title,created_by) VALUES ($1,$2,'note','Counted note',$3) RETURNING *`, [tenantId, lead.id, owner.id]);
  const { rows: [partnerActivity] } = await db.query(`INSERT INTO crm_partner_activities
    (tenant_id,partner_id,type,title,created_by) VALUES ($1,$2,'note','Counted partner note',$3) RETURNING *`, [tenantId, partner.id, owner.id]);
  await upload('lead-activity', leadActivity.id, 'first.pdf');
  await upload('lead-activity', leadActivity.id, 'second.pdf');
  await upload('partner-activity', partnerActivity.id, 'partner.pdf');

  const leadActivities = await api('get', `/api/crm/leads/${lead.id}/activities`);
  expect(leadActivities.status).toBe(200);
  expect(leadActivities.body.find(activity => activity.id === leadActivity.id).attachment_count).toBe(2);

  const partnerActivities = await api('get', `/api/crm/partners/${partner.id}/activities`);
  expect(partnerActivities.status).toBe(200);
  expect(partnerActivities.body.find(activity => activity.id === partnerActivity.id).attachment_count).toBe(1);
});

test('isolates tenants, CRM scope and attachment-to-source associations', async () => {
  const file = await upload('lead-activity', note.id, 'private.pdf');
  for (const user of [outsider, otherAdmin]) {
    expect((await api('get', `${prefix}/lead/${lead.id}?aggregate=true`, user)).status).toBe(404);
    expect((await api('get', `${prefix}/lead-activity/${note.id}/${file.body.id}/download`, user)).status).toBe(404);
    expect((await upload('lead-activity', note.id, 'blocked.pdf', user)).status).toBe(404);
  }
  expect((await api('get', `${prefix}/lead-activity/${task.id}/${file.body.id}/download`)).status).toBe(404);
  expect((await api('get', `${prefix}/project/${hiddenProject.id}`)).status).toBe(404);
  expect((await request(app).get(`${prefix}/lead/${lead.id}`)).status).toBe(401);
});

test('external participants access only visible project tasks and cannot upload to the project', async () => {
  expect((await upload('project-task', projectTask.id, 'allowed.pdf', external)).status).toBe(201);
  expect((await api('get', `${prefix}/project-task/${projectTask.id}`, external)).status).toBe(200);
  expect((await api('get', `${prefix}/project-task/${otherTask.id}`, external)).status).toBe(404);
  expect((await upload('project-task', otherTask.id, 'blocked.pdf', external)).status).toBe(404);
  expect((await upload('project', project.id, 'blocked.pdf', external)).status).toBe(403);
  expect((await api('get', `${prefix}/lead/${lead.id}`, external)).status).toBe(403);
});

test('read-only and closed projects allow download but forbid upload and deletion', async () => {
  const file = await upload('project', project.id, 'project.pdf');
  expect((await api('get', `${prefix}/project/${project.id}`, reader)).body.can_write).toBe(false);
  expect((await upload('project', project.id, 'blocked.pdf', reader)).status).toBe(403);
  expect((await api('delete', `${prefix}/project/${project.id}/${file.body.id}`, reader)).status).toBe(403);
  expect((await api('get', `${prefix}/project/${project.id}/${file.body.id}/download`, reader)).status).toBe(200);
  await db.query("UPDATE projects SET status='closed' WHERE id=$1", [project.id]);
  try {
    expect((await upload('project-task', projectTask.id, 'closed.pdf', admin)).status).toBe(403);
    expect((await api('get', `${prefix}/project/${project.id}/${file.body.id}/download`)).status).toBe(200);
  } finally { await db.query("UPDATE projects SET status='open' WHERE id=$1", [project.id]); }
});

test('deletes a file and its blob; source deletion removes its attachment rows', async () => {
  const file = await upload('lead', lead.id, 'delete.pdf');
  expect((await api('delete', `${prefix}/lead/${lead.id}/${file.body.id}`)).status).toBe(204);
  expect(storage.deleteBlob).toHaveBeenCalledTimes(1);
  expect((await api('get', `${prefix}/lead/${lead.id}/${file.body.id}/download`)).status).toBe(404);
  const { rows: [activity] } = await db.query("INSERT INTO crm_lead_activities (tenant_id,lead_id,type,title) VALUES ($1,$2,'note','Temporary') RETURNING id", [tenantId, lead.id]);
  const child = await upload('lead-activity', activity.id, 'cascade.pdf');
  await db.query('DELETE FROM crm_lead_activities WHERE id=$1', [activity.id]);
  expect((await db.query('SELECT id FROM entity_attachments WHERE id=$1', [child.body.id])).rowCount).toBe(0);
});

test('paginates on the server and validates filters and MIME types', async () => {
  await db.query(`INSERT INTO entity_attachments (tenant_id,lead_id,filename,mime_type,file_size,blob_path,created_by)
    SELECT $1,$2,'file-' || value || '.pdf','application/pdf',10,'test/' || value,$3 FROM generate_series(1,55) value`, [tenantId, lead.id, owner.id]);
  const first = await api('get', `${prefix}/lead/${lead.id}?sort=filename`);
  const next = await api('get', `${prefix}/lead/${lead.id}?sort=filename&page=2`);
  expect(first.body.total).toBe(55);
  expect(first.body.items).toHaveLength(50);
  expect(next.body.items).toHaveLength(5);
  expect(next.body.items.some(file => first.body.items.some(previous => previous.id === file.id))).toBe(false);
  for (const query of ['page_size=51', 'page=0', 'sort=blob_path', 'created_from=not-a-date']) {
    expect((await api('get', `${prefix}/lead/${lead.id}?${query}`)).status).toBe(400);
  }
  const blocked = await api('post', `${prefix}/lead/${lead.id}`).attach('file', Buffer.from('<script>'), { filename: 'script.html', contentType: 'text/html' });
  expect(blocked.status).toBe(400);
  expect(storage.uploadBuffer).not.toHaveBeenCalled();
});

test('conversion keeps exact file associations for duplicate note titles', async () => {
  const { rows: [duplicate] } = await db.query(`INSERT INTO crm_lead_activities (tenant_id,lead_id,type,title,created_by)
    VALUES ($1,$2,'note',$3,$4) RETURNING id`, [tenantId, lead.id, note.title, owner.id]);
  const direct = await upload('lead', lead.id, 'direct.pdf');
  const noteFile = await upload('lead-activity', note.id, 'note.pdf');
  const duplicateFile = await upload('lead-activity', duplicate.id, 'duplicate.pdf');
  const taskFile = await upload('lead-activity', task.id, 'task.pdf');
  await copyLeadActivitiesToPartner({ tenantId, leadId: lead.id, partnerId: partner.id });
  const list = await api('get', `${prefix}/partner/${partner.id}?aggregate=true`);
  expect(list.status).toBe(200);
  expect(list.body.items.map(file => file.id).sort()).toEqual([direct.body.id, noteFile.body.id, duplicateFile.body.id, taskFile.body.id].sort());
  const copiedNoteFile = list.body.items.find(file => file.id === noteFile.body.id);
  expect(copiedNoteFile.source_type).toBe('partner-activity');
  expect(copiedNoteFile.source_category).toBe('note');
  expect(copiedNoteFile.source_id).not.toBe(list.body.items.find(file => file.id === duplicateFile.body.id).source_id);
  expect((await api('get', `${prefix}/partner-activity/${copiedNoteFile.source_id}/${copiedNoteFile.id}/download`)).status).toBe(200);
});

test('global CRM read access permits viewing files without granting write access', async () => {
  await upload('lead', lead.id, 'visible.pdf');
  await db.query("INSERT INTO app_settings (tenant_id,key,value,label,value_type) VALUES ($1,'crm_global_read','true','Global CRM read','boolean') ON CONFLICT (tenant_id,key) DO UPDATE SET value='true'", [tenantId]);
  try {
    const list = await api('get', `${prefix}/lead/${lead.id}?aggregate=true`, outsider);
    expect(list.status).toBe(200);
    expect(list.body.can_write).toBe(false);
    expect((await api('get', `${prefix}/lead/${lead.id}`)).body.can_write).toBe(true);
    await db.query("UPDATE users SET crm_role='sales_manager' WHERE id=$1", [outsider.id]);
    const managerView = await api('get', `${prefix}/lead/${lead.id}?aggregate=true`, outsider);
    expect(managerView.status).toBe(200);
    expect(managerView.body.can_write).toBe(false);
    await db.query("UPDATE users SET crm_role='salesperson' WHERE id=$1", [outsider.id]);
    expect((await upload('lead', lead.id, 'blocked.pdf', outsider)).status).toBe(404);
  } finally { await db.query("DELETE FROM app_settings WHERE tenant_id=$1 AND key='crm_global_read'", [tenantId]); }
});

test('preserves Unicode filenames and accepts spreadsheet and image attachments', async () => {
  const file = await upload('lead', lead.id, 'Załącznik Łódź.pdf');
  expect(file.status).toBe(201);
  expect(file.body.filename).toBe('Załącznik Łódź.pdf');
  for (const [filename, contentType] of [['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['image.png', 'image/png']]) {
    const response = await api('post', `${prefix}/lead/${lead.id}`).attach('file', Buffer.from('file'), { filename, contentType });
    expect(response.status).toBe(201);
  }
});

test('a task assignee can use attachments from the calendar without access to the parent lead', async () => {
  const { rows: [assigned] } = await db.query(`INSERT INTO crm_lead_activities (tenant_id,lead_id,type,title,assigned_to)
    VALUES ($1,$2,'task','Delegated task',$3) RETURNING id`, [tenantId, lead.id, outsider.id]);
  const file = await upload('lead-activity', assigned.id, 'delegated.pdf', outsider);
  expect(file.status).toBe(201);
  expect((await api('get', `${prefix}/lead-activity/${assigned.id}/${file.body.id}/download`, outsider)).status).toBe(200);
  expect((await api('get', `${prefix}/lead/${lead.id}`, outsider)).status).toBe(404);
});

test('cleans up the uploaded blob if the database insert fails', async () => {
  const originalQuery = db.query;
  const query = jest.spyOn(db, 'query').mockImplementation((sql, params) => {
    if (sql.includes('INSERT INTO entity_attachments')) return Promise.reject(new Error('Test insert failure'));
    return originalQuery(sql, params);
  });
  try {
    expect((await upload('lead', lead.id, 'failed.pdf')).status).toBe(500);
    expect(storage.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(storage.deleteBlob).toHaveBeenCalledWith(storage.uploadBuffer.mock.calls[0][0]);
  } finally { query.mockRestore(); }
});

test('does not proceed to attachments when loading CRM scope fails', async () => {
  await db.query("UPDATE users SET crm_role='sales_manager' WHERE id=$1", [outsider.id]);
  const originalQuery = db.query;
  const query = jest.spyOn(db, 'query').mockImplementation((sql, params) => {
    if (sql.includes('SELECT ugr.group_id')) return Promise.reject(new Error('Test CRM scope failure'));
    return originalQuery(sql, params);
  });
  try {
    expect((await api('get', `${prefix}/lead/${lead.id}`, outsider)).status).toBe(500);
    expect(storage.downloadDocument).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    await db.query("UPDATE users SET crm_role='salesperson' WHERE id=$1", [outsider.id]);
  }
});

test('hides linked project files when the Projects feature is disabled', async () => {
  await upload('lead', lead.id, 'direct.pdf');
  await upload('project', project.id, 'project.pdf');
  await db.query("UPDATE tenant_features SET is_enabled=false WHERE tenant_id=$1 AND feature='projects'", [tenantId]);
  try {
    const list = await api('get', `${prefix}/lead/${lead.id}?aggregate=true`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].source_type).toBe('lead');
    expect((await api('get', `${prefix}/project/${project.id}`)).status).toBe(403);
  } finally { await db.query("UPDATE tenant_features SET is_enabled=true WHERE tenant_id=$1 AND feature='projects'", [tenantId]); }
});
