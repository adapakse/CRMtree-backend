'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-seo.js — SEObot editorial panel, generation trigger, and
// Search Console connection.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const multer = require('multer');
const { body, param, query } = require('express-validator');
const db = require('../config/database');
const config = require('../config');
const storageService = require('../services/storageService');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, requireFeature } = require('../middleware/crm-rbac');
const gscService = require('../services/gscService');
const { runForTenant: syncGscMetrics } = require('../jobs/gsc-metrics-sync');
const seoContentService = require('../services/seoContentService');
const strategyService = require('../services/seoStrategyService');
const pexelsService = require('../services/pexelsService');
const backlinkService = require('../services/seoBacklinkService');
const socialService = require('../services/seoSocialService');
const linkedinService = require('../services/socialPublish/linkedinService');
const metaService = require('../services/socialPublish/metaService');
const wordpressService = require('../services/socialPublish/wordpressService');
const authorRotation = require('../services/seoAuthorRotationService');
const { mondayOf, addDays, toDateStr } = require('../utils/isoWeek');
const logger = require('../utils/logger');

// ── OAuth callbacks — registered BEFORE the auth gate below on purpose.
// These are hit by a plain browser redirect from Google/LinkedIn/Meta, which
// never carries our Authorization header — requireAuth would 401 every one
// of them before the handler ever ran. Identity instead comes from the
// signed `state` param each service's parseOAuthState() verifies. ──────────
router.get('/gsc/oauth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${config.frontendUrl}/crm/seo?gsc=error&reason=${encodeURIComponent(error)}`);
    const parsed = gscService.parseOAuthState(state);
    if (!code || !parsed) return res.redirect(`${config.frontendUrl}/crm/seo?gsc=error&reason=invalid_state`);

    // Prefer the tenant's real domain (via a connected WordPress site) over the
    // crmtree.pl placeholder — GSC properties must match the actual live domain
    // the client's articles get published to, not our internal subdomain.
    const { rows } = await db.query(
      `SELECT t.slug, w.site_url AS wordpress_site_url
         FROM tenants t
         LEFT JOIN tenant_wordpress_connections w ON w.tenant_id = t.id
        WHERE t.id = $1`,
      [parsed.tenantId],
    );
    const siteUrl = rows[0]?.wordpress_site_url || `https://${rows[0]?.slug}.crmtree.pl/`;
    await gscService.exchangeCodeAndSave(code, parsed.tenantId, parsed.userId, siteUrl);
    res.redirect(`${config.frontendUrl}/crm/seo?gsc=connected`);
  } catch (err) {
    logger.error('GSC OAuth callback failed', { error: err.message });
    res.redirect(`${config.frontendUrl}/crm/seo?gsc=error&reason=callback_failed`);
  }
});

router.get('/social/linkedin/oauth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${config.frontendUrl}/crm/seo?social=error&platform=linkedin&reason=${encodeURIComponent(error)}`);
    const parsed = linkedinService.parseOAuthState(state);
    if (!code || !parsed) return res.redirect(`${config.frontendUrl}/crm/seo?social=error&platform=linkedin&reason=invalid_state`);
    await linkedinService.exchangeCodeAndSave(code, parsed.tenantId, parsed.userId);
    res.redirect(`${config.frontendUrl}/crm/seo?social=connected&platform=linkedin`);
  } catch (err) {
    logger.error('LinkedIn OAuth callback failed', { error: err.message });
    res.redirect(`${config.frontendUrl}/crm/seo?social=error&platform=linkedin&reason=callback_failed`);
  }
});

router.get('/social/facebook/oauth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${config.frontendUrl}/crm/seo?social=error&platform=facebook&reason=${encodeURIComponent(error)}`);
    const parsed = metaService.parseOAuthState(state);
    if (!code || !parsed) return res.redirect(`${config.frontendUrl}/crm/seo?social=error&platform=facebook&reason=invalid_state`);
    await metaService.exchangeCodeAndSave(code, parsed.tenantId, parsed.userId);
    res.redirect(`${config.frontendUrl}/crm/seo?social=connected&platform=facebook`);
  } catch (err) {
    logger.error('Meta OAuth callback failed', { error: err.message });
    res.redirect(`${config.frontendUrl}/crm/seo?social=error&platform=facebook&reason=callback_failed`);
  }
});

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  },
});

