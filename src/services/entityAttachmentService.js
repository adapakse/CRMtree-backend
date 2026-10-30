'use strict';

const db = require('../config/database');
const projectService = require('./projectService');
const projectTaskService = require('./projectTaskService');
const { canOperateForOwner } = require('../middleware/crm-rbac');

const SOURCES = {
  lead: { table: 'crm_leads', column: 'lead_id', owner: 'assigned_to', module: 'leads' },
  partner: { table: 'crm_partners', column: 'partner_id', owner: 'manager_id', module: 'partners' },
  'lead-activity': { table: 'crm_lead_activities', column: 'lead_activity_id', parent: 'lead', module: 'leads' },
  'partner-activity': { table: 'crm_partner_activities', column: 'partner_activity_id', parent: 'partner', module: 'partners' },
  project: { table: 'projects', column: 'project_id' },
  'project-task': { table: 'project_tasks', column: 'project_task_id' },
};

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function scopeIncludesOwner(req, owners) {
  return req.crmScopeUserIds === null || (Array.isArray(req.crmScopeUserIds) &&
    owners.some(owner => owner && req.crmScopeUserIds.includes(owner)));
}

async function resolveSource(req, type, id) {
  const definition = SOURCES[type];
  if (!definition) fail(400, 'Invalid attachment source');
  const integerId = type === 'lead' || type.endsWith('-activity');
  if (!(integerId ? /^[1-9]\d*$/.test(String(id)) && Number(id) <= 2147483647 : /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(id)))) {
    fail(400, 'Invalid attachment source ID');
  }
  const { rows: [record] } = await db.query(
    `SELECT * FROM ${definition.table} WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId],
  );
  if (!record) fail(404, 'Attachment source not found');

  if (definition.parent) {
    const parentDefinition = SOURCES[definition.parent];
    const { rows: [parent] } = await db.query(
      `SELECT * FROM ${parentDefinition.table} WHERE id = $1 AND tenant_id = $2`,
      [record[`${definition.parent}_id`], req.tenantId],
    );
    if (!parent) fail(404, 'Attachment source not found');
    const owners = [parent[parentDefinition.owner], record.assigned_to, record.created_by].filter(Boolean);
    if (!scopeIncludesOwner(req, owners)) {
      fail(404, 'Attachment source not found');
    }
    return { type, id: record.id, record, canWrite: owners.some(owner => canOperateForOwner(req, owner)) };
  }
  if (definition.owner) {
    if (!scopeIncludesOwner(req, [record[definition.owner]])) {
      fail(404, 'Attachment source not found');
    }
    return { type, id: record.id, record, canWrite: canOperateForOwner(req, record[definition.owner]) };
  }

  const access = await projectService.loadProjectForUser({
    tenantId: req.tenantId, user: req.user, projectId: type === 'project' ? record.id : record.project_id,
  });
  if (!access) fail(404, 'Attachment source not found');
  let canWrite = access.project.status === 'open' && (access.canManage ||
    (access.membership?.access_level === 'full' && access.membership.role === 'internal_participant'));
  if (type === 'project-task') {
    const task = await projectTaskService.getTask({
      tenantId: req.tenantId, project: access.project, taskId: record.id,
      actor: { user: req.user, membership: access.membership, canManage: access.canManage },
    });
    if (!task) fail(404, 'Attachment source not found');
    canWrite = task.permissions.can_edit_content;
  }
  return { type, id: record.id, record, canWrite };
}

const attachmentSelect = `
  SELECT a.id, a.filename, a.mime_type, a.file_size, a.created_by, a.created_at,
    u.display_name AS author_name,
    CASE WHEN a.lead_id IS NOT NULL THEN 'lead' WHEN a.partner_id IS NOT NULL THEN 'partner'
      WHEN a.lead_activity_id IS NOT NULL THEN 'lead-activity'
      WHEN a.partner_activity_id IS NOT NULL THEN 'partner-activity'
      WHEN a.project_id IS NOT NULL THEN 'project' ELSE 'project-task' END AS source_type,
    COALESCE(a.lead_id::text, a.partner_id::text, a.lead_activity_id::text,
      a.partner_activity_id::text, a.project_id::text, a.project_task_id::text) AS source_id,
    COALESCE(la.type, pa.type, CASE WHEN a.project_task_id IS NOT NULL THEN 'project-task'
      WHEN a.project_id IS NOT NULL THEN 'project' ELSE 'direct' END) AS source_category,
    COALESCE(la.title, pa.title, pt.name, p.name, l.company, partner.company) AS source_name,
    p.id AS project_id, p.name AS project_name
  FROM entity_attachments a
  LEFT JOIN users u ON u.id = a.created_by AND u.tenant_id = a.tenant_id
  LEFT JOIN crm_lead_activities la ON la.id = a.lead_activity_id AND la.tenant_id = a.tenant_id
  LEFT JOIN crm_partner_activities pa ON pa.id = a.partner_activity_id AND pa.tenant_id = a.tenant_id
  LEFT JOIN project_tasks pt ON pt.id = a.project_task_id AND pt.tenant_id = a.tenant_id
  LEFT JOIN projects p ON p.id = COALESCE(a.project_id, pt.project_id) AND p.tenant_id = a.tenant_id
  LEFT JOIN crm_leads l ON l.id = a.lead_id AND l.tenant_id = a.tenant_id
  LEFT JOIN crm_partners partner ON partner.id = a.partner_id AND partner.tenant_id = a.tenant_id`;

async function listAttachments(req, source, filters) {
  const params = [req.tenantId, source.id];
  const conditions = ['a.tenant_id = $1'];
  if ((source.type === 'lead' || source.type === 'partner') && filters.aggregate === 'true') {
    const key = `${source.type}_id`;
    const activity = source.type === 'lead' ? 'la' : 'pa';
    conditions.push(`(a.${key} = $2 OR ${activity}.${key} = $2 OR (
      p.${key} = $2 AND ($3::boolean OR EXISTS (
        SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $4
          AND (a.project_task_id IS NULL OR m.role <> 'external_participant' OR EXISTS (
            SELECT 1 FROM project_task_assignees assigned WHERE assigned.task_id = pt.id AND assigned.user_id = $4
          ))
      )) AND NOT EXISTS (
        SELECT 1 FROM tenant_features f WHERE f.tenant_id = $1 AND f.feature = 'projects' AND NOT f.is_enabled
      )
    ))`);
    params.push(Boolean(req.user.is_admin), req.user.id);
  } else {
    conditions.push(`a.${SOURCES[source.type].column} = $2`);
  }
  const addFilter = (value, expression) => {
    if (!value) return;
    params.push(value);
    conditions.push(expression.replace('?', `$${params.length}`));
  };
  addFilter(filters.filename, 'filename ILIKE ?');
  addFilter(filters.source, 'source_category = ?');
  addFilter(filters.place, "source_type || ':' || source_id = ?");
  addFilter(filters.author, 'created_by = ?::uuid');
  addFilter(filters.created_from, 'created_at >= ?::date');
  addFilter(filters.created_to, "created_at < ?::date + INTERVAL '1 day'");
  const baseConditions = conditions.splice(0, 2);
  const unfiltered = `WITH attachments AS (${attachmentSelect} WHERE ${baseConditions.join(' AND ')})`;
  const filtered = `${unfiltered}
    SELECT * FROM attachments ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`;
  const { rows: [count] } = await db.query(`SELECT COUNT(*)::int AS total FROM (${filtered}) counted`, params);
  const sort = { filename: 'filename', source: 'source_category', place: 'source_name', author: 'author_name', created_at: 'created_at' }[filters.sort] || 'source_category';
  const order = filters.order === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await db.query(
    `${filtered} ORDER BY ${sort} ${order} NULLS LAST, project_name, source_name, source_type, source_id, created_at DESC, id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.page_size, (filters.page - 1) * filters.page_size],
  );
  // Dropdown options come from the unfiltered set, so picking one value never hides the others.
  const baseParams = params.slice(0, baseParamCount(source, filters));
  const { rows: authors } = await db.query(
    `${unfiltered} SELECT DISTINCT created_by AS id, author_name AS name FROM attachments
      WHERE created_by IS NOT NULL ORDER BY author_name`, baseParams);
  const { rows: places } = await db.query(
    `${unfiltered} SELECT DISTINCT source_type || ':' || source_id AS key, source_category AS category,
        CASE WHEN source_type = 'project-task' THEN project_name || ' / ' || source_name ELSE source_name END AS label
      FROM attachments ORDER BY label`, baseParams);
  return {
    items: rows, total: count.total, page: filters.page, page_size: filters.page_size, can_write: source.canWrite,
    filter_options: { authors, places },
  };
}

