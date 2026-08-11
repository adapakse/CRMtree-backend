'use strict';
// src/jobs/gsc-metrics-sync.js
//
// Codzienna synchronizacja metryk Search Console (wyświetlenia/kliknięcia/pozycja)
// dla opublikowanych artykułów SEObot, dla każdego tenanta z podłączonym GSC.
// Wzorowane na jobs/daily-scores.js.

const db = require('../config/database');
const gscService = require('../services/gscService');
const logger = require('../utils/logger');

const lastRun = new Map(); // tenantId → 'YYYY-MM-DD'
const RUN_TIME = '07:00';
// GSC dane finalizują się z opóźnieniem ~2-3 dni — synchronizujemy dzień T-3.
const SYNC_LAG_DAYS = 3;

async function runForTenant(tenantId, siteUrl) {
  logger.info('[gsc-metrics-sync] Start', { tenantId });
  const { rows: articles } = await db.query(
    `SELECT id, slug FROM seo_content_pieces WHERE tenant_id = $1 AND status = 'published'`,
    [tenantId],
  );
  if (!articles.length) return;

  const date = new Date();
  date.setDate(date.getDate() - SYNC_LAG_DAYS);
  const dateStr = date.toISOString().slice(0, 10);

  let synced = 0, failed = 0;
  for (const article of articles) {
    const pageUrl = `${siteUrl.replace(/\/$/, '')}/blog/${article.slug}`;
    try {
      await gscService.syncMetricsForContent(tenantId, article.id, pageUrl, dateStr);
      synced++;
    } catch (err) {
      failed++;
      logger.warn('[gsc-metrics-sync] Failed for article', { tenantId, contentId: article.id, error: err.message });
    }
  }
  logger.info('[gsc-metrics-sync] Done', { tenantId, synced, failed, date: dateStr });
}

const TZ = 'Europe/Warsaw';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

function startGscMetricsSyncJob() {
  setInterval(async () => {
    const now = new Date();
    const hhmm = timeFmt.format(now);
    const today = dateFmt.format(now);
    if (hhmm !== RUN_TIME) return;

    try {
      const { rows: tenants } = await db.query(`SELECT tenant_id, site_url FROM tenant_gsc_tokens`);
      for (const t of tenants) {
        if (lastRun.get(t.tenant_id) === today) continue;
        lastRun.set(t.tenant_id, today);
        runForTenant(t.tenant_id, t.site_url); // fire-and-forget
      }
    } catch (err) {
      logger.error('[gsc-metrics-sync] Scheduler tick error', { error: err.message });
    }
  }, 60_000);

  logger.info(`[gsc-metrics-sync] Job started (polling every minute, daily run at ${RUN_TIME})`);
}

module.exports = { startGscMetricsSyncJob, runForTenant };
