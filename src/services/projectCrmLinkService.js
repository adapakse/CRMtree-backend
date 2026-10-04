'use strict';
// services/projectCrmLinkService.js
//
// Where the Projects module meets the CRM:
//   * linking a project to one lead or one partner (never both);
//   * project tasks shown on a lead / partner card — visible to everyone who
//     can see that lead or partner, project member or not, because the
//     account owner must know a linked project is running;
//   * project tasks assigned to a person, for "my tasks", the CRM calendar
//     and the sales dashboard.

const db = require('../config/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function findLeadInScope({ tenantId, leadId, crmScopeUserIds }) {
  const { rows: [lead] } = await db.query(
    'SELECT id, company, assigned_to FROM crm_leads WHERE id = $1 AND tenant_id = $2', [leadId, tenantId],
  );
  if (!lead) return null;
  // crmScopeUserIds = null means unrestricted (tenant admin).
  if (Array.isArray(crmScopeUserIds) && !crmScopeUserIds.includes(lead.assigned_to)) return null;
  return lead;
}

// The frontend addresses a partner either by its CRM uuid or by its DWH
// integer id. A DWH partner gets a CRM row the first time its card is opened,
// so an integer id without one cannot be linked yet.
async function findPartner({ tenantId, partnerRef }) {
  const ref = String(partnerRef);
  const { rows: [partner] } = UUID_RE.test(ref)
    ? await db.query('SELECT id, company FROM crm_partners WHERE id = $1 AND tenant_id = $2', [ref, tenantId])
    : await db.query(
      'SELECT id, company FROM crm_partners WHERE dwh_partner_id = $1 AND tenant_id = $2',
      [parseInt(ref, 10) || 0, tenantId],
    );
  return partner || null;
}

async function setCrmLink({ tenantId, projectId, leadId, partnerRef, crmScopeUserIds }) {
  if (leadId && partnerRef) throw httpError(400, 'Projekt można powiązać z leadem albo z partnerem, nie z oboma');

  let nextLeadId = null;
  let nextPartnerId = null;
  if (leadId) {
    const lead = await findLeadInScope({ tenantId, leadId, crmScopeUserIds });
    if (!lead) throw httpError(400, 'Nie znaleziono leada lub nie masz do niego dostępu');
    nextLeadId = lead.id;
  } else if (partnerRef) {
    const partner = await findPartner({ tenantId, partnerRef });
    if (!partner) throw httpError(400, 'Nie znaleziono partnera — otwórz najpierw jego kartę w CRM');
    nextPartnerId = partner.id;
  }

  const { rows: [project] } = await db.query(
    `UPDATE projects SET lead_id = $1, partner_id = $2, updated_at = now()
     WHERE id = $3 AND tenant_id = $4
     RETURNING id, lead_id, partner_id`,
    [nextLeadId, nextPartnerId, projectId, tenantId],
  );
  return project;
}

// Called when a lead is converted: its projects follow it to the new partner.
async function moveLeadProjectsToPartner({ tenantId, leadId, partnerId }) {
  await db.query(
    `UPDATE projects SET partner_id = $1, lead_id = NULL, updated_at = now()
     WHERE lead_id = $2 AND tenant_id = $3`,
    [partnerId, leadId, tenantId],
  );
}

const TASK_SUMMARY_COLUMNS = `
  t.id, t.task_number, t.name, t.start_date, t.end_date, t.parent_task_id,
  s.id AS status_id, s.name AS status_name, s.color AS status_color, s.category AS status_category,
  pr.name AS priority_name, pr.color AS priority_color,
  COALESCE((
    SELECT json_agg(json_build_object('user_id', u.id, 'display_name', u.display_name)
                    ORDER BY u.last_name, u.first_name)
    FROM project_task_assignees a
    JOIN users u ON u.id = a.user_id
    WHERE a.task_id = t.id
  ), '[]'::json) AS assignees`;

// Projects linked to a lead or a partner, open ones first, each with its tasks.
// `can_open` tells the card whether the viewer may enter the project itself
// (a member or the tenant admin); everyone else only sees this summary.
async function listLinkedProjects({ tenantId, viewer, leadId = null, partnerId = null }) {
  const { rows: projects } = await db.query(
    `SELECT p.id, p.key, p.name, p.status, p.created_at, p.closed_at,
            ($5::boolean OR EXISTS (
              SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $4
            )) AS can_open
     FROM projects p
     WHERE p.tenant_id = $1
       AND (($2::int IS NOT NULL AND p.lead_id = $2) OR ($3::uuid IS NOT NULL AND p.partner_id = $3))
     ORDER BY (p.status = 'open') DESC, p.created_at DESC`,
    [tenantId, leadId, partnerId, viewer.id, Boolean(viewer.is_admin)],
  );
  if (!projects.length) return [];

  const { rows: tasks } = await db.query(
    `SELECT t.project_id, ${TASK_SUMMARY_COLUMNS}
     FROM project_tasks t
     JOIN project_task_statuses s ON s.id = t.status_id
     LEFT JOIN project_task_priorities pr ON pr.id = t.priority_id
     WHERE t.project_id = ANY($1::uuid[])
     ORDER BY t.task_number`,
    [projects.map((project) => project.id)],
  );
  return projects.map((project) => ({
    ...project,
    tasks: tasks.filter((task) => task.project_id === project.id),
  }));
}

// Tasks of open projects assigned to any of `assigneeIds`.
// A viewer sees their own tasks everywhere; another person's tasks only in
// projects the viewer is a member of (the tenant admin: in every project).
// An external participant never sees tasks other than their own.
async function listAssignedTasks({ tenantId, viewer, assigneeIds, includeDone = false }) {
  const { rows } = await db.query(
    `SELECT p.id AS project_id, p.key AS project_key, p.name AS project_name,
            t.reminder_type, t.reminder_at, t.updated_at,
            ${TASK_SUMMARY_COLUMNS}
     FROM project_tasks t
     JOIN projects p ON p.id = t.project_id
     JOIN project_task_statuses s ON s.id = t.status_id
     LEFT JOIN project_task_priorities pr ON pr.id = t.priority_id
     LEFT JOIN project_members viewer_membership
            ON viewer_membership.project_id = p.id AND viewer_membership.user_id = $2
     WHERE t.tenant_id = $1
       AND p.status = 'open'
       AND ($4::boolean OR s.category <> 'done')
       AND EXISTS (SELECT 1 FROM project_task_assignees a
                   WHERE a.task_id = t.id AND a.user_id = ANY($3::uuid[]))
       AND (
         EXISTS (SELECT 1 FROM project_task_assignees mine WHERE mine.task_id = t.id AND mine.user_id = $2)
         OR $5::boolean
         OR (viewer_membership.user_id IS NOT NULL AND viewer_membership.role <> 'external_participant')
       )
     ORDER BY t.end_date NULLS LAST, p.key, t.task_number`,
    [tenantId, viewer.id, assigneeIds, includeDone, Boolean(viewer.is_admin)],
  );
  return rows;
}

module.exports = {
  findLeadInScope,
  findPartner,
  setCrmLink,
  moveLeadProjectsToPartner,
  listLinkedProjects,
  listAssignedTasks,
};
