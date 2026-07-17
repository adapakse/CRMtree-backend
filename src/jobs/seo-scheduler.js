'use strict';
// src/jobs/seo-scheduler.js
//
// Publikuje artykuły SEObot ze statusem 'scheduled', których scheduled_at
// minęło. Redaktor ustawia scheduled_at i klika "Zatwierdź i opublikuj" —
// to ten job faktycznie przełącza status na 'published' o wyznaczonej porze.

const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const socialService = require('../services/seoSocialService');

async function publishDueArticles() {
  try {
    const { rows } = await db.query(
      `UPDATE seo_content_pieces
          SET status = 'published', published_at = now()
        WHERE status = 'scheduled' AND scheduled_at <= now()
        RETURNING id, tenant_id, title`,
    );
    for (const row of rows) {
      logger.info('[seo-scheduler] Published scheduled article', { contentId: row.id, tenantId: row.tenant_id, title: row.title });
      socialService.publishToConnectedPlatforms(row.id, row.tenant_id, config.frontendUrl); // fire-and-forget
    }
  } catch (err) {
    logger.error('[seo-scheduler] Tick error', { error: err.message });
  }
}

function startSeoSchedulerJob() {
  setInterval(publishDueArticles, 60_000);
  logger.info('[seo-scheduler] Job started (polling every minute)');
}

module.exports = { startSeoSchedulerJob };
