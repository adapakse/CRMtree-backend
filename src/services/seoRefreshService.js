'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoRefreshService.js — which published articles to refresh, and
// the lifecycle of a proposed refresh.
//
// Selection by Search Console metrics, most promising first, with age as
// the fallback. Replaced the old age-only job (2026-09-26, Adam's request):
//   1. striking_distance — avg position 8-20 with real impressions: closest
//      to page 1, so the cheapest ranking gain.
//   2. position_drop — the last 14 days rank clearly worse than the 14
//      before.
//   3. age — not refreshed (or reviewed) for 90+ days.
// Metrics come straight from the GSC API for the whole window, one call per
// window per tenant, rather than from the day-by-day seo_metrics table,
// which has no history backfill.
//
// A queued article stays published. refreshArticle() generates a proposed
// revision in the background (it takes minutes — longer than an HTTP request
// may stay open behind Azure's ingress), and nothing changes on the live site
// until an editor applies it. Same human-review posture as new articles.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');
const logger = require('../utils/logger');
const gscService = require('./gscService');
const seoContentService = require('./seoContentService');
const indexNowService = require('./indexNowService');
const wordpressService = require('./socialPublish/wordpressService');
const { renderBodyHtml } = require('../utils/seoMarkdown');

const DAY_MS = 24 * 3600 * 1000;
// GSC data finalizes with a ~3-day lag (same as jobs/gsc-metrics-sync.js).
const GSC_LAG_DAYS = 3;
const STRIKING_MIN_IMPRESSIONS = 30;
const STRIKING_POSITION_MIN = 8;
const STRIKING_POSITION_MAX = 20;
const DROP_MIN_IMPRESSIONS = 20;
const DROP_MIN_POSITIONS = 5;
const AGE_DAYS = 90;
// Articles published/refreshed/reviewed within this window aren't judged on
// metrics yet — Google needs a few weeks to re-evaluate a page.
const COOLDOWN_DAYS = 30;

const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);

async function queue(contentId, reason, signal) {
  await db.query(
    `UPDATE seo_content_pieces
        SET refresh_reason = $2, refresh_requested_at = now(), refresh_signal = $3
      WHERE id = $1 AND refresh_reason IS NULL`,
    [contentId, reason, signal ? JSON.stringify(signal) : null],
  );
}

/** Daily: queue this tenant's published articles that need a refresh. Returns counts per reason. */
async function flagArticlesForTenant(tenantId) {
  const { rows: articles } = await db.query(
    `SELECT c.id, c.slug, wp.remote_url AS wordpress_url,
            GREATEST(c.published_at, c.last_refreshed_at, c.refresh_dismissed_at) AS last_touched_at
       FROM seo_content_pieces c
       LEFT JOIN seo_social_posts wp ON wp.content_id = c.id AND wp.platform = 'wordpress' AND wp.status = 'published'
      WHERE c.tenant_id = $1 AND c.status = 'published' AND c.refresh_reason IS NULL
        AND GREATEST(c.published_at, c.last_refreshed_at, c.refresh_dismissed_at) < now() - ($2 || ' days')::interval`,
    [tenantId, COOLDOWN_DAYS],
  );
  const counts = { striking_distance: 0, position_drop: 0, age: 0 };
  if (!articles.length) return counts;

  let last28 = null, recent14 = null, prior14 = null, siteUrl = null;
  try {
    const end = daysAgo(GSC_LAG_DAYS);
    const mid = daysAgo(GSC_LAG_DAYS + 14);
    ({ byPage: last28, siteUrl } = await gscService.getPageMetrics(tenantId, daysAgo(GSC_LAG_DAYS + 28), end));
    ({ byPage: recent14 } = await gscService.getPageMetrics(tenantId, mid, end));
    ({ byPage: prior14 } = await gscService.getPageMetrics(tenantId, daysAgo(GSC_LAG_DAYS + 28), mid));
  } catch (err) {
    logger.info('[seo-refresh] No GSC metrics — age rule only', { tenantId, reason: err.message });
  }

  for (const article of articles) {
    if (last28) {
      const pageUrl = gscService.articlePageUrl(article, siteUrl);
      const m = last28.get(pageUrl);
      if (m && m.impressions >= STRIKING_MIN_IMPRESSIONS && m.position >= STRIKING_POSITION_MIN && m.position <= STRIKING_POSITION_MAX) {
        await queue(article.id, 'striking_distance', { impressions: m.impressions, clicks: m.clicks, position: m.position });
        counts.striking_distance++;
        continue;
      }
      const now14 = recent14.get(pageUrl);
      const before14 = prior14.get(pageUrl);
      if (now14 && before14 && now14.impressions >= DROP_MIN_IMPRESSIONS && before14.impressions >= DROP_MIN_IMPRESSIONS
          && now14.position - before14.position >= DROP_MIN_POSITIONS) {
        await queue(article.id, 'position_drop', { positionBefore: before14.position, positionNow: now14.position, impressions: now14.impressions });
        counts.position_drop++;
        continue;
      }
    }
    if (new Date(article.last_touched_at) < daysAgo(AGE_DAYS)) {
      await queue(article.id, 'age', null);
      counts.age++;
    }
  }
  return counts;
}

