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

async function tick() {
  try {
    await crmReminderService.sendDueReminders();
  } catch (err) {
    logger.error('[crm-reminders] Tick error', { error: err.message });
  }
}

function startCrmRemindersJob() {
  setInterval(tick, 5 * 60_000);
  logger.info('[crm-reminders] Job started (polling every 5 minutes)');
}

module.exports = { startCrmRemindersJob };
