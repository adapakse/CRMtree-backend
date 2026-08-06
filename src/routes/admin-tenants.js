'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/admin-tenants.js
//
// Super-admin API for tenant lifecycle management.
// All endpoints require is_super_admin = true.
//
// GET    /api/admin/tenants                  — list all tenants (excludes soft-deleted)
// POST   /api/admin/tenants           — create tenant
// GET    /api/admin/tenants/:id       — tenant details + features
// PATCH  /api/admin/tenants/:id       — update tenant metadata
// DELETE /api/admin/tenants/:id       — soft-delete tenant (sets deleted_at/deleted_by)
// PUT    /api/admin/tenants/:id/features — bulk-set feature flags
// POST   /api/admin/tenants/:id/impersonate — get JWT as tenant admin
//
// Every :id-scoped endpoint below refuses to operate on a soft-deleted
// tenant (findAliveTenant / an inline "deleted_at IS NULL" clause) — being
// hidden from GET / is not by itself a real access control, so each one is
// guarded independently too.
// ─────────────────────────────────────────────────────────────────

const router   = require('express').Router();
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { body, param } = require('express-validator');
const db       = require('../config/database');
const logger   = require('../utils/logger');
const audit    = require('../services/auditService');
const { encrypt, decrypt } = require('../utils/encrypt');
const { requireAuth, requireSuperAdmin, signAccessToken } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { EMAIL_PROVIDER_KEYS } = require('../config/email-providers');
const { clearTrainingModeCache } = require('../utils/trainingMode');

router.use(requireAuth, requireSuperAdmin, injectAuditContext);

const ALL_FEATURES = [
  'documents', 'leads', 'sales_reports', 'onboarding',
  'partner_registry', 'dwh_integration', 'performance',
];

