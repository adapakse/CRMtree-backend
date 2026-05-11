'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/admin-data.js
//
// Admin-only endpoints for data management:
// DELETE /api/admin/data/documents/:id   — hard delete document + all related data
// DELETE /api/admin/data/leads/:id       — hard delete lead + all related data
// DELETE /api/admin/data/partners/:id    — hard delete partner + all related data
// POST   /api/admin/data/purge           — purge all test data (keep settings/users/groups)
// GET    /api/admin/data/export-settings — export settings as JSON
// POST   /api/admin/data/import-settings — import settings from JSON (overwrite)
// ─────────────────────────────────────────────────────────────────

const router  = require('express').Router();
const { param } = require('express-validator');
const db      = require('../config/database');
const storage = require('../services/storageService');
const logger  = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');

router.use(requireAuth, requireAdmin, injectAuditContext);

// ── Helper: delete blob safely ────────────────────────────────────
async function safeDeleteBlob(blobPath) {
  if (!blobPath) return;
  try { await storage.deleteBlob(blobPath); }
  catch (e) { logger.warn('Blob delete failed (non-fatal)', { blobPath, error: e.message }); }
}

// ── DELETE /api/admin/data/documents/:id ─────────────────────────
// Hard delete: document + versions (blob) + tags + workflow_tasks
// + document_group (if empty after) + audit_logs + crm link rows
router.delete('/documents/:id',
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;

      // 1. Fetch document and all versions to delete blobs
      const { rows: docRows } = await db.query(
        'SELECT * FROM documents WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]
      );
      if (!docRows.length) return res.status(404).json({ error: 'Document not found' });
      const doc = docRows[0];

      const { rows: versions } = await db.query(
        'SELECT blob_path FROM document_versions WHERE document_id=$1 AND tenant_id=$2', [id, req.tenantId]
      );

      // 2. Delete blobs (main + all versions)
      await safeDeleteBlob(doc.blob_path);
      for (const v of versions) await safeDeleteBlob(v.blob_path);

      // 3. DB cascade delete in correct order
      await db.query('DELETE FROM workflow_tasks       WHERE document_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query('DELETE FROM document_versions    WHERE document_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query('DELETE FROM document_tags        WHERE document_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query('DELETE FROM crm_lead_documents   WHERE document_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query('DELETE FROM crm_partner_documents WHERE document_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query('DELETE FROM audit_logs           WHERE document_id=$1 AND tenant_id=$2', [id, req.tenantId]);

      // 4. Delete document itself
      await db.query('DELETE FROM documents WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);

      // 5. Clean up empty document_group
      if (doc.document_group_id) {
        const { rows: remaining } = await db.query(
          'SELECT COUNT(*) FROM documents WHERE document_group_id=$1 AND tenant_id=$2', [doc.document_group_id, req.tenantId]
        );
        if (parseInt(remaining[0].count) === 0) {
          await db.query('DELETE FROM document_groups WHERE id=$1 AND tenant_id=$2', [doc.document_group_id, req.tenantId]);
        }
      }

      logger.info('Admin hard-deleted document', { documentId: id, by: req.user.email });
      res.json({ deleted: true, id, name: doc.name });
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/admin/data/leads/:id ─────────────────────────────
// Hard delete: lead + activities + doc links + sales budgets + audit_logs
router.delete('/leads/:id',
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { rows } = await db.query('SELECT * FROM crm_leads WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);
      if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
      const lead = rows[0];

      await db.query('DELETE FROM crm_lead_activities  WHERE lead_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query('DELETE FROM crm_lead_documents   WHERE lead_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query(`DELETE FROM audit_logs WHERE metadata->>'lead_id' = $1::text AND tenant_id=$2`, [String(id), req.tenantId]);
      await db.query('DELETE FROM crm_leads WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);

      logger.info('Admin hard-deleted lead', { leadId: id, by: req.user.email });
      res.json({ deleted: true, id, company: lead.company });
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/admin/data/partners/:id ──────────────────────────
// Hard delete: partner + activities + doc links + transactions + sales_data + audit_logs
router.delete('/partners/:id',
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { rows } = await db.query('SELECT * FROM crm_partners WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);
      if (!rows.length) return res.status(404).json({ error: 'Partner not found' });
      const partner = rows[0];

      await db.query('DELETE FROM crm_partner_activities WHERE partner_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query('DELETE FROM crm_partner_documents  WHERE partner_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query('DELETE FROM crm_sales_data         WHERE partner_id=$1 AND tenant_id=$2', [id, req.tenantId]);
      await db.query(`DELETE FROM audit_logs WHERE metadata->>'partner_id' = $1::text AND tenant_id=$2`, [String(id), req.tenantId]);

      // Dissociate any leads that were converted to this partner
      await db.query('UPDATE crm_leads SET converted_at=NULL WHERE id IN (SELECT id FROM crm_leads WHERE id=$1)', [id]);

      await db.query('DELETE FROM crm_partners WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);

      logger.info('Admin hard-deleted partner', { partnerId: id, by: req.user.email });
      res.json({ deleted: true, id, company: partner.company });
    } catch (err) { next(err); }
  }
);

// ── POST /api/admin/data/purge ────────────────────────────────────
// Purge ALL test data. Preserves:
// users, user_group_roles, group_profiles,
// crm_partner_groups, app_settings
router.post('/purge', async (req, res, next) => {
  try {
    const { confirm } = req.body;
    if (confirm !== 'PURGE_ALL_DATA') {
      return res.status(400).json({ error: 'Confirm by sending confirm: "PURGE_ALL_DATA"' });
    }

    logger.warn('Admin initiated full data purge', { by: req.user.email });

    // 1. Collect all blob paths before deleting
    const { rows: docs } = await db.query('SELECT blob_path FROM documents WHERE blob_path IS NOT NULL AND tenant_id=$1', [req.tenantId]);
    const { rows: vers } = await db.query('SELECT blob_path FROM document_versions WHERE blob_path IS NOT NULL AND tenant_id=$1', [req.tenantId]);
    const { rows: logos } = await db.query(
      `SELECT logo_url FROM crm_leads WHERE logo_url IS NOT NULL AND tenant_id=$1
       UNION
       SELECT logo_url FROM crm_partners WHERE logo_url IS NOT NULL AND tenant_id=$1`,
      [req.tenantId]
    );

    // 2. Delete in dependency order
    await db.query('DELETE FROM workflow_tasks       WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM document_versions    WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM document_tags        WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM document_groups      WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_lead_activities  WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_lead_documents   WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_partner_activities WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_partner_documents  WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_sales_data         WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_sales_budgets      WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_import_logs        WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM audit_logs             WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM documents              WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_leads              WHERE tenant_id=$1', [req.tenantId]);
    await db.query('DELETE FROM crm_partners           WHERE tenant_id=$1', [req.tenantId]);

    // 3. Delete blobs
    let blobsDeleted = 0;
    for (const d of docs)  { await safeDeleteBlob(d.blob_path);  blobsDeleted++; }
    for (const v of vers)  { await safeDeleteBlob(v.blob_path);  blobsDeleted++; }
    for (const l of logos) { await safeDeleteBlob(l.logo_url);   blobsDeleted++; }

    logger.warn('Full data purge completed', { blobsDeleted, by: req.user.email });
    res.json({ purged: true, blobsDeleted });
  } catch (err) { next(err); }
});

// ── GET /api/admin/data/export-settings ──────────────────────────
// Export app_settings + group_profiles as JSON
router.get('/export-settings', async (req, res, next) => {
  try {
    const { rows: settings } = await db.query(
      'SELECT key, value, value_type, label, description, category FROM app_settings WHERE tenant_id=$1 ORDER BY category, key',
      [req.tenantId]
    );
    const { rows: groups } = await db.query(
      `SELECT id, name, display_name, description, has_owner_restriction, is_active
       FROM group_profiles
       WHERE tenant_id=$1
       ORDER BY name`,
      [req.tenantId]
    );

    const payload = {
      exported_at: new Date().toISOString(),
      exported_by: req.user.email,
      version: 1,
      app_settings: settings,
      group_profiles: groups,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="worktrips-settings-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(payload);
  } catch (err) { next(err); }
});

// ── POST /api/admin/data/import-settings ─────────────────────────
// Import settings from JSON — overwrites existing values
router.post('/import-settings', async (req, res, next) => {
  try {
    const payload = req.body;
    if (!payload?.version || !payload?.app_settings) {
      return res.status(400).json({ error: 'Invalid settings file — missing version or app_settings' });
    }

    let settingsUpdated = 0;
    let groupsUpdated   = 0;

    // 1. Upsert app_settings
    for (const s of payload.app_settings) {
      await db.query(
        `INSERT INTO app_settings (key, value, value_type, label, description, category, updated_by, updated_at, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)
         ON CONFLICT (tenant_id, key) DO UPDATE SET
           value=$2, value_type=$3, label=$4, description=$5, category=$6,
           updated_by=$7, updated_at=now()`,
        [s.key, s.value, s.value_type, s.label, s.description, s.category, req.user.id, req.tenantId]
      );
      settingsUpdated++;
    }

    // 2. Upsert group_profiles + rules
    if (Array.isArray(payload.group_profiles)) {
      for (const g of payload.group_profiles) {
        const { rows } = await db.query(
          `INSERT INTO group_profiles (name, display_name, description, has_owner_restriction, is_active, tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, name) DO UPDATE SET
             display_name=$2, description=$3, has_owner_restriction=$4, is_active=$5
           RETURNING id`,
          [g.name, g.display_name, g.description ?? null, g.has_owner_restriction ?? false, g.is_active ?? true, req.tenantId]
        );
        const groupId = rows[0].id;

        // group_rules niet geïmporteerd — tabela nie istnieje w schemacie
        groupsUpdated++;
      }
    }

    logger.info('Admin imported settings', { settingsUpdated, groupsUpdated, by: req.user.email });
    res.json({ imported: true, settingsUpdated, groupsUpdated });
  } catch (err) { next(err); }
});


// ── POST /api/admin/data/purge-category ──────────────────────────
// Purge one category: docs | leads | partners
router.post('/purge-category', async (req, res, next) => {
  try {
    const { category } = req.body;
    if (!['docs','leads','partners'].includes(category)) {
      return res.status(400).json({ error: 'category must be docs, leads or partners' });
    }

    let deleted = 0;
    let blobsDeleted = 0;

    if (category === 'docs') {
      const { rows: docs } = await db.query('SELECT blob_path FROM documents WHERE blob_path IS NOT NULL AND tenant_id=$1', [req.tenantId]);
      const { rows: vers } = await db.query('SELECT blob_path FROM document_versions WHERE blob_path IS NOT NULL AND tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM workflow_tasks       WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM document_versions    WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM document_tags        WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM crm_lead_documents   WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM crm_partner_documents WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM audit_logs WHERE document_id IS NOT NULL AND tenant_id=$1', [req.tenantId]);
      const { rowCount } = await db.query('DELETE FROM documents WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM document_groups WHERE tenant_id=$1', [req.tenantId]);
      deleted = rowCount || 0;
      for (const d of docs) { await safeDeleteBlob(d.blob_path); blobsDeleted++; }
      for (const v of vers) { await safeDeleteBlob(v.blob_path); blobsDeleted++; }
    }

    if (category === 'leads') {
      await db.query('DELETE FROM crm_lead_activities WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM crm_lead_documents  WHERE tenant_id=$1', [req.tenantId]);
      await db.query(`DELETE FROM crm_import_logs WHERE import_type = 'leads' AND tenant_id=$1`, [req.tenantId]);
      await db.query(`DELETE FROM audit_logs WHERE metadata->>'lead_id' IS NOT NULL AND document_id IS NULL AND tenant_id=$1`, [req.tenantId]);
      const { rows: logos } = await db.query('SELECT logo_url FROM crm_leads WHERE logo_url IS NOT NULL AND tenant_id=$1', [req.tenantId]);
      const { rowCount } = await db.query('DELETE FROM crm_leads WHERE tenant_id=$1', [req.tenantId]);
      deleted = rowCount || 0;
      for (const l of logos) { await safeDeleteBlob(l.logo_url); blobsDeleted++; }
    }

    if (category === 'partners') {
      await db.query('DELETE FROM crm_partner_activities WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM crm_partner_documents  WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM crm_sales_data         WHERE tenant_id=$1', [req.tenantId]);
      await db.query('DELETE FROM crm_sales_budgets      WHERE tenant_id=$1', [req.tenantId]);
      await db.query(`DELETE FROM crm_import_logs WHERE import_type IN ('partners','sales') AND tenant_id=$1`, [req.tenantId]);
      await db.query(`DELETE FROM audit_logs WHERE metadata->>'partner_id' IS NOT NULL AND document_id IS NULL AND tenant_id=$1`, [req.tenantId]);
      const { rows: logos } = await db.query('SELECT logo_url FROM crm_partners WHERE logo_url IS NOT NULL AND tenant_id=$1', [req.tenantId]);
      const { rowCount } = await db.query('DELETE FROM crm_partners WHERE tenant_id=$1', [req.tenantId]);
      deleted = rowCount || 0;
      for (const l of logos) { await safeDeleteBlob(l.logo_url); blobsDeleted++; }
    }

    logger.warn('Admin purged category', { category, deleted, blobsDeleted, by: req.user.email });
    res.json({ purged: true, category, deleted, blobsDeleted });
  } catch (err) { next(err); }
});

module.exports = router;