// ── GET /authors/:id/photo-img — public, no auth. Author photos are shown
// on published blog articles (public-blog.js), which have no CRM session —
// registered before the auth gate below, same reasoning as the OAuth
// callbacks above. seo_authors.id is a global serial, so no tenant scoping
// is needed to look it up (mirrors how public-blog.js itself works). ──────
router.get('/authors/:id/photo-img',
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query('SELECT photo_url FROM seo_authors WHERE id = $1', [req.params.id]);
      if (!rows.length || !rows[0].photo_url) return res.status(404).end();
      // Back-compat: authors created before upload existed may still have a real
      // external URL saved (manually pasted) — redirect those instead of trying
      // to treat them as an Azure blob path.
      if (/^https?:\/\//i.test(rows[0].photo_url)) return res.redirect(rows[0].photo_url);
      const { buffer, contentType } = await storageService.downloadDocument(rows[0].photo_url);
      res.setHeader('Content-Type', contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    } catch (err) { next(err); }
  },
);

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
        `SELECT c.id, c.locale, c.title, c.slug, c.status, c.target_keyword, c.category, c.author_id,
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
    body('social_post_linkedin').optional({ nullable: true }).isString().trim(),
    body('author_id').optional({ nullable: true }).isInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const fields = ['title', 'body', 'meta_description', 'header_image_url', 'scheduled_at', 'social_post_linkedin', 'author_id'].filter((f) => req.body[f] !== undefined);
      if (!fields.length) return res.status(400).json({ error: 'Brak pól do aktualizacji.' });
      if (req.body.author_id) {
        const { rows: authorRows } = await db.query(
          `SELECT 1 FROM seo_authors WHERE id = $1 AND tenant_id = $2`,
          [req.body.author_id, req.user.tenant_id],
        );
        if (!authorRows.length) return res.status(400).json({ error: 'Nieznany autor.' });
      }
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

// ── GET /api/crm/seo/content/:id/social-posts — per-platform publish status ──
router.get('/content/:id/social-posts',
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT platform, status, body, remote_url, error_message, published_at
           FROM seo_social_posts WHERE content_id = $1 AND tenant_id = $2 ORDER BY platform`,
        [req.params.id, req.user.tenant_id],
      );
      res.json(rows);
    } catch (err) { next(err); }
  },
);