// Returns the tenant row (id + any extraColumns) only if it exists and has
// not been soft-deleted, or null otherwise. Used by every :id-scoped
// endpoint below to keep a deleted tenant unreachable through direct API
// calls, not just hidden from GET /.
async function findAliveTenant(id, extraColumns = '') {
  const { rows } = await db.query(
    `SELECT id${extraColumns ? ', ' + extraColumns : ''} FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

// ── GET / — list all tenants ──────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        t.id, t.name, t.slug, t.email_domain, t.dwh_schema_prefix,
        t.is_active, t.active_email_provider, t.created_at, t.updated_at,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_active = true) AS user_count,
        COUNT(DISTINCT u.id) AS total_users,
        COALESCE(
          (SELECT JSON_AGG(JSON_BUILD_OBJECT('feature', tf.feature, 'is_enabled', tf.is_enabled) ORDER BY tf.feature)
           FROM tenant_features tf WHERE tf.tenant_id = t.id),
          '[]'
        ) AS features,
        COALESCE(
          (SELECT value = 'true' FROM app_settings WHERE tenant_id = t.id AND key = 'crm_training_mode'),
          false
        ) AS crm_training_mode
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id
      WHERE t.deleted_at IS NULL
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST / — create tenant ────────────────────────────────────────
router.post('/',
  [
    body('name').isString().trim().notEmpty().isLength({ max: 255 }),
    body('slug').isString().trim().toLowerCase()
      .matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
      .withMessage('slug musi mieć min 2 znaki i zawierać tylko [a-z0-9-]'),
    body('email_domain').optional({ nullable: true }).isString().trim(),
    body('dwh_schema_prefix').optional({ nullable: true }).isString().trim()
      .matches(/^[a-z][a-z0-9_]*$/)
      .withMessage('dwh_schema_prefix: tylko [a-z0-9_], musi zaczynać się literą'),
  ], validate,
  async (req, res, next) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { name, slug, email_domain, dwh_schema_prefix } = req.body;

      // Resolve gold (reference) tenant
      const { rows: goldRows } = await client.query(
        `SELECT id FROM tenants WHERE slug = 'crmtree-gold' LIMIT 1`
      );
      const goldId = goldRows[0]?.id ?? null;

      const { rows } = await client.query(
        `INSERT INTO tenants (name, slug, email_domain, dwh_schema_prefix, created_from_tenant_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [name, slug, email_domain || null, dwh_schema_prefix || null, goldId || req.tenantId || null]
      );
      const tenant = rows[0];

      // ── Feature flags: copy from gold (or all-off if gold missing) ──
      if (goldId) {
        await client.query(
          `INSERT INTO tenant_features (tenant_id, feature, is_enabled)
           SELECT $1, feature, is_enabled FROM tenant_features WHERE tenant_id = $2`,
          [tenant.id, goldId]
        );
      } else {
        for (const feature of ALL_FEATURES) {
          await client.query(
            `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, $2, false)`,
            [tenant.id, feature]
          );
        }
      }

      // ── app_settings: copy all from gold ────────────────────────────
      if (goldId) {
        await client.query(
          `INSERT INTO app_settings (key, value, label, description, value_type, category, updated_at, tenant_id)
           SELECT key, value, label, description, value_type, category, NOW(), $1
           FROM app_settings WHERE tenant_id = $2`,
          [tenant.id, goldId]
        );
      }

      // ── group_profiles: copy from gold (new UUIDs) ───────────────────
      if (goldId) {
        await client.query(
          `INSERT INTO group_profiles (name, display_name, description, has_owner_restriction, is_active, created_at, updated_at, tenant_id)
           SELECT name, display_name, description, has_owner_restriction, is_active, NOW(), NOW(), $1
           FROM group_profiles WHERE tenant_id = $2`,
          [tenant.id, goldId]
        );
      }

      // ── Password auth enabled ────────────────────────────────────────
      await client.query(
        `INSERT INTO tenant_auth_configs (tenant_id, provider, is_enabled) VALUES ($1, 'password', true)`,
        [tenant.id]
      );

      await client.query('COMMIT');
      logger.info('Super admin created tenant', {
        tenantId: tenant.id, slug, copiedFromGold: !!goldId, by: req.user.email,
      });
      res.status(201).json(tenant);
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// ── GET /:id — tenant details ─────────────────────────────────────
router.get('/:id',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT t.*,
                COUNT(DISTINCT u.id) FILTER (WHERE u.is_active = true) AS user_count,
                COUNT(DISTINCT u.id) AS total_users
         FROM tenants t
         LEFT JOIN users u ON u.tenant_id = t.id
         WHERE t.id = $1 AND t.deleted_at IS NULL
         GROUP BY t.id`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });

      const { rows: features } = await db.query(
        `SELECT feature, is_enabled FROM tenant_features WHERE tenant_id = $1 ORDER BY feature`,
        [req.params.id]
      );
      const { rows: authConfigs } = await db.query(
        `SELECT provider, is_enabled FROM tenant_auth_configs WHERE tenant_id = $1 ORDER BY provider`,
        [req.params.id]
      );
      const { rows: trainingRows } = await db.query(
        `SELECT value = 'true' AS enabled FROM app_settings WHERE tenant_id = $1 AND key = 'crm_training_mode'`,
        [req.params.id]
      );

      res.json({
        ...rows[0], features, auth_configs: authConfigs,
        crm_training_mode: trainingRows[0]?.enabled ?? false,
      });
    } catch (err) { next(err); }
  }
);

// ── PATCH /:id — update tenant metadata ──────────────────────────
router.patch('/:id',
  [
    param('id').isUUID(),
    body('name').optional().isString().trim().notEmpty().isLength({ max: 255 }),
    body('email_domain').optional({ nullable: true }),
    body('dwh_schema_prefix').optional({ nullable: true }),
    body('is_active').optional().isBoolean(),
  ], validate,
  async (req, res, next) => {
    try {
      const allowed = ['name', 'email_domain', 'dwh_schema_prefix', 'is_active'];
      const sets = [];
      const vals = [req.params.id];
      let i = 2;
      for (const field of allowed) {
        if (field in req.body) {
          sets.push(`${field} = $${i++}`);
          vals.push(req.body[field]);
        }
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      sets.push(`updated_at = NOW()`);

      const { rows } = await db.query(
        `UPDATE tenants SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        vals
      );
      if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });

      logger.info('Super admin updated tenant', { tenantId: req.params.id, by: req.user.email });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /:id — soft-delete a tenant ─────────────────────────────
