'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoGenerationJobService.js — manual "generate article" runs as a
// background job (see migration 0300 for why). At most one job per tenant
// at a time: the daily limit is counted from created articles, so parallel
// runs could each pass the check and overshoot it. It also keeps two
// accidental clicks from paying for two articles.
//
// The calendar scheduler (jobs/seo-calendar-scheduler.js) still calls
// generateArticle() directly — it isn't behind an HTTP request.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');
const logger = require('../utils/logger');
const seoContentService = require('./seoContentService');

// Generation takes minutes. A job still running after this long was cut off
// by a restart/deploy and would otherwise block the tenant forever.
const STALE_MINUTES = 30;

async function releaseStaleJobs(tenantId) {
  await db.query(
    `UPDATE seo_generation_jobs
        SET status = 'failed', error = 'Generowanie przerwane (restart serwera) — spróbuj ponownie.', finished_at = now()
      WHERE tenant_id = $1 AND status = 'generating' AND created_at < now() - ($2 || ' minutes')::interval`,
    [tenantId, STALE_MINUTES],
  );
}

async function latestJob(tenantId) {
  await releaseStaleJobs(tenantId);
  const { rows } = await db.query(
    `SELECT id, status, content_id, error, created_at, finished_at
       FROM seo_generation_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  return rows[0] || null;
}

/**
 * Starts a background generation. Returns { job } on success, or
 * { error, status, job? } when the daily limit is reached or a job is
 * already running.
 */
async function startJob(tenantId, userId) {
  await releaseStaleJobs(tenantId);

  const { rows: running } = await db.query(
    `SELECT id, status, content_id, error, created_at, finished_at
       FROM seo_generation_jobs WHERE tenant_id = $1 AND status = 'generating' LIMIT 1`,
    [tenantId],
  );
  if (running.length) return { status: 409, error: 'Artykuł jest już generowany — poczekaj na zakończenie.', job: running[0] };

  const { rows: tenantRows } = await db.query(`SELECT seo_daily_article_limit FROM tenants WHERE id = $1`, [tenantId]);
  const limit = tenantRows[0]?.seo_daily_article_limit ?? 0;
  const generatedToday = await seoContentService.countGeneratedToday(tenantId);
  if (generatedToday >= limit) return { status: 429, error: `Osiągnięto dzienny limit artykułów (${limit}).` };

  const { rows } = await db.query(
    `INSERT INTO seo_generation_jobs (tenant_id, started_by) VALUES ($1, $2)
     RETURNING id, status, content_id, error, created_at, finished_at`,
    [tenantId, userId],
  );
  const job = rows[0];

  seoContentService.generateArticle(tenantId)
    .then((content) => db.query(
      `UPDATE seo_generation_jobs SET status = 'done', content_id = $2, finished_at = now() WHERE id = $1`,
      [job.id, content.id],
    ))
    .catch((err) => {
      logger.error('SEO article generation job failed', { tenantId, jobId: job.id, error: err.message });
      return db.query(
        `UPDATE seo_generation_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [job.id, err.message],
      );
    })
    .catch((err) => logger.error('SEO generation job: could not record outcome', { jobId: job.id, error: err.message }));

  return { job };
}

module.exports = { startJob, latestJob };