// ── PATCH /api/crm/seo/content/:id/social-posts/:platform — hand-edit copy ──
router.patch('/content/:id/social-posts/:platform',
  requireSeoEditor,
  [param('id').isInt(), param('platform').isIn(['linkedin', 'facebook', 'instagram']), body('body').isString().trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE seo_social_posts SET body = $1
          WHERE content_id = $2 AND tenant_id = $3 AND platform = $4 RETURNING *`,
        [req.body.body, req.params.id, req.user.tenant_id, req.params.platform],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// ── POST /api/crm/seo/content/:id/social-posts/:platform/retry — (re)publish one platform ──
router.post('/content/:id/social-posts/:platform/retry',
  requireSeoEditor,
  [param('id').isInt(), param('platform').isIn(['linkedin', 'facebook', 'instagram'])],
  validate,
  async (req, res, next) => {
    try {
      await socialService.retryPlatform(req.params.id, req.user.tenant_id, req.params.platform, config.frontendUrl);
      const { rows } = await db.query(
        `SELECT platform, status, body, remote_url, error_message, published_at FROM seo_social_posts WHERE content_id = $1 AND tenant_id = $2 AND platform = $3`,
        [req.params.id, req.user.tenant_id, req.params.platform],
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
      // Author is mandatory before publish (E-E-A-T requirement) — checked here rather
      // than a NOT NULL column, so drafts can still be written/edited without one.
      const { rows: existing } = await db.query(
        `SELECT status, author_id FROM seo_content_pieces WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenant_id],
      );
      if (!existing[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      if (!existing[0].author_id) return res.status(409).json({ error: 'Wpis musi mieć przypisanego autora przed zatwierdzeniem.' });

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
      // One-click publish: approving also fires social publishing to every connected
      // platform. Fire-and-forget — a slow/failed platform never blocks the response,
      // per-platform outcome lands in seo_social_posts (retry button in the panel).
      if (rows[0].status === 'published') socialService.publishToConnectedPlatforms(rows[0].id, req.user.tenant_id, config.frontendUrl);
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

// ── Manual pillar CRUD — on top of the auto-generated map, an editor can add
// their own pillar the generator didn't think of, or tweak/remove one.
// Single-row operations only — never touches the rest of the map. ─────────
router.post('/pillars',
  requireSeoEditor,
  [
    body('name').isString().trim().notEmpty(),
    body('description').isString().trim().notEmpty(),
    body('target_keyword_theme').isString().trim().notEmpty(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `INSERT INTO seo_content_pillars (tenant_id, name, description, target_keyword_theme, priority)
         VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(priority), -1) + 1 FROM seo_content_pillars WHERE tenant_id = $1))
         RETURNING id, name, description, target_keyword_theme, priority`,
        [req.user.tenant_id, req.body.name, req.body.description, req.body.target_keyword_theme],
      );
      res.status(201).json({ ...rows[0], article_count: 0 });
    } catch (err) { next(err); }
  },
);

router.patch('/pillars/:id',
  requireSeoEditor,
  [
    param('id').isInt(),
    body('name').optional().isString().trim().notEmpty(),
    body('description').optional().isString().trim().notEmpty(),
    body('target_keyword_theme').optional().isString().trim().notEmpty(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const fields = ['name', 'description', 'target_keyword_theme'].filter((f) => req.body[f] !== undefined);
      if (!fields.length) return res.status(400).json({ error: 'Brak pól do aktualizacji.' });
      const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const { rows } = await db.query(
        `UPDATE seo_content_pillars SET ${setClause}
          WHERE id = $1 AND tenant_id = $2 RETURNING id, name, description, target_keyword_theme, priority`,
        [req.params.id, req.user.tenant_id, ...fields.map((f) => req.body[f])],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

router.delete('/pillars/:id',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rowCount } = await db.query(
        `DELETE FROM seo_content_pillars WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenant_id],
      );
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.status(204).end();
    } catch (err) { next(err); }
  },
);

// ── Author profiles (E-E-A-T) — per-tenant roster of employees/external
// experts an editor can attach to an article. Reusable entities, so plain
// CRUD rather than free-text fields on the article. ────────────────────────
router.get('/authors', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, job_title, bio, photo_url, linkedin_url, is_active
         FROM seo_authors WHERE tenant_id = $1 ORDER BY is_active DESC, full_name`,
      [req.user.tenant_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/authors',
  requireSeoEditor,
  photoUpload.single('file'),
  [
    body('full_name').isString().trim().notEmpty(),
    body('job_title').optional({ nullable: true }).isString().trim(),
    body('bio').optional({ nullable: true }).isString().trim(),
    body('photo_url').optional({ nullable: true }).isString().trim(),
    body('linkedin_url').optional({ nullable: true }).isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `INSERT INTO seo_authors (tenant_id, full_name, job_title, bio, photo_url, linkedin_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, full_name, job_title, bio, photo_url, linkedin_url, is_active`,
        [req.user.tenant_id, req.body.full_name, req.body.job_title || null, req.body.bio || null,
         req.body.photo_url || null, req.body.linkedin_url || null],
      );
      let author = rows[0];

      // Zdjęcie wgrane od razu przy tworzeniu — blob potrzebuje id autora, więc
      // leci po insercie. Nieudany upload nie przerywa tworzenia: autor zostaje,
      // zdjęcie można dodać w edycji.
      if (req.file) {
        try {
          const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[req.file.mimetype] || 'jpg';
          const blobPath = `seo-authors/${author.id}-${Date.now()}.${ext}`;
          await storageService.uploadBuffer(blobPath, req.file.buffer, req.file.mimetype);
          const { rows: updated } = await db.query(
            `UPDATE seo_authors SET photo_url = $3
              WHERE id = $1 AND tenant_id = $2
              RETURNING id, full_name, job_title, bio, photo_url, linkedin_url, is_active`,
            [author.id, req.user.tenant_id, blobPath],
          );
          if (updated[0]) author = updated[0];
        } catch (photoErr) {
          logger.warn('SEO author created, photo upload failed', { authorId: author.id, error: photoErr.message });
        }
      }

      res.status(201).json(author);
    } catch (err) { next(err); }
  },
);

router.patch('/authors/:id',
  requireSeoEditor,
  [
    param('id').isInt(),
    body('full_name').optional().isString().trim().notEmpty(),
    body('job_title').optional({ nullable: true }).isString().trim(),
    body('bio').optional({ nullable: true }).isString().trim(),
    body('photo_url').optional({ nullable: true }).isString().trim(),
    body('linkedin_url').optional({ nullable: true }).isString().trim(),
    body('is_active').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const fields = ['full_name', 'job_title', 'bio', 'photo_url', 'linkedin_url', 'is_active'].filter((f) => req.body[f] !== undefined);
      if (!fields.length) return res.status(400).json({ error: 'Brak pól do aktualizacji.' });
      const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const { rows } = await db.query(
        `UPDATE seo_authors SET ${setClause}
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, full_name, job_title, bio, photo_url, linkedin_url, is_active`,
        [req.params.id, req.user.tenant_id, ...fields.map((f) => req.body[f])],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

router.post('/authors/:id/photo',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  photoUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Brak pliku (dozwolone: JPEG, PNG, WebP, max 5 MB).' });
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[req.file.mimetype] || 'jpg';
      const blobPath = `seo-authors/${req.params.id}-${Date.now()}.${ext}`;
      await storageService.uploadBuffer(blobPath, req.file.buffer, req.file.mimetype);
      const { rows } = await db.query(
        `UPDATE seo_authors SET photo_url = $3
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, full_name, job_title, bio, photo_url, linkedin_url, is_active`,
        [req.params.id, req.user.tenant_id, blobPath],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// Deleting outright would silently strip the author from already-published
// articles (FK is ON DELETE SET NULL) and break the E-E-A-T guarantee the
// approve gate enforces — block it while any article still references this
// author; deactivate instead (hides from the picker, keeps history intact).
router.delete('/authors/:id',
  requireSeoEditor,
  [param('id').isInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: inUse } = await db.query(
        `SELECT 1 FROM seo_content_pieces WHERE author_id = $1 AND tenant_id = $2 LIMIT 1`,
        [req.params.id, req.user.tenant_id],
      );
      if (inUse.length) {
        return res.status(409).json({ error: 'Autor ma przypisane artykuły — dezaktywuj go zamiast usuwać.' });
      }
      const { rowCount } = await db.query(
        `DELETE FROM seo_authors WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenant_id],
      );
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      res.status(204).end();
    } catch (err) { next(err); }
  },
);

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

// ── Social channel connections (LinkedIn Company Page, Facebook Page + linked Instagram) ──
router.get('/social/accounts', async (req, res, next) => {
  try {
    const { rows: oauthAccounts } = await db.query(
      `SELECT platform, account_name, connected_at FROM tenant_social_accounts WHERE tenant_id = $1`,
      [req.user.tenant_id],
    );
    const { rows: wpAccounts } = await db.query(
      `SELECT site_url, connected_at FROM tenant_wordpress_connections WHERE tenant_id = $1`,
      [req.user.tenant_id],
    );
    const wp = wpAccounts[0] ? [{ platform: 'wordpress', account_name: wpAccounts[0].site_url, connected_at: wpAccounts[0].connected_at }] : [];
    res.json([...oauthAccounts, ...wp]);
  } catch (err) { next(err); }
});

router.delete('/social/accounts/:platform',
  requireSeoEditor,
  [param('platform').isIn(['linkedin', 'facebook', 'instagram', 'wordpress'])],
  validate,
  async (req, res, next) => {
    try {
      if (req.params.platform === 'wordpress') {
        await db.query(`DELETE FROM tenant_wordpress_connections WHERE tenant_id = $1`, [req.user.tenant_id]);
      } else {
        await db.query(`DELETE FROM tenant_social_accounts WHERE tenant_id = $1 AND platform = $2`, [req.user.tenant_id, req.params.platform]);
      }
      res.status(204).end();
    } catch (err) { next(err); }
  },
);

router.get('/social/linkedin/oauth/url', requireSeoEditor, (req, res) => {
  res.json({ url: linkedinService.getAuthUrl(req.user.tenant_id, req.user.id) });
});

router.get('/social/facebook/oauth/url', requireSeoEditor, (req, res) => {
  res.json({ url: metaService.getAuthUrl(req.user.tenant_id, req.user.id) });
});

// ── WordPress connector — client tenants only; CRMtree keeps its own native
// blog. No OAuth: the client generates an Application Password in their own
// WP admin (Users → Profile) and gives us the username + password directly. ──
router.post('/social/wordpress/connect',
  requireSeoEditor,
  [
    body('site_url').isString().trim().notEmpty(),
    body('username').isString().trim().notEmpty(),
    body('app_password').isString().trim().notEmpty(),
  ],
  validate,
  async (req, res, next) => {
    try {
      await wordpressService.connect(req.user.tenant_id, req.body.site_url, req.body.username, req.body.app_password, req.user.id);
      res.status(201).json({ connected: true });
    } catch (err) {
      if (err.message.includes('zweryfikować')) return res.status(400).json({ error: err.message });
      next(err);
    }
  },
);

// ── Tenant SEO settings — business_description/industry_vertical feed the
// content-pillar generator (seoStrategyService). Any SEO editor can tune
// these, same permission as the rest of this module. ─────────────────────
router.get('/tenant-settings', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.business_description, t.industry_vertical,
              w.site_url AS wordpress_site_url
         FROM tenants t
         LEFT JOIN tenant_wordpress_connections w ON w.tenant_id = t.id
        WHERE t.id = $1`,
      [req.user.tenant_id],
    );
    res.json(rows[0] || {});
  } catch (err) { next(err); }
});

router.patch('/tenant-settings',
  requireSeoEditor,
  [
    body('business_description').optional({ nullable: true }).isString().trim(),
    body('industry_vertical').optional({ nullable: true }).isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const fields = ['business_description', 'industry_vertical'].filter((f) => req.body[f] !== undefined);
      if (!fields.length) return res.status(400).json({ error: 'Brak pól do aktualizacji.' });
      const values = fields.map((f) => req.body[f]);
      const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const { rows } = await db.query(
        `UPDATE tenants SET ${setClause} WHERE id = $1 RETURNING business_description, industry_vertical`,
        [req.user.tenant_id, ...values],
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// ── WordPress publish mode — SuperAdmin-only trust decision made after
// talking to the client (live "publish" vs safe "draft"), not an SEO
// editor's call. Defaults to 'draft'. ─────────────────────────────────────
router.get('/tenant-settings/wordpress-publish-mode', requireSuperAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT wordpress_publish_mode FROM tenants WHERE id = $1`, [req.user.tenant_id]);
    res.json({ wordpress_publish_mode: rows[0]?.wordpress_publish_mode ?? 'draft' });
  } catch (err) { next(err); }
});

router.patch('/tenant-settings/wordpress-publish-mode',
  requireSuperAdmin,
  [body('wordpress_publish_mode').isIn(['draft', 'publish'])],
  validate,
  async (req, res, next) => {
    try {
      await db.query(`UPDATE tenants SET wordpress_publish_mode = $1 WHERE id = $2`, [req.body.wordpress_publish_mode, req.user.tenant_id]);
      res.json({ wordpress_publish_mode: req.body.wordpress_publish_mode });
    } catch (err) { next(err); }
  },
);

// ── SEObot publishing calendar — per-tenant weekday auto-schedule pattern,
// weekly drag&drop assignment, and the unassigned-article queue. Enabling
// is_enabled is a tenant's explicit opt-in to auto-publish with NO manual
// editorial review (confirmed with Adam 2026-08-22): the calendar scheduler
// job (jobs/seo-calendar-scheduler.js) assigns a round-robin author and a
// target date, then sets status straight to 'scheduled' — the existing
// jobs/seo-scheduler.js publishes it exactly like a human-approved article.
// This block never touches the existing manual generate→approve flow. ─────
const CALENDAR_DAY_FIELDS = ['monday_count', 'tuesday_count', 'wednesday_count', 'thursday_count', 'friday_count', 'saturday_count', 'sunday_count'];

router.get('/calendar/config', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM tenant_seo_calendar_config WHERE tenant_id = $1`, [req.user.tenant_id]);
    res.json(rows[0] || {
      is_enabled: false, monday_count: 0, tuesday_count: 0, wednesday_count: 0,
      thursday_count: 0, friday_count: 0, saturday_count: 0, sunday_count: 0, end_date: null,
    });
  } catch (err) { next(err); }
});

router.patch('/calendar/config',
  requireSeoEditor,
  [
    body('is_enabled').optional().isBoolean(),
    ...CALENDAR_DAY_FIELDS.map((f) => body(f).optional().isInt({ min: 0 })),
    body('end_date').optional({ nullable: true }).isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const fields = [...CALENDAR_DAY_FIELDS, 'is_enabled', 'end_date'].filter((f) => req.body[f] !== undefined);
      if (!fields.length) return res.status(400).json({ error: 'Brak pól do aktualizacji.' });
      const values = fields.map((f) => req.body[f]);
      const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const { rows } = await db.query(
        `INSERT INTO tenant_seo_calendar_config (tenant_id, ${fields.join(', ')})
         VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (tenant_id) DO UPDATE SET ${setClause}
         RETURNING *`,
        [req.user.tenant_id, ...values],
      );
      logger.info('SEO calendar config updated', { tenantId: req.user.tenant_id, updatedBy: req.user.id, fields });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// GET /calendar?week_start=YYYY-MM-DD — any date in the target week works,
// the response always snaps to that week's Monday. is_locked mirrors the
// exact rule PATCH /calendar/content/:id/assign enforces below: a week is
// locked (read-only) once its Monday is on/before today's Monday.
router.get('/calendar',
  [query('week_start').isISO8601()],
  validate,
  async (req, res, next) => {
    try {
      const weekStart = mondayOf(new Date(req.query.week_start));
      const weekEnd = addDays(weekStart, 6);
      const isLocked = weekStart <= mondayOf(new Date());

      const { rows } = await db.query(
        `SELECT id, title, slug, status, author_id, scheduled_at
           FROM seo_content_pieces
          WHERE tenant_id = $1 AND status IN ('scheduled', 'published') AND scheduled_at::date BETWEEN $2 AND $3
          ORDER BY scheduled_at ASC`,
        [req.user.tenant_id, toDateStr(weekStart), toDateStr(weekEnd)],
      );

      const days = [];
      for (let i = 0; i < 7; i++) {
        const dateStr = toDateStr(addDays(weekStart, i));
        days.push({ date: dateStr, articles: rows.filter((r) => toDateStr(new Date(r.scheduled_at)) === dateStr) });
      }
      res.json({ week_start: toDateStr(weekStart), is_locked: isLocked, days });
    } catch (err) { next(err); }
  },
);

router.get('/calendar/unassigned', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, slug, status, author_id, created_at FROM seo_content_pieces
        WHERE tenant_id = $1 AND status = 'queued' ORDER BY created_at ASC`,
      [req.user.tenant_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PATCH /calendar/content/:id/assign — drag&drop target. target_date=null
// unassigns back to the queue; a date moves it there, assigning a
// round-robin author if it doesn't already have one. No server-side cap on
// how many articles land on one day — a manual drag is allowed to exceed
// the configured daily count (confirmed with Adam 2026-08-22); the only
// thing this endpoint enforces is the current-week lock.
router.patch('/calendar/content/:id/assign',
  requireSeoEditor,
  [param('id').isInt(), body('target_date').optional({ nullable: true }).isISO8601()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: existing } = await db.query(
        `SELECT id, status, author_id FROM seo_content_pieces WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenant_id],
      );
      if (!existing[0]) return res.status(404).json({ error: 'Nie znaleziono.' });
      if (!['queued', 'scheduled'].includes(existing[0].status)) {
        return res.status(409).json({ error: 'Ten wpis nie jest częścią automatycznego kalendarza.' });
      }

      if (!req.body.target_date) {
        const { rows } = await db.query(
          `UPDATE seo_content_pieces SET status = 'queued', scheduled_at = NULL WHERE id = $1 RETURNING *`,
          [req.params.id],
        );
        return res.json(rows[0]);
      }

      const targetDate = new Date(req.body.target_date);
      if (mondayOf(targetDate) <= mondayOf(new Date())) {
        return res.status(409).json({ error: 'Ten tydzień jest już zablokowany i trwa publikacja — nie można go edytować.' });
      }

      const authorId = existing[0].author_id ?? await authorRotation.nextAuthor(req.user.tenant_id);
      const { rows } = await db.query(
        `UPDATE seo_content_pieces
            SET status = 'scheduled', scheduled_at = $2::date + TIME '09:00', author_id = $3
          WHERE id = $1 RETURNING *`,
        [req.params.id, toDateStr(targetDate), authorId],
      );
      logger.info('SEO calendar article reassigned', { contentId: req.params.id, targetDate: toDateStr(targetDate), reassignedBy: req.user.id });
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

module.exports = router;