// Sets deleted_at/deleted_by; never a hard DELETE — every row referencing
// this tenant (users, leads, partners, tokens, settings, ...) is left
// exactly as-is for rollback. From this point on the tenant is invisible on
// GET / and unreachable through every other :id-scoped endpoint in this
// file, and its users are locked out at the next request (middleware/auth.js
// requireAuth) and at login (routes/auth.js) — no JWT revocation needed,
// since both re-check the live deleted_at value on every call.
router.delete('/:id',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      if (req.tenantId && req.params.id.toLowerCase() === String(req.tenantId).toLowerCase()) {
        return res.status(400).json({ error: 'Nie można usunąć tenanta, do którego sam należysz.' });
      }

      const tenant = await findAliveTenant(req.params.id, 'name, slug');
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      if (tenant.slug === 'crmtree-gold') {
        return res.status(400).json({ error: "Nie można usunąć tenanta wzorcowego 'crmtree-gold' — jest używany jako źródło przy tworzeniu i reinicjalizacji innych tenantów." });
      }

      await db.query(
        `UPDATE tenants SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW() WHERE id = $1`,
        [req.params.id, req.user.id],
      );

      logger.warn('Super admin deleted tenant', {
        tenantId: req.params.id, name: tenant.name, slug: tenant.slug, by: req.user.email,
      });

      await audit.log({
        user:        req.user,
        action:      'tenant_deleted',
        beforeState: { deleted_at: null },
        afterState:  { deleted_at: new Date().toISOString() },
        metadata:    { tenant_id: req.params.id, tenant_name: tenant.name, tenant_slug: tenant.slug },
        ipAddress:   req.auditContext?.ipAddress,
      });

      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── PUT /:id/features — bulk update feature flags ─────────────────
router.put('/:id/features',
  [
    param('id').isUUID(),
    body('features').isObject(),
  ], validate,
  async (req, res, next) => {
    try {
      const { features } = req.body;
      for (const [feature, enabled] of Object.entries(features)) {
        if (!ALL_FEATURES.includes(feature)) continue;
        await db.query(
          `INSERT INTO tenant_features (tenant_id, feature, is_enabled)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = $3, updated_at = NOW()`,
          [req.params.id, feature, Boolean(enabled)]
        );
      }
      const { rows } = await db.query(
        `SELECT feature, is_enabled FROM tenant_features WHERE tenant_id = $1 ORDER BY feature`,
        [req.params.id]
      );
      logger.info('Super admin updated features', { tenantId: req.params.id, by: req.user.email });
      res.json(rows);
    } catch (err) { next(err); }
  }
);

// ── POST /:id/reinit — copy settings from gold to existing tenant ─
router.post('/:id/reinit',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: tenantRows } = await client.query(
        `SELECT id, name FROM tenants WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
      );
      if (!tenantRows.length) return res.status(404).json({ error: 'Tenant not found' });

      const { rows: goldRows } = await client.query(
        `SELECT id FROM tenants WHERE slug = 'crmtree-gold' LIMIT 1`
      );
      if (!goldRows.length) return res.status(404).json({ error: 'Tenant crmtree-gold not found' });

      const goldId    = goldRows[0].id;
      const targetId  = req.params.id;

      // ── app_settings: upsert (update existing, insert missing) ──────
      const { rowCount: settingsCount } = await client.query(
        `INSERT INTO app_settings (key, value, label, description, value_type, category, updated_at, tenant_id)
         SELECT key, value, label, description, value_type, category, NOW(), $1
         FROM app_settings WHERE tenant_id = $2
         ON CONFLICT (tenant_id, key) DO UPDATE SET
           value       = EXCLUDED.value,
           label       = EXCLUDED.label,
           description = EXCLUDED.description,
           value_type  = EXCLUDED.value_type,
           category    = EXCLUDED.category,
           updated_at  = NOW()`,
        [targetId, goldId]
      );

      // ── group_profiles: insert missing (by name), skip existing ─────
      // Partial index idx_group_profiles_tenant_name has WHERE tenant_id IS NOT NULL
      // so ON CONFLICT must include the same predicate.
      const { rowCount: groupsCount } = await client.query(
        `INSERT INTO group_profiles (name, display_name, description, has_owner_restriction, is_active, created_at, updated_at, tenant_id)
         SELECT name, display_name, description, has_owner_restriction, is_active, NOW(), NOW(), $1
         FROM group_profiles WHERE tenant_id = $2
         ON CONFLICT (tenant_id, name) WHERE tenant_id IS NOT NULL DO NOTHING`,
        [targetId, goldId]
      );

      // ── tenant_features: upsert from gold ───────────────────────────
      await client.query(
        `INSERT INTO tenant_features (tenant_id, feature, is_enabled)
         SELECT $1, feature, is_enabled FROM tenant_features WHERE tenant_id = $2
         ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = NOW()`,
        [targetId, goldId]
      );

      await client.query('COMMIT');
      logger.info('Super admin reinit tenant from gold', {
        tenantId: targetId, settingsCount, groupsCount, by: req.user.email,
      });
      res.json({ reinitialized: true, settings_upserted: settingsCount, groups_inserted: groupsCount });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// ── GET /:id/users — list users for a tenant ─────────────────────
router.get('/:id/users',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT id, email, first_name, last_name, display_name,
                is_admin, is_active, crm_role, created_at, last_login_at
         FROM users
         WHERE tenant_id = $1
         ORDER BY is_admin DESC, display_name ASC`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { next(err); }
  }
);