/** Editor queues a published article by hand. */
async function requestRefresh(contentId, tenantId) {
  const { rows } = await db.query(
    `UPDATE seo_content_pieces
        SET refresh_reason = 'manual', refresh_requested_at = now(), refresh_signal = NULL
      WHERE id = $1 AND tenant_id = $2 AND status = 'published' AND refresh_reason IS NULL
      RETURNING *`,
    [contentId, tenantId],
  );
  return rows[0] || null;
}

/** Kicks off draft generation in the background. Returns false if the article isn't queued or a draft is already being generated. */
async function startDraftGeneration(contentId, tenantId) {
  const { rows } = await db.query(
    `UPDATE seo_content_pieces
        SET refresh_status = 'generating', refresh_error = NULL
      WHERE id = $1 AND tenant_id = $2 AND status = 'published' AND refresh_reason IS NOT NULL
        AND refresh_status IS DISTINCT FROM 'generating'
      RETURNING id`,
    [contentId, tenantId],
  );
  if (!rows.length) return false;

  seoContentService.refreshArticle(contentId, tenantId)
    .then((draft) => db.query(
      `UPDATE seo_content_pieces SET refresh_status = 'ready', refresh_draft = $2 WHERE id = $1`,
      [contentId, JSON.stringify(draft)],
    ))
    .catch((err) => {
      logger.error('[seo-refresh] Draft generation failed', { contentId, tenantId, error: err.message });
      return db.query(
        `UPDATE seo_content_pieces SET refresh_status = 'failed', refresh_error = $2 WHERE id = $1`,
        [contentId, err.message],
      );
    })
    .catch((err) => logger.error('[seo-refresh] Could not record draft outcome', { contentId, error: err.message }));
  return true;
}

/** Puts the proposed revision live. The article keeps its slug, status and published_at. */
async function applyRefresh(contentId, tenantId) {
  const { rows } = await db.query(
    `UPDATE seo_content_pieces
        SET title = refresh_draft->>'title',
            meta_description = refresh_draft->>'meta_description',
            body = refresh_draft->>'body',
            faq = refresh_draft->'faq',
            last_refreshed_at = now(),
            refresh_reason = NULL, refresh_requested_at = NULL, refresh_signal = NULL,
            refresh_status = NULL, refresh_draft = NULL, refresh_error = NULL
      WHERE id = $1 AND tenant_id = $2 AND status = 'published' AND refresh_status = 'ready'
      RETURNING *`,
    [contentId, tenantId],
  );
  const updated = rows[0];
  if (!updated) return null;

  indexNowService.notifyArticleChanged(updated.id, tenantId);
  syncToWordpress(updated, tenantId);
  return updated;
}

// A client tenant's article also lives on their WordPress site; without this
// a refresh would only change our own copy. Fire-and-forget, like the
// original WP publish — the outcome is logged, not surfaced.
async function syncToWordpress(article, tenantId) {
  try {
    const { rows } = await db.query(
      `SELECT remote_post_id FROM seo_social_posts
        WHERE content_id = $1 AND platform = 'wordpress' AND status = 'published' AND remote_post_id IS NOT NULL`,
      [article.id],
    );
    if (!rows.length) return;
    await wordpressService.updatePost(tenantId, rows[0].remote_post_id, {
      title: article.title,
      contentHtml: renderBodyHtml(article.body),
      excerpt: article.meta_description,
    });
    logger.info('[seo-refresh] WordPress post updated', { contentId: article.id, tenantId });
  } catch (err) {
    logger.warn('[seo-refresh] WordPress update failed', { contentId: article.id, tenantId, error: err.message });
  }
}

/** Editor decides no refresh is needed (or rejects the proposal). Restarts the cooldown without touching the live content. */
async function dismissRefresh(contentId, tenantId) {
  const { rows } = await db.query(
    `UPDATE seo_content_pieces
        SET refresh_dismissed_at = now(),
            refresh_reason = NULL, refresh_requested_at = NULL, refresh_signal = NULL,
            refresh_status = NULL, refresh_draft = NULL, refresh_error = NULL
      WHERE id = $1 AND tenant_id = $2 AND refresh_reason IS NOT NULL AND refresh_status IS DISTINCT FROM 'generating'
      RETURNING *`,
    [contentId, tenantId],
  );
  return rows[0] || null;
}

module.exports = { flagArticlesForTenant, requestRefresh, startDraftGeneration, applyRefresh, dismissRefresh };
