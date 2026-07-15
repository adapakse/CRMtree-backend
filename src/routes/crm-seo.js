'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-seo.js — SEObot editorial panel, generation trigger, and
// Search Console connection.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body, param, query } = require('express-validator');
const db = require('../config/database');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, requireFeature } = require('../middleware/crm-rbac');
const gscService = require('../services/gscService');
const seoContentService = require('../services/seoContentService');
const strategyService = require('../services/seoStrategyService');
const logger = require('../utils/logger');

router.use(requireAuth, injectAuditContext, crmAuth, requireFeature('seo_bot'));

// ── SEO editorial group check (mirrors the group_profiles/user_group_roles
// pattern already used elsewhere — no new permission system) ────────────────
async function requireSeoEditor(req, res, next) {
  try {
    if (req.user.is_admin) return next();
    const { rows } = await db.query(
      `SELECT 1 FROM user_group_roles ugr
         JOIN group_profiles gp ON gp.id = ugr.group_id
        WHERE ugr.user_id = $1 AND gp.tenant_id = $2 AND gp.name = 'SEO' AND ugr.access_level = 'full'`,
      [req.user.id, req.user.tenant_id],
    );
    if (!rows.length) return res.status(403).json({ error: 'Brak uprawnień redaktora SEO.' });
    next();
  } catch (err) { next(err); }
}

// ── GET /api/crm/seo/content — editorial queue (all viewers with feature access) ──
router.get('/content',
  [query('status').optional().isString()],
  validate,
  async (req, res, next) => {
    try {
      const params = [req.user.tenant_id];
      let where = 'tenant_id = $1';
      if (req.query.status) {
        params.push(req.query.status);
        where += ` AND status = $${params.length}`;
      }
      const { rows } = await db.query(
        `SELECT id, locale, title, slug, status, target_keyword, category,
                scheduled_at, published_at, reviewed_by, created_at, updated_at
           FROM seo_content_pieces WHERE ${where} ORDER BY created_at DESC`,
        params,
      );
      res.json(rows);
    } catch (err) { next(err); }
  },
);

// ── GET /api/crm/seo/content/:id ───────────────────────────────────────────
router.get('/content/:id',
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM seo_content_pieces WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenant_id],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// ── PATCH /api/crm/seo/content/:id — edit before approval (redaktor) ──────
router.patch('/content/:id',
  requireSeoEditor,
  [
    param('id').isInt(),
    body('title').optional().isString().trim().notEmpty(),
    body('body').optional().isString().trim().notEmpty(),
    body('meta_description').optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const fields = ['title', 'body', 'meta_description'].filter((f) => req.body[f] !== undefined);
      if (!fields.length) return res.status(400).json({ error: 'Brak pól do aktualizacji.' });
      const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const { rows } = await db.query(
        `UPDATE seo_content_pieces SET ${setClause}
          WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, req.user.tenant_id, ...fields.map((f) => req.body[f])],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// ── POST /api/crm/seo/content/:id/approve — mandatory human gate before publish ──
router.post('/content/:id/approve',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE seo_content_pieces
            SET status = 'published', published_at = now(), reviewed_by = $3
          WHERE id = $1 AND tenant_id = $2 AND status IN ('in_review', 'needs_update')
          RETURNING *`,
        [req.params.id, req.user.tenant_id, req.user.id],
      );
      if (!rows[0]) return res.status(409).json({ error: 'Wpis nie jest w stanie oczekującym na akceptację.' });
      logger.info('SEO content approved', { contentId: req.params.id, reviewedBy: req.user.id });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// ── POST /api/crm/seo/content/:id/reject — back to draft with a note ──────
router.post('/content/:id/reject',
  requireSeoEditor,
  [param('id').isInt(), body('note').optional().isString().trim()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE seo_content_pieces
            SET status = 'draft', reviewed_by = $3
          WHERE id = $1 AND tenant_id = $2 AND status IN ('in_review', 'needs_update')
          RETURNING *`,
        [req.params.id, req.user.tenant_id, req.user.id],
      );
      if (!rows[0]) return res.status(409).json({ error: 'Wpis nie jest w stanie oczekującym na akceptację.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// ── POST /api/crm/seo/content/generate — manually trigger one article ─────
// (autopilot/cron scheduling is a follow-up; this is the trigger used for
// testing and for on-demand generation in the meantime).
router.post('/content/generate',
  requireSeoEditor,
  async (req, res, next) => {
    try {
      const { rows: tenantRows } = await db.query(
        `SELECT seo_daily_article_limit FROM tenants WHERE id = $1`,
        [req.user.tenant_id],
      );
      const limit = tenantRows[0]?.seo_daily_article_limit ?? 0;
      const generatedToday = await seoContentService.countGeneratedToday(req.user.tenant_id);
      if (generatedToday >= limit) {
        return res.status(429).json({ error: `Osiągnięto dzienny limit artykułów (${limit}).` });
      }
      const content = await seoContentService.generateArticle(req.user.tenant_id);
      logger.info('SEO content generation triggered', { tenantId: req.user.tenant_id, contentId: content.id, triggeredBy: req.user.id });
      res.status(201).json(content);
    } catch (err) { next(err); }
  },
);

// ── GET /api/crm/seo/pillars — content strategy map (viewers, like /content) ──
router.get('/pillars', async (req, res, next) => {
  try {
    const pillars = await strategyService.getPillarsWithCoverage(req.user.tenant_id);
    res.json(pillars);
  } catch (err) { next(err); }
});

// ── Google Search Console connection ───────────────────────────────────────
router.get('/gsc/oauth/url', requireSeoEditor, (req, res) => {
  res.json({ url: gscService.getAuthUrl(req.user.tenant_id, req.user.id) });
});

router.get('/gsc/oauth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${config.frontendUrl}/crm/seo?gsc=error&reason=${encodeURIComponent(error)}`);
    const parsed = gscService.parseOAuthState(state);
    if (!code || !parsed) return res.redirect(`${config.frontendUrl}/crm/seo?gsc=error&reason=invalid_state`);

    const { rows } = await db.query('SELECT slug FROM tenants WHERE id = $1', [parsed.tenantId]);
    const siteUrl = `https://${rows[0]?.slug}.crmtree.pl/`; // placeholder until real onboarding captures the tenant's own domain
    await gscService.exchangeCodeAndSave(code, parsed.tenantId, parsed.userId, siteUrl);
    res.redirect(`${config.frontendUrl}/crm/seo?gsc=connected`);
  } catch (err) {
    logger.error('GSC OAuth callback failed', { error: err.message });
    res.redirect(`${config.frontendUrl}/crm/seo?gsc=error&reason=callback_failed`);
  }
});

router.get('/gsc/status', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT site_url, connected_at FROM tenant_gsc_tokens WHERE tenant_id = $1',
      [req.user.tenant_id],
    );
    res.json({ connected: !!rows.length, ...(rows[0] || {}) });
  } catch (err) { next(err); }
});

module.exports = router;
