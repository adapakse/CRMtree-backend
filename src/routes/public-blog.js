'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/public-blog.js — unauthenticated, public blog content for SEO.
// Serves only the internal CRMtree tenant for now (Faza 0 dogfooding).
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { query, param } = require('express-validator');
const db = require('../config/database');
const { validate } = require('../middleware/errorHandler');

const CRMTREE_TENANT_ID = '4a299a1b-9e33-43d7-b649-ead5a17d61fc';

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
                a.full_name AS author_name, a.job_title AS author_job_title, a.photo_url AS author_photo_url
           FROM seo_content_pieces c
           LEFT JOIN seo_authors a ON a.id = c.author_id
          WHERE c.tenant_id = $1 AND c.locale = $2 AND c.status = 'published'
          ORDER BY c.published_at DESC`,
        [CRMTREE_TENANT_ID, locale],
      );
      res.json(rows);
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
        `SELECT c.id, c.title, c.slug, c.body, c.meta_description, c.category, c.header_image_url, c.published_at,
                GREATEST(1, CEIL(array_length(regexp_split_to_array(trim(c.body), '\\s+'), 1) / 200.0))::int AS reading_minutes,
                a.full_name AS author_name, a.job_title AS author_job_title, a.bio AS author_bio,
                a.photo_url AS author_photo_url, a.linkedin_url AS author_linkedin_url
           FROM seo_content_pieces c
           LEFT JOIN seo_authors a ON a.id = c.author_id
          WHERE c.tenant_id = $1 AND c.locale = $2 AND c.slug = $3 AND c.status = 'published'`,
        [CRMTREE_TENANT_ID, locale, req.params.slug],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono wpisu' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

module.exports = router;
