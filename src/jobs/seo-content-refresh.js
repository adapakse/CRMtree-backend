'use strict';
// src/jobs/seo-content-refresh.js
//
// Codziennie (i raz przy starcie) kolejkuje opublikowane artykuły SEObot do
// odświeżenia według metryk Search Console, z wiekiem jako regułą zapasową
// (logika w services/seoRefreshService.js). Artykuł w kolejce ZOSTAJE
// opublikowany — wcześniejsza wersja tego joba zmieniała status na
// needs_update, co zdejmowało artykuł ze strony i z mapy strony.

const db = require('../config/database');
const logger = require('../utils/logger');
const refreshService = require('../services/seoRefreshService');

const DAY_MS = 24 * 3600 * 1000;
// Generating a draft takes minutes, so anything still "generating" after this
// long was cut off by a restart/deploy and would otherwise stay locked forever.
const STUCK_GENERATION_MINUTES = 30;

async function releaseStuckGenerations() {
  const { rows } = await db.query(
    `UPDATE seo_content_pieces
        SET refresh_status = 'failed', refresh_error = 'Generowanie przerwane (restart serwera) — spróbuj ponownie.'
      WHERE refresh_status = 'generating' AND updated_at < now() - ($1 || ' minutes')::interval
      RETURNING id`,
    [STUCK_GENERATION_MINUTES],
  );
  if (rows.length) logger.warn('[seo-content-refresh] Released stuck draft generations', { contentIds: rows.map((r) => r.id) });
}

async function tick() {
  try {
    await releaseStuckGenerations();
    const { rows: tenants } = await db.query(
      `SELECT DISTINCT tenant_id FROM seo_content_pieces WHERE status = 'published'`,
    );
    for (const { tenant_id: tenantId } of tenants) {
      const counts = await refreshService.flagArticlesForTenant(tenantId);
      const total = counts.striking_distance + counts.position_drop + counts.age;
      if (total) logger.info('[seo-content-refresh] Queued articles for refresh', { tenantId, ...counts });
    }
  } catch (err) {
    logger.error('[seo-content-refresh] Tick error', { error: err.message });
  }
}

function startSeoContentRefreshJob() {
  setInterval(tick, DAY_MS);
  tick();
  logger.info('[seo-content-refresh] Job started (daily, metrics-driven refresh queue)');
}

module.exports = { startSeoContentRefreshJob };
