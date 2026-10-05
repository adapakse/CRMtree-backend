'use strict';
// src/jobs/ksef-sync.js
//
// Pulls purchase invoices from KSeF for every configured company. The service
// keeps a cursor per company and takes a Postgres advisory lock per company,
// so the job is stateless and safe to run on several instances — same
// setInterval pattern as exchange-rates-sync.js.
//
// Every 30 minutes: KSeF allows 20 exports per hour per NIP and one run uses
// at most 6 (MAX_EXPORTS_PER_RUN in ksefSyncService).

const logger = require('../utils/logger');
const ksefApiClient = require('../services/ksefApiClient');
const ksefSyncService = require('../services/ksefSyncService');

const INTERVAL_MS = 30 * 60_000;

async function tick() {
  try {
    const results = await ksefSyncService.syncCompaniesOf();
    const inserted = results.reduce((total, result) => total + (result.inserted || 0), 0);
    const failed = results.filter((result) => ['error', 'invalid'].includes(result.status)).length;
    if (inserted || failed) {
      logger.info('[ksef-sync] Run finished', { companies: results.length, inserted, failed });
    }
  } catch (err) {
    logger.error('[ksef-sync] Tick error', { error: err.message });
  }
}

function startKsefSyncJob() {
  if (!ksefApiClient.isConfigured()) {
    logger.warn('[ksef-sync] KSEF_ENVIRONMENT is not set (test | production) — KSeF sync is off');
    return;
  }
  tick();
  setInterval(tick, INTERVAL_MS);
  logger.info('[ksef-sync] Job started (running every 30 minutes)', { environment: ksefApiClient.getEnvironment() });
}

module.exports = { startKsefSyncJob };
