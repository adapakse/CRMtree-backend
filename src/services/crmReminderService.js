'use strict';
// src/services/crmReminderService.js
//
// Job — wysyłka maili przypominających o nadchodzących zadaniach CRM.
// Port 1:1 z worktrips (src/services/crmReminderService.js).
//
// Logika:
//  1. Pobierz wszystkie aktywności (lead + partner) gdzie:
//       reminder_at <= now()   AND   reminder_sent = false
//  2. Dla każdej: wyślij mail do przypisanego usera (lub twórcy gdy brak assignee)
//  3. Oznacz reminder_sent = true

const db     = require('../config/database');
const logger = require('../utils/logger');
const email  = require('../utils/email');
const { resolveLocale } = require('../config/locales');

async function sendDueReminders() {
  const now = new Date().toISOString();
  let totalSent = 0;

  // ── Leady ─────────────────────────────────────────────────────────────────
  const { rows: leadActs } = await db.query(`
    SELECT
      a.id, a.tenant_id, a.type, a.title, a.body, a.activity_at, a.reminder_type,
      l.id   AS source_id,
      l.company AS source_name,
      -- Odbiorca: przypisany user lub twórca
      COALESCE(u_a.email, u_c.email)           AS recipient_email,
      COALESCE(u_a.display_name, u_c.display_name) AS recipient_name,
      CASE WHEN u_a.email IS NOT NULL THEN u_a.locale ELSE u_c.locale END AS recipient_locale,
      t.default_locale AS tenant_default_locale
    FROM crm_lead_activities a
    JOIN crm_leads l          ON l.id = a.lead_id AND l.tenant_id = a.tenant_id
    JOIN tenants t            ON t.id = a.tenant_id
    LEFT JOIN users u_a       ON u_a.id = a.assigned_to AND u_a.tenant_id = a.tenant_id
    LEFT JOIN users u_c       ON u_c.id = a.created_by  AND u_c.tenant_id = a.tenant_id
    WHERE a.reminder_at <= $1
      AND a.reminder_sent = false
      AND a.status != 'closed'
  `, [now]);

  for (const act of leadActs) {
    try {
      await email.sendActivityReminder({
        to:            act.recipient_email,
        locale:        resolveLocale({ userLocale: act.recipient_locale, tenantDefaultLocale: act.tenant_default_locale }),
        recipientName: act.recipient_name,
        activityType:  act.type,
        activityTitle: act.title,
        activityAt:    act.activity_at,
        reminderType:  act.reminder_type,
        sourceType:    'lead',
        sourceId:      String(act.source_id),
        sourceName:    act.source_name,
      });
      await db.query(
        'UPDATE crm_lead_activities SET reminder_sent = true WHERE id = $1 AND tenant_id = $2',
        [act.id, act.tenant_id],
      );
      totalSent++;
    } catch (err) {
      logger.error(`[CrmReminder] Błąd lead activity ${act.id}`, { error: err.message });
    }
  }

  // ── Partnerzy ─────────────────────────────────────────────────────────────
  const { rows: partnerActs } = await db.query(`
    SELECT
      a.id, a.tenant_id, a.type, a.title, a.body, a.activity_at, a.reminder_type,
      p.id   AS source_id,
      p.company AS source_name,
      COALESCE(u_a.email, u_c.email)           AS recipient_email,
      COALESCE(u_a.display_name, u_c.display_name) AS recipient_name,
      CASE WHEN u_a.email IS NOT NULL THEN u_a.locale ELSE u_c.locale END AS recipient_locale,
      t.default_locale AS tenant_default_locale
    FROM crm_partner_activities a
    JOIN crm_partners p         ON p.id = a.partner_id AND p.tenant_id = a.tenant_id
    JOIN tenants t              ON t.id = a.tenant_id
    LEFT JOIN users u_a         ON u_a.id = a.assigned_to AND u_a.tenant_id = a.tenant_id
    LEFT JOIN users u_c         ON u_c.id = a.created_by  AND u_c.tenant_id = a.tenant_id
    WHERE a.reminder_at <= $1
      AND a.reminder_sent = false
      AND a.status != 'closed'
  `, [now]);

  for (const act of partnerActs) {
    try {
      await email.sendActivityReminder({
        to:            act.recipient_email,
        locale:        resolveLocale({ userLocale: act.recipient_locale, tenantDefaultLocale: act.tenant_default_locale }),
        recipientName: act.recipient_name,
        activityType:  act.type,
        activityTitle: act.title,
        activityAt:    act.activity_at,
        reminderType:  act.reminder_type,
        sourceType:    'partner',
        sourceId:      String(act.source_id),
        sourceName:    act.source_name,
      });
      await db.query(
        'UPDATE crm_partner_activities SET reminder_sent = true WHERE id = $1 AND tenant_id = $2',
        [act.id, act.tenant_id],
      );
      totalSent++;
    } catch (err) {
      logger.error(`[CrmReminder] Błąd partner activity ${act.id}`, { error: err.message });
    }
  }

  // ── Project tasks ─────────────────────────────────────────────────────────
  // One email per assignee. Finished tasks and tasks of closed projects are
  // left alone, so their reminder fires if they are reopened later.
  const { rows: projectTasks } = await db.query(`
    SELECT
      t.id, t.task_number, t.name, t.end_date, t.reminder_type,
      p.id AS project_id, p.key AS project_key, p.name AS project_name,
      tn.default_locale AS tenant_default_locale,
      COALESCE((
        SELECT json_agg(json_build_object('email', u.email, 'name', u.display_name, 'locale', u.locale))
        FROM project_task_assignees a
        JOIN users u ON u.id = a.user_id AND u.is_active
        WHERE a.task_id = t.id
      ), '[]'::json) AS recipients
    FROM project_tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN tenants tn ON tn.id = p.tenant_id
    JOIN project_task_statuses s ON s.id = t.status_id
    WHERE t.reminder_at <= $1
      AND t.reminder_sent = false
      AND s.category <> 'done'
      AND p.status = 'open'
  `, [now]);

  for (const task of projectTasks) {
    try {
      for (const recipient of task.recipients) {
        await email.sendProjectTaskReminder({
          to:            recipient.email,
          locale:        resolveLocale({ userLocale: recipient.locale, tenantDefaultLocale: task.tenant_default_locale }),
          recipientName: recipient.name,
          projectId:     task.project_id,
          projectName:   task.project_name,
          taskId:        task.id,
          taskLabel:     `${task.project_key}-${task.task_number}`,
          taskName:      task.name,
          endDate:       task.end_date,
          reminderType:  task.reminder_type,
        });
        totalSent++;
      }
      await db.query('UPDATE project_tasks SET reminder_sent = true WHERE id = $1', [task.id]);
    } catch (err) {
      logger.error(`[CrmReminder] Błąd project task ${task.id}`, { error: err.message });
    }
  }

  logger.info(`[CrmReminder] Wysłano ${totalSent} przypomnień (lead: ${leadActs.length}, partner: ${partnerActs.length}, projekty: ${projectTasks.length})`);
  return { totalSent, leadCount: leadActs.length, partnerCount: partnerActs.length, projectTaskCount: projectTasks.length };
}

module.exports = { sendDueReminders };
