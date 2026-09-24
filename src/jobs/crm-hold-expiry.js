'use strict';
// src/jobs/crm-hold-expiry.js
//
// Auto-expires leads whose Hold end date (hold_until) has passed, for every
// tenant. hold_until is a DATE, so an hourly tick is precise enough and keeps
// the job stateless — same setInterval pattern as sms-poller.js.

const logger = require('../utils/logger');
const crmLeadHoldService = require('../services/crmLeadHoldService');

async function tick() {
  try {
    await crmLeadHoldService.expireDueHolds();
  } catch (err) {
    logger.error('[crm-hold-expiry] Tick error', { error: err.message });
  }
}

function startCrmHoldExpiryJob() {
  tick();
  setInterval(tick, 60 * 60_000);
  logger.info('[crm-hold-expiry] Job started (running hourly)');
}

module.exports = { startCrmHoldExpiryJob };
