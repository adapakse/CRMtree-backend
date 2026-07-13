'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/public-blog.js — unauthenticated, public blog content for SEO.
// Serves only the internal CRMtree tenant for now (Faza 0 dogfooding).
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { query, param } = require('express-validator');
const db = require('../config/database');
const { validate } = require('../middleware/errorHandler');

const CRMTREE_TENANT_ID = '00000000-0000-0000-0000-000000000001';

// ── GET /api/public/blog ──────────────────────────────────────────
router.get('/',
  [query('locale').optional().isIn(['pl', 'en'])],
  validate,
  async (req, res, next) => {
    try {
      const locale = req.query.locale || 'pl';
      const { rows } = await db.query(
        `SELECT id, title, slug, meta_description, category, header_image_url, published_at
           FROM seo_content_pieces
          WHERE tenant_id = $1 AND locale = $2 AND status = 'published'
          ORDER BY published_at DESC`,
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
        `SELECT id, title, slug, body, meta_description, category, header_image_url, published_at
           FROM seo_content_pieces
          WHERE tenant_id = $1 AND locale = $2 AND slug = $3 AND status = 'published'`,
        [CRMTREE_TENANT_ID, locale, req.params.slug],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono wpisu' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

module.exports = router;
