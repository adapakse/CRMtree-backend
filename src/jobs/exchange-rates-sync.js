'use strict';
// src/jobs/exchange-rates-sync.js
//
// Keeps the NBP exchange rates up to date. NBP publishes table A once per
// business day around noon; the sync is idempotent and only asks for the days
// after the newest stored one, so an hourly tick is enough and keeps the job
// stateless — same setInterval pattern as crm-hold-expiry.js.

const logger = require('../utils/logger');
const exchangeRateService = require('../services/exchangeRateService');

async function tick() {
  try {
    const storedCount = await exchangeRateService.syncMissingRates();
    if (storedCount) logger.info('[exchange-rates-sync] Rates stored', { storedCount });
  } catch (err) {
    logger.error('[exchange-rates-sync] Tick error', { error: err.message });
  }
}

function startExchangeRatesSyncJob() {
  tick();
  setInterval(tick, 60 * 60_000);
  logger.info('[exchange-rates-sync] Job started (running hourly)');
}

module.exports = { startExchangeRatesSyncJob };