// ── POST /:id/users — create first/additional admin for a tenant ──
router.post('/:id/users',
  [
    param('id').isUUID(),
    body('email').isEmail().normalizeEmail(),
    body('first_name').isString().trim().notEmpty().isLength({ max: 100 }),
    body('last_name').isString().trim().notEmpty().isLength({ max: 100 }),
    body('is_admin').optional().isBoolean(),
  ], validate,
  async (req, res, next) => {
    try {
      const { email, first_name, last_name, is_admin = true } = req.body;

      // Verify tenant exists
      const { rows: tenantRows } = await db.query('SELECT id FROM tenants WHERE id = $1', [req.params.id]);
      if (!tenantRows.length) return res.status(404).json({ error: 'Tenant not found' });

      // Generate a secure temp password — shown once, never stored in plain text
      const tempPassword = crypto.randomBytes(10).toString('base64url').slice(0, 14);
      const password_hash = await bcrypt.hash(tempPassword, 12);

      const { rows } = await db.query(
        `INSERT INTO users
           (email, first_name, last_name, is_active, is_admin, tenant_id, password_hash, must_change_password)
         VALUES ($1, $2, $3, true, $4, $5, $6, true)
         RETURNING id, email, first_name, last_name, display_name, is_admin, is_active, created_at`,
        [email, first_name, last_name, is_admin, req.params.id, password_hash]
      );

      logger.info('Super admin created tenant user', {
        tenantId: req.params.id, email, isAdmin: is_admin, by: req.user.email,
      });

      // Return temp password only once — not stored anywhere readable
      res.status(201).json({ ...rows[0], temp_password: tempPassword });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'User with this email already exists' });
      next(err);
    }
  }
);

// ── POST /:id/impersonate — JWT as tenant's admin ─────────────────
router.post('/:id/impersonate',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const { rows } = await db.query(
        `SELECT id, email, first_name, last_name, display_name,
                is_admin, is_active, crm_role, tenant_id, is_super_admin
         FROM users
         WHERE tenant_id = $1 AND is_admin = true AND is_active = true
         ORDER BY created_at ASC
         LIMIT 1`,
        [req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'No active admin user found for this tenant' });
      }

      const impUser = rows[0];
      const accessToken = signAccessToken(impUser);

      logger.warn('Super admin impersonation', {
        superAdminId:    req.user.id,
        superAdminEmail: req.user.email,
        targetTenantId:  req.params.id,
        impersonatedId:  impUser.id,
        impersonatedEmail: impUser.email,
      });

      res.json({
        access_token: accessToken,
        impersonated_user: {
          id:           impUser.id,
          email:        impUser.email,
          display_name: impUser.display_name,
          tenant_id:    impUser.tenant_id,
        },
      });
    } catch (err) { next(err); }
  }
);

// ── GET /:id/email-providers — list configured email providers ────────────────
router.get('/:id/email-providers',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const { rows } = await db.query(
        `SELECT id, provider, client_id, redirect_uri, extra_config, is_enabled, created_at, updated_at
         FROM tenant_email_providers
         WHERE tenant_id = $1
         ORDER BY provider`,
        [req.params.id]
      );
      res.json(rows.map(r => ({ ...r, client_secret_configured: true })));
    } catch (err) { next(err); }
  }
);