function baseParamCount(source, filters) {
  return (source.type === 'lead' || source.type === 'partner') && filters.aggregate === 'true' ? 4 : 2;
}

async function copyLeadActivitiesToPartner({ tenantId, leadId, partnerId }) {
  await db.transaction(async client => {
    // Allocate the new IDs before inserting so files keep the exact activity
    // association even when two notes have identical titles and timestamps.
    await client.query(`
      WITH source AS MATERIALIZED (
        SELECT a.*, nextval(pg_get_serial_sequence('crm_partner_activities', 'id')) AS new_id
        FROM crm_lead_activities a WHERE a.lead_id = $2 AND a.tenant_id = $3
      ), copied AS (
        INSERT INTO crm_partner_activities
          (id, partner_id, tenant_id, type, title, body, activity_at, duration_min, participants, doc_id,
           created_by, created_at, updated_at, meeting_location, gmail_thread_id, gmail_message_id,
           status, close_comment, assigned_to, is_read, email_provider, priority)
        -- Reminder columns are deliberately not copied (as before this change): the lead
        -- activity keeps its reminder, so a copy would send the same reminder twice.
        SELECT new_id, $1, $3, type, title, body, activity_at, duration_min, participants, doc_id,
           created_by, created_at, updated_at, meeting_location, gmail_thread_id, gmail_message_id,
           status, close_comment, assigned_to, is_read, email_provider, priority
        FROM source RETURNING id
      )
      UPDATE entity_attachments a SET lead_activity_id = NULL, partner_activity_id = source.new_id
      FROM source JOIN copied ON copied.id = source.new_id
      WHERE a.lead_activity_id = source.id AND a.tenant_id = $3`, [partnerId, leadId, tenantId]);
    await client.query(`UPDATE entity_attachments SET lead_id = NULL, partner_id = $1
      WHERE lead_id = $2 AND tenant_id = $3`, [partnerId, leadId, tenantId]);
  });
}

module.exports = { SOURCES, resolveSource, listAttachments, copyLeadActivitiesToPartner };
