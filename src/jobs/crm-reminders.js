'use strict';
// src/jobs/crm-reminders.js
//
// Wysyła maile przypominające o zadaniach CRM (lead/partner activities z
// reminder_at w przeszłości i reminder_sent=false). Port 1:1 z worktrips —
// tam ten job odpala się co 5 minut (JobScheduler('CrmReminder', ...,
// { intervalMs: 5*60*1000 })), tu ten sam interwał, tylko bez generycznej
// klasy JobScheduler (CRMtree nie ma jej — każdy job to osobny plik, wzorem
// seo-scheduler.js).

const logger = require('../utils/logger');
const crmReminderService = require('../services/crmReminderService');
const projectDeadlineNotificationService = require('../services/projectDeadlineNotificationService');

async function tick() {
  try {
    await crmReminderService.sendDueReminders();
  } catch (err) {
    logger.error('[crm-reminders] Tick error', { error: err.message });
  }
  // Same clock as the project-task reminders above: the first tick at or after
  // 09:00 Europe/Warsaw sends the daily overdue summaries, later ticks find
  // them already sent. A failure above must not cost the day's summaries.
  try {
    await projectDeadlineNotificationService.sendDailySummaries();
  } catch (err) {
    logger.error('[crm-reminders] Project deadline summaries error', { error: err.message });
  }
}

function startCrmRemindersJob() {
  setInterval(tick, 5 * 60_000);
  logger.info('[crm-reminders] Job started (polling every 5 minutes)');
}

module.exports = { startCrmRemindersJob };