// ── PUT /:id/email-providers/:provider — upsert credentials ──────────────────
router.put('/:id/email-providers/:provider',
  [
    param('id').isUUID(),
    param('provider').isIn(EMAIL_PROVIDER_KEYS),
    body('client_id').isString().trim().notEmpty(),
    body('client_secret').optional({ nullable: true }).isString(),
    body('redirect_uri').optional({ nullable: true }).isString().trim(),
    body('extra_config').optional().isObject(),
    body('is_enabled').optional().isBoolean(),
  ], validate,
  async (req, res, next) => {
    try {
      const { rows: tenantRows } = await db.query(
        'SELECT id, active_email_provider FROM tenants WHERE id = $1 AND deleted_at IS NULL', [req.params.id]
      );
      if (!tenantRows.length) return res.status(404).json({ error: 'Tenant not found' });
      const tenant = tenantRows[0];

      const { client_id, client_secret, redirect_uri, extra_config = {}, is_enabled = true } = req.body;

      const { rows: existing } = await db.query(
        'SELECT client_secret FROM tenant_email_providers WHERE tenant_id = $1 AND provider = $2',
        [req.params.id, req.params.provider]
      );

      let encSecret;
      if (client_secret) {
        encSecret = encrypt(client_secret);
      } else if (existing.length) {
        encSecret = existing[0].client_secret;
      } else {
        return res.status(400).json({ error: 'client_secret jest wymagany dla nowej konfiguracji' });
      }

      const { rows } = await db.query(
        `INSERT INTO tenant_email_providers
           (tenant_id, provider, client_id, client_secret, redirect_uri, extra_config, is_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           client_id     = EXCLUDED.client_id,
           client_secret = EXCLUDED.client_secret,
           redirect_uri  = EXCLUDED.redirect_uri,
           extra_config  = EXCLUDED.extra_config,
           is_enabled    = EXCLUDED.is_enabled,
           updated_at    = NOW()
         RETURNING id, provider, client_id, redirect_uri, extra_config, is_enabled, created_at, updated_at`,
        [req.params.id, req.params.provider, client_id, encSecret,
         redirect_uri || null, JSON.stringify(extra_config), is_enabled]
      );

      logger.info('Super admin upserted email provider', {
        tenantId: req.params.id, provider: req.params.provider, by: req.user.email,
      });

      // Auto-activate: a tenant with no active provider yet gets this one as
      // active the moment its first valid config is saved. If the tenant
      // already has an active provider, saving a different provider's config
      // must never switch it — the admin switches explicitly via
      // PUT /:id/active-provider.
      let activeProvider = tenant.active_email_provider;
      if (!activeProvider && is_enabled) {
        await db.query(
          `UPDATE tenants SET active_email_provider = $2, updated_at = NOW() WHERE id = $1`,
          [req.params.id, req.params.provider]
        );
        activeProvider = req.params.provider;
        logger.info('Super admin config auto-activated as tenant provider', {
          tenantId: req.params.id, provider: req.params.provider, by: req.user.email,
        });
      }

      res.json({ ...rows[0], client_secret_configured: true, active_email_provider: activeProvider });
    } catch (err) { next(err); }
  }
);

