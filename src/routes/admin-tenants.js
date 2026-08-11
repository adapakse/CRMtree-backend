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
// PUT    /api/admin/tenants/:id/subscription/cancel — end subscription (rezygnacja)
// DELETE /api/admin/tenants/:id/subscription/cancel — undo an accidental cancellation
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
const { getMissingRequiredFields } = require('../config/emailProviderRequiredFields');
const { clearTrainingModeCache } = require('../utils/trainingMode');
const whatsappService = require('../services/whatsappService');

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

router.use(requireAuth, requireSuperAdmin, injectAuditContext);

const ALL_FEATURES = [
  'documents', 'leads', 'sales_reports', 'onboarding',
  'partner_registry', 'dwh_integration', 'performance', 'whatsapp', 'seo_bot',
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
      const { rows: subscriptionRows } = await db.query(
        `SELECT ts.plan_id, ts.billing_cycle, ts.started_at, ts.custom_price_eur, ts.cancelled_at,
                bp.code AS plan_code, bp.name AS plan_name,
                (SELECT h.effective_from FROM tenant_subscription_history h
                 WHERE h.tenant_id = ts.tenant_id AND h.effective_to IS NULL
                 ORDER BY h.effective_from DESC LIMIT 1) AS plan_started_at
         FROM tenant_subscriptions ts
         JOIN billing_plans bp ON bp.id = ts.plan_id
         WHERE ts.tenant_id = $1`,
        [req.params.id]
      );
      const { rows: billingDetailsRows } = await db.query(
        `SELECT company_name, nip, street, postal_code, city, country, invoice_email
         FROM tenant_billing_details WHERE tenant_id = $1`,
        [req.params.id]
      );

      res.json({
        ...rows[0], features, auth_configs: authConfigs,
        crm_training_mode: trainingRows[0]?.enabled ?? false,
        subscription: subscriptionRows[0] || null,
        billing_details: billingDetailsRows[0] || null,
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

// ── PUT /:id/subscription — assign/update billing plan + cycle ────
router.put('/:id/subscription',
  [
    param('id').isUUID(),
    body('planId').isUUID(),
    body('billingCycle').isIn(['monthly', 'annual']),
    body('customPriceEur').optional({ nullable: true }).isFloat({ gt: 0 }),
  ], validate,
  async (req, res, next) => {
    try {
      const tenant = await findAliveTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      const { rows: planRows } = await db.query(
        `SELECT id, is_custom_pricing FROM billing_plans WHERE id = $1 AND is_active = true`,
        [req.body.planId]
      );
      if (!planRows.length) return res.status(400).json({ error: 'Unknown or inactive billing plan' });

      const plan = planRows[0];
      // Custom-pricing plans (Professional) require an explicit quote — for
      // every other plan the quote is meaningless, so force it to NULL
      // rather than trust the client not to send a stale value from a
      // previous Professional assignment.
      let customPriceEur = null;
      if (plan.is_custom_pricing) {
        if (req.body.customPriceEur == null) {
          return res.status(400).json({ error: 'Plan Professional wymaga podania indywidualnej kwoty (EUR).' });
        }
        customPriceEur = req.body.customPriceEur;
      }

      const { before, after } = await db.transaction(async (client) => {
        const { rows: beforeRows } = await client.query(
          `SELECT plan_id, billing_cycle, custom_price_eur, cancelled_at FROM tenant_subscriptions WHERE tenant_id = $1`,
          [req.params.id]
        );

        // Assigning/updating a plan also reactivates a cancelled subscription
        // (cancelled_at = NULL) — a superadmin picking a plan for a tenant is
        // an unambiguous signal that billing should resume, and requiring a
        // separate "undo cancellation" click first would be an easy trap.
        const { rows } = await client.query(
          `INSERT INTO tenant_subscriptions (tenant_id, plan_id, billing_cycle, custom_price_eur, updated_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id) DO UPDATE SET
             plan_id = $2, billing_cycle = $3, custom_price_eur = $4, updated_by = $5, updated_at = NOW(), cancelled_at = NULL
           RETURNING plan_id, billing_cycle, custom_price_eur, started_at, cancelled_at`,
          [req.params.id, req.body.planId, req.body.billingCycle, customPriceEur, req.user.id]
        );

        // Close the currently-open history row (if any) and open a new one —
        // billing-run resolves "which plan/price applied to period X" from
        // this log instead of the current tenant_subscriptions row, so a
        // plan change here must not silently re-price already-closed periods.
        await client.query(
          `UPDATE tenant_subscription_history
           SET effective_to = NOW()
           WHERE tenant_id = $1 AND effective_to IS NULL`,
          [req.params.id]
        );
        const { rows: historyRows } = await client.query(
          `INSERT INTO tenant_subscription_history (tenant_id, plan_id, billing_cycle, custom_price_eur, changed_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING effective_from`,
          [req.params.id, req.body.planId, req.body.billingCycle, customPriceEur, req.user.id]
        );

        return { before: beforeRows[0] || null, after: { ...rows[0], plan_started_at: historyRows[0].effective_from } };
      });

      await audit.log({
        user:        req.user,
        action:      'tenant_subscription_updated',
        beforeState: before,
        afterState:  after,
        metadata:    { tenant_id: req.params.id },
        ipAddress:   req.auditContext?.ipAddress,
      });

      logger.info('Super admin updated tenant subscription', { tenantId: req.params.id, by: req.user.email });
      res.json(after);
    } catch (err) { next(err); }
  }
);

// ── PUT /:id/subscription/cancel — end a subscription (rezygnacja) ────
// Sets tenant_subscriptions.cancelled_at — billing's OWN, unambiguous record
// of "this subscription ended". Deliberately separate from tenants.is_active,
// which superadmins also toggle for reasons unrelated to billing (e.g.
// suspension) and which must never be read as a cancellation signal (see
// billing-run.js fetchBillableTenants). Per the 2026-08 Lite/Standard rule,
// billing-run still bills the full calendar period cancelled_at falls into
// (no proration) and generates nothing after it.
router.put('/:id/subscription/cancel',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const tenant = await findAliveTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      const { rows } = await db.query(
        `UPDATE tenant_subscriptions SET cancelled_at = NOW()
         WHERE tenant_id = $1 AND cancelled_at IS NULL
         RETURNING cancelled_at`,
        [req.params.id]
      );

      if (!rows.length) {
        const { rows: existing } = await db.query(
          `SELECT cancelled_at FROM tenant_subscriptions WHERE tenant_id = $1`,
          [req.params.id]
        );
        if (!existing.length) return res.status(404).json({ error: 'Tenant has no subscription' });
        return res.json(existing[0]); // already cancelled — idempotent, no new audit entry
      }

      await audit.log({
        user:        req.user,
        action:      'tenant_subscription_cancelled',
        beforeState: { cancelled_at: null },
        afterState:  { cancelled_at: rows[0].cancelled_at },
        metadata:    { tenant_id: req.params.id },
        ipAddress:   req.auditContext?.ipAddress,
      });

      logger.info('Super admin cancelled tenant subscription', { tenantId: req.params.id, by: req.user.email });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /:id/subscription/cancel — undo an accidental cancellation ──
// Also achievable by reassigning a plan via PUT /:id/subscription (which
// clears cancelled_at too) — this route exists for reactivating with the
// exact same plan/cycle, with no unrelated field to resubmit.
router.delete('/:id/subscription/cancel',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const tenant = await findAliveTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      const { rows } = await db.query(
        `UPDATE tenant_subscriptions SET cancelled_at = NULL
         WHERE tenant_id = $1 AND cancelled_at IS NOT NULL
         RETURNING tenant_id`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Subscription is not cancelled' });

      await audit.log({
        user:        req.user,
        action:      'tenant_subscription_cancelled',
        beforeState: { cancelled_at: 'set' },
        afterState:  { cancelled_at: null },
        metadata:    { tenant_id: req.params.id },
        ipAddress:   req.auditContext?.ipAddress,
      });

      logger.info('Super admin reactivated (uncancelled) tenant subscription', { tenantId: req.params.id, by: req.user.email });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── PUT /:id/billing-details — legal buyer data for invoices ──────
// Separate from tenants.name (the CRM display name) — this is the legal
// company name/NIP/structured address/invoice email that must appear on
// this tenant's invoice PDFs.
router.put('/:id/billing-details',
  [
    param('id').isUUID(),
    body('company_name').optional({ nullable: true }).isString().trim().isLength({ max: 255 }),
    body('nip').optional({ nullable: true }).isString().trim().isLength({ max: 20 }),
    body('street').optional({ nullable: true }).isString().trim().isLength({ max: 255 }),
    body('postal_code').optional({ nullable: true }).isString().trim().isLength({ max: 20 }),
    body('city').optional({ nullable: true }).isString().trim().isLength({ max: 255 }),
    body('country').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
    body('invoice_email').optional({ nullable: true, checkFalsy: true }).isString().trim().isEmail().isLength({ max: 255 })
      .withMessage('invoice_email musi być poprawnym adresem e-mail'),
  ], validate,
  async (req, res, next) => {
    try {
      const tenant = await findAliveTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      const { rows } = await db.query(
        `INSERT INTO tenant_billing_details
           (tenant_id, company_name, nip, street, postal_code, city, country, invoice_email, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id) DO UPDATE SET
           company_name = $2, nip = $3, street = $4, postal_code = $5, city = $6, country = $7,
           invoice_email = $8, updated_by = $9, updated_at = NOW()
         RETURNING company_name, nip, street, postal_code, city, country, invoice_email`,
        [req.params.id, req.body.company_name || null, req.body.nip || null,
         req.body.street || null, req.body.postal_code || null, req.body.city || null,
         req.body.country || null, req.body.invoice_email || null, req.user.id]
      );

      logger.info('Super admin updated tenant billing details', { tenantId: req.params.id, by: req.user.email });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /:id/billing-details — clear a tenant's legal buyer data ─
// Removes only the current tenant_billing_details row — never touches
// already-issued invoices, which keep their own frozen buyer_* snapshot
// from the moment they were generated (see jobs/billing-run.js).
router.delete('/:id/billing-details',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const tenant = await findAliveTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      const { rows } = await db.query(
        `DELETE FROM tenant_billing_details WHERE tenant_id = $1 RETURNING company_name`,
        [req.params.id]
      );

      await audit.log({
        user:        req.user,
        action:      'settings_updated',
        beforeState: rows[0] ? { billing_details: rows[0].company_name } : null,
        afterState:  { billing_details: null },
        metadata:    { tenant_id: req.params.id, kind: 'tenant_billing_details_deleted' },
        ipAddress:   req.auditContext?.ipAddress,
      });

      logger.info('Super admin deleted tenant billing details', { tenantId: req.params.id, by: req.user.email });
      res.status(204).send();
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

      // All fields listed as required for this provider must be present —
      // no partial config is saved that would later silently fall back to
      // a global .env value at read time.
      const missingFields = getMissingRequiredFields(req.params.provider, {
        client_id, client_secret: encSecret, redirect_uri, extra_config,
      });
      if (missingFields.length) {
        return res.status(400).json({
          error: `Brakuje wymaganych pól konfiguracji (${req.params.provider}): ${missingFields.join(', ')}`,
          missingFields,
        });
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

// ── GET /:id/whatsapp-config — WhatsApp Business config (no secrets) ──────
router.get('/:id/whatsapp-config',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const cfg = await whatsappService.getTenantConfig(req.params.id);
      res.json(cfg ? { ...cfg, configured: true } : { configured: false });
    } catch (err) { next(err); }
  }
);

// ── PUT /:id/whatsapp-config — upsert tenant WhatsApp Business config ─────
// Secrets (access_token, app_secret) follow the same contract as
// tenant_email_providers.client_secret: omitted/blank on an update keeps the
// previously saved encrypted value, required on first save.
// webhook_verify_token is never accepted here — the CRM generates it.
// display_phone_number is never accepted here either — upsertTenantConfig
// fetches it (plus verified_name/code_verification_status) straight from
// Meta and rejects the save if the phone_number_id/access_token pair can't
// be resolved, so a mistyped or wrong-resource phone_number_id can never
// silently disagree with the number shown in the UI.
router.put('/:id/whatsapp-config',
  [
    param('id').isUUID(),
    body('waba_id').isString().trim().notEmpty(),
    body('phone_number_id').isString().trim().notEmpty(),
    body('access_token').optional({ nullable: true }).isString(),
    body('app_secret').optional({ nullable: true }).isString(),
    body('is_enabled').optional().isBoolean(),
  ], validate,
  async (req, res, next) => {
    try {
      if (!(await findAliveTenant(req.params.id))) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      // Masked placeholders (e.g. "********") never count as a real value —
      // fall back to "not provided" exactly as if the field were blank.
      const accessTokenInput = isMaskedSecretPlaceholder(req.body.access_token) ? null : (req.body.access_token || null);
      const appSecretInput   = isMaskedSecretPlaceholder(req.body.app_secret) ? null : (req.body.app_secret || null);

      const saved = await whatsappService.upsertTenantConfig(req.params.id, {
        waba_id: req.body.waba_id,
        phone_number_id: req.body.phone_number_id,
        access_token: accessTokenInput,
        app_secret: appSecretInput,
        is_enabled: req.body.is_enabled,
      });

      logger.info('Super admin upserted WhatsApp config', {
        tenantId: req.params.id, by: req.user.email,
      });

      res.json({ ...saved, configured: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
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

      const deleted = await whatsappService.deleteTenantConfig(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'WhatsApp not configured' });

      logger.info('Super admin deleted WhatsApp config', {
        tenantId: req.params.id, by: req.user.email,
      });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
