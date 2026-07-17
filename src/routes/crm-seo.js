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
const { runForTenant: syncGscMetrics } = require('../jobs/gsc-metrics-sync');
const seoContentService = require('../services/seoContentService');
const strategyService = require('../services/seoStrategyService');
const pexelsService = require('../services/pexelsService');
const backlinkService = require('../services/seoBacklinkService');
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
      let where = 'c.tenant_id = $1';
      if (req.query.status) {
        params.push(req.query.status);
        where += ` AND c.status = $${params.length}`;
      }
      const { rows } = await db.query(
        `SELECT c.id, c.locale, c.title, c.slug, c.status, c.target_keyword, c.category,
                c.scheduled_at, c.published_at, c.reviewed_by, c.created_at, c.updated_at,
                COALESCE(m.clicks_28d, 0) AS clicks_28d,
                COALESCE(m.impressions_28d, 0) AS impressions_28d,
                m.avg_position_28d
           FROM seo_content_pieces c
           LEFT JOIN LATERAL (
             SELECT SUM(clicks)::int AS clicks_28d,
                    SUM(impressions)::int AS impressions_28d,
                    ROUND(AVG(avg_position)::numeric, 1) AS avg_position_28d
               FROM seo_metrics
              WHERE content_id = c.id AND date >= CURRENT_DATE - INTERVAL '28 days'
           ) m ON true
          WHERE ${where} ORDER BY c.created_at DESC`,
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
        `SELECT c.*,
                COALESCE(m.clicks_28d, 0) AS clicks_28d,
                COALESCE(m.impressions_28d, 0) AS impressions_28d,
                m.avg_position_28d
           FROM seo_content_pieces c
           LEFT JOIN LATERAL (
             SELECT SUM(clicks)::int AS clicks_28d,
                    SUM(impressions)::int AS impressions_28d,
                    ROUND(AVG(avg_position)::numeric, 1) AS avg_position_28d
               FROM seo_metrics
              WHERE content_id = c.id AND date >= CURRENT_DATE - INTERVAL '28 days'
           ) m ON true
          WHERE c.id = $1 AND c.tenant_id = $2`,
        [req.params.id, req.user.tenant_id],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// ── GET /api/crm/seo/content/:id/internal-links — outgoing links (audit trail) ──
router.get('/content/:id/internal-links',
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT l.id, l.status, t.id AS to_content_id, t.title AS to_title, t.slug AS to_slug
           FROM seo_internal_links l
           JOIN seo_content_pieces t ON t.id = l.to_content_id
          WHERE l.from_content_id = $1 AND l.tenant_id = $2
          ORDER BY l.created_at`,
        [req.params.id, req.user.tenant_id],
      );
      res.json(rows);
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
    body('header_image_url').optional({ nullable: true }).isString().trim(),
    body('scheduled_at').optional({ nullable: true }).isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const fields = ['title', 'body', 'meta_description', 'header_image_url', 'scheduled_at'].filter((f) => req.body[f] !== undefined);
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

// ── POST /api/crm/seo/content/:id/reroll-image — pick a different Pexels photo ──
router.post('/content/:id/reroll-image',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT target_keyword, category, header_image_url FROM seo_content_pieces WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenant_id],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      const query = rows[0].category || rows[0].target_keyword || 'business';
      const newUrl = await pexelsService.searchHeaderImage(query, rows[0].header_image_url);
      if (!newUrl) return res.status(502).json({ error: 'Nie udało się znaleźć zdjęcia w Pexels.' });
      const { rows: updated } = await db.query(
        `UPDATE seo_content_pieces SET header_image_url = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`,
        [newUrl, req.params.id, req.user.tenant_id],
      );
      res.json(updated[0]);
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
      // Approving with a future scheduled_at queues it instead of publishing immediately —
      // the scheduler job (jobs/seo-scheduler.js) flips it to published when the time comes.
      const { rows } = await db.query(
        `UPDATE seo_content_pieces
            SET status = CASE WHEN scheduled_at IS NOT NULL AND scheduled_at > now() THEN 'scheduled' ELSE 'published' END,
                published_at = CASE WHEN scheduled_at IS NOT NULL AND scheduled_at > now() THEN NULL ELSE now() END,
                reviewed_by = $3
          WHERE id = $1 AND tenant_id = $2 AND status IN ('draft', 'in_review', 'needs_update')
          RETURNING *`,
        [req.params.id, req.user.tenant_id, req.user.id],
      );
      if (!rows[0]) return res.status(409).json({ error: 'Wpis nie jest w stanie oczekującym na akceptację.' });
      logger.info('SEO content approved', { contentId: req.params.id, reviewedBy: req.user.id, resultStatus: rows[0].status });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// ── POST /api/crm/seo/content/:id/unpublish — pull a published/scheduled article back to draft ──
router.post('/content/:id/unpublish',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE seo_content_pieces
            SET status = 'draft', published_at = NULL, scheduled_at = NULL, reviewed_by = $3
          WHERE id = $1 AND tenant_id = $2 AND status IN ('published', 'scheduled')
          RETURNING *`,
        [req.params.id, req.user.tenant_id, req.user.id],
      );
      if (!rows[0]) return res.status(409).json({ error: 'Wpis nie jest opublikowany ani zaplanowany.' });
      logger.info('SEO content unpublished', { contentId: req.params.id, unpublishedBy: req.user.id });
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

// ── Competitor research — editors maintain the list, seoStrategyService reads
// it when (re)generating the content pillar map ───────────────────────────
router.get('/competitors', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, url, notes, created_at FROM seo_competitors WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.user.tenant_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/competitors',
  requireSeoEditor,
  [body('url').isString().trim().notEmpty(), body('notes').optional({ nullable: true }).isString().trim()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `INSERT INTO seo_competitors (tenant_id, url, notes) VALUES ($1, $2, $3) RETURNING id, url, notes, created_at`,
        [req.user.tenant_id, req.body.url, req.body.notes || null],
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  },
);

router.delete('/competitors/:id',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rowCount } = await db.query(
        `DELETE FROM seo_competitors WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenant_id],
      );
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.status(204).end();
    } catch (err) { next(err); }
  },
);

// ── Cross-tenant backlinks — opt-in, industry_vertical-gated, capped ──────
router.get('/backlinks/opt-in', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT seo_backlinks_opt_in AS opt_in FROM tenants WHERE id = $1`, [req.user.tenant_id]);
    res.json({ opt_in: rows[0]?.opt_in ?? false });
  } catch (err) { next(err); }
});

