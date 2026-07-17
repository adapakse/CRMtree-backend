'use strict';
// src/jobs/seo-content-refresh.js
//
// Oznacza opublikowane artykuły SEObot starsze niż REFRESH_AFTER_DAYS jako
// needs_update, żeby wróciły do kolejki redakcyjnej do odświeżenia — SEObot
// ma pielęgnować starą treść, nie tylko produkować nową. Staleness zmienia
// się wolno, więc job odpala się raz dziennie (plus jednorazowo przy starcie).

const db = require('../config/database');
const logger = require('../utils/logger');

const REFRESH_AFTER_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

async function flagStaleArticles() {
  try {
    const { rows } = await db.query(
      `UPDATE seo_content_pieces
          SET status = 'needs_update'
        WHERE status = 'published' AND published_at < now() - ($1 || ' days')::interval
        RETURNING id, tenant_id, title`,
      [REFRESH_AFTER_DAYS],
    );
    for (const row of rows) {
      logger.info('[seo-content-refresh] Flagged stale article for refresh', { contentId: row.id, tenantId: row.tenant_id, title: row.title });
    }
  } catch (err) {
    logger.error('[seo-content-refresh] Tick error', { error: err.message });
  }
}

function startSeoContentRefreshJob() {
  setInterval(flagStaleArticles, DAY_MS);
  flagStaleArticles();
  logger.info(`[seo-content-refresh] Job started (daily, flags articles published >${REFRESH_AFTER_DAYS} days ago)`);
}

module.exports = { startSeoContentRefreshJob };
