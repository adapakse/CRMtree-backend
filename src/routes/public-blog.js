'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/public-blog.js — unauthenticated, public blog content for SEO.
// Serves only the internal CRMtree tenant for now (Faza 0 dogfooding).
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { query, param } = require('express-validator');
const db = require('../config/database');
const { validate } = require('../middleware/errorHandler');
const strategyService = require('../services/seoStrategyService');
// crmtree.pl/blog is single-tenant by design (see file header).
const { CRMTREE_BLOG_TENANT_ID: CRMTREE_TENANT_ID } = require('../utils/crmtreeBlog');

// author.photo_url may be a real external URL (pasted before upload existed)
// or an Azure blob path (uploaded via crm-seo.js /authors/:id/photo) — either
// way the public blog frontend needs one clickable URL, so route blob paths
// through the streaming endpoint and pass real URLs through unchanged.
function resolveAuthorPhotoUrl(row) {
  if (!row.author_photo_url) return null;
  if (/^https?:\/\//i.test(row.author_photo_url)) return row.author_photo_url;
  return `/api/crm/seo/authors/${row.author_id}/photo-img`;
}

// ── GET /api/public/blog ──────────────────────────────────────────
router.get('/',
  [query('locale').optional().isIn(['pl', 'en'])],
  validate,
  async (req, res, next) => {
    try {
      const locale = req.query.locale || 'pl';
      const { rows } = await db.query(
        `SELECT c.id, c.title, c.slug, c.meta_description, c.category, c.header_image_url, c.published_at,
                GREATEST(1, CEIL(array_length(regexp_split_to_array(trim(c.body), '\\s+'), 1) / 200.0))::int AS reading_minutes,
                a.id AS author_id, a.full_name AS author_name, a.job_title AS author_job_title, a.photo_url AS author_photo_url,
                p.slug AS pillar_slug
           FROM seo_content_pieces c
           LEFT JOIN seo_authors a ON a.id = c.author_id
           LEFT JOIN seo_keywords k ON k.content_id = c.id
           LEFT JOIN seo_content_pillars p ON p.id = k.pillar_id
          WHERE c.tenant_id = $1 AND c.locale = $2 AND c.status = 'published'
          ORDER BY c.published_at DESC`,
        [CRMTREE_TENANT_ID, locale],
      );
      res.json(rows.map((r) => ({ ...r, author_photo_url: resolveAuthorPhotoUrl(r) })));
    } catch (err) { next(err); }
  },
);

// ── GET /api/public/blog/pillars — "browse by topic" index ────────
router.get('/pillars',
  [query('locale').optional().isIn(['pl', 'en'])],
  validate,
  async (req, res, next) => {
    try {
      const locale = req.query.locale || 'pl';
      const pillars = await strategyService.getPublishedPillars(CRMTREE_TENANT_ID, locale);
      res.json(pillars);
    } catch (err) { next(err); }
  },
);

// ── GET /api/public/blog/pillar/:slug — pillar hub page ───────────
router.get('/pillar/:slug',
  [param('slug').isString().trim().notEmpty(), query('locale').optional().isIn(['pl', 'en'])],
  validate,
  async (req, res, next) => {
    try {
      const locale = req.query.locale || 'pl';
      const pillar = await strategyService.getPillarBySlug(CRMTREE_TENANT_ID, req.params.slug);
      if (!pillar) return res.status(404).json({ error: 'Nie znaleziono tematu' });
      const articles = await strategyService.getPublishedArticlesForPillar(CRMTREE_TENANT_ID, pillar.id, locale);
      res.json({ ...pillar, articles });
    } catch (err) { next(err); }
  },
);

// ── GET /api/public/blog/:slug ────────────────────────────────────
router.get('/:slug',
  [param('slug').isString().trim().notEmpty(), query('locale').optional().isIn(['pl', 'en'])],
  validate,
  async (req, res, next) => {
    try {
      const locale = req.query.locale || 'pl';
      const { rows } = await db.query(
        `SELECT c.id, c.title, c.slug, c.body, c.meta_description, c.category, c.header_image_url,
                -- Public "modified" date = when content last changed via an
                -- applied refresh. updated_at also moves on internal flag
                -- changes (e.g. being queued for a refresh), so it would claim
                -- edits that never reached readers.
                c.published_at, c.last_refreshed_at AS updated_at, c.faq,
                GREATEST(1, CEIL(array_length(regexp_split_to_array(trim(c.body), '\\s+'), 1) / 200.0))::int AS reading_minutes,
                a.id AS author_id, a.full_name AS author_name, a.job_title AS author_job_title, a.bio AS author_bio,
                a.photo_url AS author_photo_url, a.linkedin_url AS author_linkedin_url,
                p.slug AS pillar_slug
           FROM seo_content_pieces c
           LEFT JOIN seo_authors a ON a.id = c.author_id
           LEFT JOIN seo_keywords k ON k.content_id = c.id
           LEFT JOIN seo_content_pillars p ON p.id = k.pillar_id
          WHERE c.tenant_id = $1 AND c.locale = $2 AND c.slug = $3 AND c.status = 'published'`,
        [CRMTREE_TENANT_ID, locale, req.params.slug],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono wpisu' });
      res.json({ ...rows[0], author_photo_url: resolveAuthorPhotoUrl(rows[0]) });
    } catch (err) { next(err); }
  },
);

module.exports = router;
