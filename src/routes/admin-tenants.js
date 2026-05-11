'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/admin-tenants.js
//
// Super-admin API for tenant lifecycle management.
// All endpoints require is_super_admin = true.
//
// GET    /api/admin/tenants                  — list all tenants
// POST   /api/admin/tenants           — create tenant
// GET    /api/admin/tenants/:id       — tenant details + features
// PATCH  /api/admin/tenants/:id       — update tenant metadata
// PUT    /api/admin/tenants/:id/features — bulk-set feature flags
// POST   /api/admin/tenants/:id/impersonate — get JWT as tenant admin
// ─────────────────────────────────────────────────────────────────

const router   = require('express').Router();
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { body, param } = require('express-validator');
const db       = require('../config/database');
const logger   = require('../utils/logger');
const { requireAuth, requireSuperAdmin, signAccessToken } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');

router.use(requireAuth, requireSuperAdmin, injectAuditContext);

const ALL_FEATURES = [
  'documents', 'leads', 'sales_reports', 'onboarding',
  'partner_registry', 'dwh_integration', 'performance',
];

// ── GET / — list all tenants ──────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        t.id, t.name, t.slug, t.email_domain, t.dwh_schema_prefix,
        t.is_active, t.created_at, t.updated_at,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_active = true) AS user_count,
        COUNT(DISTINCT u.id) AS total_users,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('feature', tf.feature, 'is_enabled', tf.is_enabled)
            ORDER BY tf.feature
          ) FILTER (WHERE tf.tenant_id IS NOT NULL),
          '[]'
        ) AS features
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id
      LEFT JOIN tenant_features tf ON tf.tenant_id = t.id
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
         WHERE t.id = $1
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

      res.json({ ...rows[0], features, auth_configs: authConfigs });
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
        `UPDATE tenants SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        vals
      );
      if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });

      logger.info('Super admin updated tenant', { tenantId: req.params.id, by: req.user.email });
      res.json(rows[0]);
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
        `SELECT id, name FROM tenants WHERE id = $1`, [req.params.id]
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

module.exports = router;
