'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/public-tenants.js — unauthenticated tenant lookup by subdomain
// slug. Used by the login page to show the tenant's name when visited at
// {slug}.crmtree.pl. Never returns anything beyond name/slug/is_active —
// no features, no user counts, no provider config.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { param } = require('express-validator');
const db = require('../config/database');
const { validate } = require('../middleware/errorHandler');
const { isSlugAllowed } = require('../config/tenantHost');

// ── GET /api/public/tenants/by-slug/:slug ──────────────────────────
router.get('/by-slug/:slug',
  [param('slug').isString().trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const slug = req.params.slug.toLowerCase();

      // Reject reserved slugs the same way the middleware would — avoids a
      // DB round-trip for hosts that can never be a real tenant.
      if (!isSlugAllowed(slug)) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const { rows } = await db.query(
        `SELECT name, slug, is_active FROM tenants
          WHERE slug = $1 AND is_active = true AND deleted_at IS NULL`,
        [slug],
      );
      if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });

      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

module.exports = router;
