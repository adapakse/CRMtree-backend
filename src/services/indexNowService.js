'use strict';
// services/indexNowService.js — tells IndexNow search engines (Bing, Yandex,
// Seznam, Naver…) that a crmtree.pl blog article was published, refreshed or
// unpublished, so they recrawl it now instead of whenever they get round to
// a new, low-authority domain. Google does not take part in IndexNow; Bing
// does, and Bing feeds ChatGPT search and Copilot, which is what makes this
// worth doing for AI-search visibility (Adam, 2026-09-26).
//
// Only the tenant whose articles live on crmtree.pl is pinged — client
// tenants publish to their own WordPress sites, not our domain.

const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const { CRMTREE_BLOG_TENANT_ID, CRMTREE_BLOG_SITE_URL } = require('../utils/crmtreeBlog');

const ENDPOINT = 'https://api.indexnow.org/indexnow';

/** Fire-and-forget: never throws, so callers don't need to await or catch. */
async function notifyArticleChanged(contentId, tenantId) {
  const { key } = config.indexNow;
  if (!key || tenantId !== CRMTREE_BLOG_TENANT_ID) return;

  try {
    const { rows } = await db.query(
      `SELECT c.slug, p.slug AS pillar_slug
         FROM seo_content_pieces c
         LEFT JOIN seo_keywords k ON k.content_id = c.id
         LEFT JOIN seo_content_pillars p ON p.id = k.pillar_id
        WHERE c.id = $1`,
      [contentId],
    );
    if (!rows[0]) return;

    // The blog index and the pillar hub list this article too, so they
    // change whenever it's published or pulled.
    const urlList = [
      `${CRMTREE_BLOG_SITE_URL}/blog/${rows[0].slug}`,
      `${CRMTREE_BLOG_SITE_URL}/blog`,
      ...(rows[0].pillar_slug ? [`${CRMTREE_BLOG_SITE_URL}/blog/temat/${rows[0].pillar_slug}`] : []),
    ];

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: new URL(CRMTREE_BLOG_SITE_URL).host,
        key,
        keyLocation: `${CRMTREE_BLOG_SITE_URL}/${key}.txt`,
        urlList,
      }),
    });

    if (res.ok) {
      logger.info('[indexnow] Submitted', { contentId, status: res.status, urls: urlList.length });
    } else {
      logger.warn('[indexnow] Rejected', { contentId, status: res.status, body: await res.text() });
    }
  } catch (err) {
    logger.warn('[indexnow] Failed', { contentId, error: err.message });
  }
}

module.exports = { notifyArticleChanged };
