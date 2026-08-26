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
      COALESCE(u_a.display_name, u_c.display_name) AS recipient_name
    FROM crm_lead_activities a
    JOIN crm_leads l          ON l.id = a.lead_id AND l.tenant_id = a.tenant_id
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
      COALESCE(u_a.display_name, u_c.display_name) AS recipient_name
    FROM crm_partner_activities a
    JOIN crm_partners p         ON p.id = a.partner_id AND p.tenant_id = a.tenant_id
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

  logger.info(`[CrmReminder] Wysłano ${totalSent} przypomnień (lead: ${leadActs.length}, partner: ${partnerActs.length})`);
  return { totalSent, leadCount: leadActs.length, partnerCount: partnerActs.length };
}

module.exports = { sendDueReminders };