// ── DELETE /:id/email-providers/:provider — remove provider credentials ───────
router.delete('/:id/email-providers/:provider',
  [
    param('id').isUUID(),
    param('provider').isIn(EMAIL_PROVIDER_KEYS),
  ], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const { rowCount } = await db.query(
        'DELETE FROM tenant_email_providers WHERE tenant_id = $1 AND provider = $2',
        [req.params.id, req.params.provider]
      );
      if (!rowCount) return res.status(404).json({ error: 'Provider not configured' });

      // Deactivate this provider tenant-wide if it was the active one — an
      // active provider must always have a saved, enabled configuration.
      await db.query(
        `UPDATE tenants SET active_email_provider = NULL, updated_at = NOW()
         WHERE id = $1 AND active_email_provider = $2`,
        [req.params.id, req.params.provider]
      );

      logger.info('Super admin deleted email provider', {
        tenantId: req.params.id, provider: req.params.provider, by: req.user.email,
      });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── PUT /:id/active-provider — choose the tenant's single active email provider ───
// Body: { provider: 'gmail' | 'outlook' | 'zoho' | null }. null/omitted = "none".
// Refuses to activate a provider that has no saved, enabled configuration —
// this is the only place active_email_provider is ever written.
router.put('/:id/active-provider',
  [
    param('id').isUUID(),
    body('provider').optional({ nullable: true }).isIn(EMAIL_PROVIDER_KEYS),
  ], validate,
  async (req, res, next) => {
    try {
      const provider = req.body.provider || null;

      const { rows: tenantRows } = await db.query('SELECT id FROM tenants WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
      if (!tenantRows.length) return res.status(404).json({ error: 'Tenant not found' });

      if (provider) {
        const { rows: cfgRows } = await db.query(
          `SELECT 1 FROM tenant_email_providers WHERE tenant_id = $1 AND provider = $2 AND is_enabled = true`,
          [req.params.id, provider]
        );
        if (!cfgRows.length) {
          return res.status(400).json({
            error: `Nie można aktywować providera '${provider}' — brak zapisanej i aktywnej konfiguracji dla tego tenanta.`,
          });
        }
      }

      const { rows } = await db.query(
        `UPDATE tenants SET active_email_provider = $2, updated_at = NOW()
         WHERE id = $1 RETURNING id, active_email_provider`,
        [req.params.id, provider]
      );

      logger.info('Super admin set active email provider', {
        tenantId: req.params.id, provider, by: req.user.email,
      });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PUT /:id/training-mode — set the existing crm_training_mode value for one tenant ──
// Body: { enabled: boolean }. Updates the existing app_settings row for the
// tenant in the URL (:id), never req.tenantId — this manages an arbitrary
// tenant being viewed in the admin panel, not the calling super admin's own
// tenant. Does not create the row (no new default-value path): every tenant
// already gets crm_training_mode via the gold-tenant copy on creation /
// "Reinit z Gold"; if it's somehow missing, that's the fix, not an insert here.
// clearTrainingModeCache(tenantId) is the same invalidation settings.js already
// calls after writing this key — reused as-is, not modified — so the switch
// takes effect immediately for that tenant's users without touching others.
router.put('/:id/training-mode',
  [
    param('id').isUUID(),
    body('enabled').isBoolean(),
  ], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const enabled = req.body.enabled === true;

      const { rowCount } = await db.query(
        `UPDATE app_settings SET value = $1, updated_by = $2, updated_at = NOW()
         WHERE tenant_id = $3 AND key = 'crm_training_mode'`,
        [enabled ? 'true' : 'false', req.user?.id || null, req.params.id]
      );
      if (!rowCount) {
        return res.status(404).json({
          error: "Tenant nie ma jeszcze ustawienia crm_training_mode — użyj najpierw 'Reinit z Gold'.",
        });
      }

      clearTrainingModeCache(req.params.id);

      logger.info('Super admin set tenant training mode', {
        tenantId: req.params.id, enabled, by: req.user.email,
      });
      res.json({ id: req.params.id, crm_training_mode: enabled });
    } catch (err) { next(err); }
  }
);

// A secret field consisting only of mask characters (e.g. "********",
// "••••••••", "●●●●●●", "······", optionally with surrounding whitespace) is
// never a real value — it can only be a UI placeholder that leaked into the
// submitted body. Treated identically to "not provided", so it can never
// encrypt-and-overwrite an already-saved secret.
function isMaskedSecretPlaceholder(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && /^[*•●·]+$/.test(trimmed);
}

// ── GET /:id/whatsapp-config — WhatsApp Business config (no secrets) ──────
router.get('/:id/whatsapp-config',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const { rows } = await db.query(
        `SELECT id, waba_id, phone_number_id, display_phone_number, is_enabled,
                access_token, app_secret, webhook_verify_token, created_at, updated_at
         FROM tenant_whatsapp_config
         WHERE tenant_id = $1`,
        [req.params.id]
      );
      if (!rows.length) return res.json({ configured: false });

      const row = rows[0];
      res.json({
        id: row.id,
        waba_id: row.waba_id,
        phone_number_id: row.phone_number_id,
        display_phone_number: row.display_phone_number,
        is_enabled: row.is_enabled,
        created_at: row.created_at,
        updated_at: row.updated_at,
        configured: true,
        access_token_configured: !!row.access_token,
        app_secret_configured: !!row.app_secret,
        webhook_verify_token_configured: !!row.webhook_verify_token,
      });
    } catch (err) { next(err); }
  }
);

// ── PUT /:id/whatsapp-config — upsert tenant WhatsApp Business config ─────
// Secrets (access_token, app_secret, webhook_verify_token) follow the same
// contract as tenant_email_providers.client_secret: omitted/blank on an
// update keeps the previously saved encrypted value, required on first save.
router.put('/:id/whatsapp-config',
  [
    param('id').isUUID(),
    body('waba_id').isString().trim().notEmpty(),
    body('phone_number_id').isString().trim().notEmpty(),
    body('display_phone_number').optional({ nullable: true }).isString().trim(),
    body('access_token').optional({ nullable: true }).isString(),
    body('app_secret').optional({ nullable: true }).isString(),
    body('webhook_verify_token').optional({ nullable: true }).isString(),
    body('is_enabled').optional().isBoolean(),
  ], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const {
        waba_id, phone_number_id, display_phone_number,
        access_token, app_secret, webhook_verify_token,
        is_enabled = true,
      } = req.body;

      // Masked placeholders (e.g. "********") never count as a real value —
      // fall back to "not provided" exactly as if the field were blank.
      const accessTokenInput        = isMaskedSecretPlaceholder(access_token)         ? null : access_token;
      const appSecretInput          = isMaskedSecretPlaceholder(app_secret)           ? null : app_secret;
      const webhookVerifyTokenInput = isMaskedSecretPlaceholder(webhook_verify_token) ? null : webhook_verify_token;

      const { rows: existing } = await db.query(
        'SELECT access_token, app_secret, webhook_verify_token FROM tenant_whatsapp_config WHERE tenant_id = $1',
        [req.params.id]
      );
      const prev = existing[0] || null;

      let encAccessToken;
      if (accessTokenInput) {
        encAccessToken = encrypt(accessTokenInput);
      } else if (prev) {
        encAccessToken = prev.access_token;
      } else {
        return res.status(400).json({ error: 'access_token jest wymagany dla nowej konfiguracji' });
      }

      let encWebhookVerifyToken;
      if (webhookVerifyTokenInput) {
        encWebhookVerifyToken = encrypt(webhookVerifyTokenInput);
      } else if (prev) {
        encWebhookVerifyToken = prev.webhook_verify_token;
      } else {
        return res.status(400).json({ error: 'webhook_verify_token jest wymagany dla nowej konfiguracji' });
      }

      const encAppSecret = appSecretInput ? encrypt(appSecretInput) : (prev ? prev.app_secret : null);

      const { rows } = await db.query(
        `INSERT INTO tenant_whatsapp_config
           (tenant_id, waba_id, phone_number_id, display_phone_number, access_token, app_secret, webhook_verify_token, is_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id) DO UPDATE SET
           waba_id              = EXCLUDED.waba_id,
           phone_number_id      = EXCLUDED.phone_number_id,
           display_phone_number = EXCLUDED.display_phone_number,
           access_token         = EXCLUDED.access_token,
           app_secret           = EXCLUDED.app_secret,
           webhook_verify_token = EXCLUDED.webhook_verify_token,
           is_enabled           = EXCLUDED.is_enabled,
           updated_at           = NOW()
         RETURNING id, waba_id, phone_number_id, display_phone_number, is_enabled, created_at, updated_at`,
        [req.params.id, waba_id, phone_number_id, display_phone_number || null,
         encAccessToken, encAppSecret, encWebhookVerifyToken, is_enabled]
      );

      logger.info('Super admin upserted WhatsApp config', {
        tenantId: req.params.id, by: req.user.email,
      });

      res.json({
        ...rows[0],
        configured: true,
        access_token_configured: true,
        app_secret_configured: !!encAppSecret,
        webhook_verify_token_configured: true,
      });
    } catch (err) { next(err); }
  }
);

// ── DELETE /:id/whatsapp-config — remove tenant WhatsApp config ───────────
router.delete('/:id/whatsapp-config',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const { rowCount } = await db.query(
        'DELETE FROM tenant_whatsapp_config WHERE tenant_id = $1',
        [req.params.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'WhatsApp not configured' });

      logger.info('Super admin deleted WhatsApp config', {
        tenantId: req.params.id, by: req.user.email,
      });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