router.get('/backlinks', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT b.id, b.status, b.tenant_id, b.partner_tenant_id, b.created_at,
              fc.title AS from_title, fc.slug AS from_slug,
              tc.title AS to_title, tc.slug AS to_slug
         FROM seo_backlinks b
         JOIN seo_content_pieces fc ON fc.id = b.from_content_id
         JOIN seo_content_pieces tc ON tc.id = b.to_content_id
        WHERE b.tenant_id = $1
        ORDER BY b.created_at DESC`,
      [req.user.tenant_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/backlinks/opt-in',
  requireSeoEditor,
  [body('opt_in').isBoolean()],
  validate,
  async (req, res, next) => {
    try {
      await db.query(`UPDATE tenants SET seo_backlinks_opt_in = $1 WHERE id = $2`, [req.body.opt_in, req.user.tenant_id]);
      res.json({ opt_in: req.body.opt_in });
    } catch (err) { next(err); }
  },
);

router.post('/backlinks/find-candidates', requireSeoEditor, async (req, res, next) => {
  try {
    const suggestions = await backlinkService.findCandidates(req.user.tenant_id);
    res.json(suggestions);
  } catch (err) {
    if (err.message.includes('seo_backlinks_opt_in') || err.message.includes('industry_vertical')) {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

router.post('/backlinks/:id/accept',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE seo_backlinks SET status = 'accepted' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, req.user.tenant_id],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

router.post('/backlinks/:id/reject',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE seo_backlinks SET status = 'rejected' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, req.user.tenant_id],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

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

// ── POST /api/crm/seo/gsc/sync — manual metrics sync (the daily job runs at 07:00) ──
router.post('/gsc/sync', requireSeoEditor, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT site_url FROM tenant_gsc_tokens WHERE tenant_id = $1',
      [req.user.tenant_id],
    );
    if (!rows.length) return res.status(409).json({ error: 'Search Console nie jest podłączony.' });
    await syncGscMetrics(req.user.tenant_id, rows[0].site_url);
    res.json({ synced: true });
  } catch (err) { next(err); }
});

module.exports = router;
