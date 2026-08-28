'use strict';
// src/jobs/sms-poller.js
//
// Automatic background sync for SMS (no webhook exists from ip-pbx.eu, see
// smsSyncService.js) — same setInterval pattern as crm-reminders.js.

const logger = require('../utils/logger');
const smsPollerService = require('../services/smsPollerService');

async function tick() {
  try {
    await smsPollerService.syncDueSms();
  } catch (err) {
    logger.error('[sms-poller] Tick error', { error: err.message });
  }
}

function startSmsPollerJob() {
  setInterval(tick, 5 * 60_000);
  logger.info('[sms-poller] Job started (polling every 5 minutes)');
}

module.exports = { startSmsPollerJob };
