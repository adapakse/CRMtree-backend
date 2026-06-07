'use strict';
// routes/crm-consents.js
// ─────────────────────────────────────────────────────────────────────────────
// Zgody marketingowe dla Lead i Partner.
//
// GET  /api/crm/consents/types              — typy zgód z AppSettings
// GET  /api/crm/consents/leads/:leadId      — zgody dla leada
// PUT  /api/crm/consents/leads/:leadId      — zapisz zgody dla leada
// GET  /api/crm/consents/partners/:pid      — zgody dla partnera
// PUT  /api/crm/consents/partners/:pid      — zapisz zgody dla partnera
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth }        = require('../middleware/auth');
const { injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth }            = require('../middleware/crm-rbac');
const audit                  = require('../services/auditService');

router.use(requireAuth, injectAuditContext, crmAuth);

const VALUE_LABELS = { no_data: 'Brak danych', granted: 'Zgoda', denied: 'Brak zgody' };
const VALID_VALUES = new Set(['no_data', 'granted', 'denied']);

async function loadConsentTypes(tenantId) {
  const { rows } = await db.query(
    `SELECT value FROM app_settings WHERE key = 'crm.consent_types' AND tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) return [];
  try { return JSON.parse(rows[0].value) || []; } catch { return []; }
}

function mergeWithTypes(types, dbRows) {
  return types.map(ct => {
    const row = dbRows.find(r => r.consent_key === ct.key);
    return {
      consent_key:     ct.key,
      label:           ct.label,
      description:     ct.description,
      value:           row?.value || 'no_data',
      updated_by_name: row?.updated_by_name || null,
      updated_at:      row?.updated_at || null,
    };
  });
}

// ── GET /types ────────────────────────────────────────────────────────────────
router.get('/types', async (req, res, next) => {
  try {
    res.json(await loadConsentTypes(req.tenantId));
  } catch (err) { next(err); }
});

// ── GET /leads/:leadId ────────────────────────────────────────────────────────
router.get('/leads/:leadId', async (req, res, next) => {
  try {
    const leadId = parseInt(req.params.leadId, 10);
    if (!leadId) return res.status(400).json({ error: 'Invalid leadId' });

    const isManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
    if (!isManager) {
      const { rows: acc } = await db.query(
        `SELECT id FROM crm_leads WHERE id = $1 AND tenant_id = $2 AND assigned_to = $3`,
        [leadId, req.tenantId, req.user.id],
      );
      if (!acc.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const [types, { rows: dbRows }] = await Promise.all([
      loadConsentTypes(req.tenantId),
      db.query(
        `SELECT lc.consent_key, lc.value, lc.updated_at, u.display_name AS updated_by_name
         FROM crm_lead_consents lc
         LEFT JOIN users u ON u.id = lc.updated_by
         WHERE lc.lead_id = $1 AND lc.tenant_id = $2`,
        [leadId, req.tenantId],
      ),
    ]);

    res.json(mergeWithTypes(types, dbRows));
  } catch (err) { next(err); }
});

// ── PUT /leads/:leadId ────────────────────────────────────────────────────────
router.put('/leads/:leadId', async (req, res, next) => {
  try {
    const leadId = parseInt(req.params.leadId, 10);
    if (!leadId) return res.status(400).json({ error: 'Invalid leadId' });

    const payload = Array.isArray(req.body) ? req.body : [];
    if (!payload.length) return res.status(400).json({ error: 'Pusta lista zgód' });

    const isManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
    if (!isManager) {
      const { rows: acc } = await db.query(
        `SELECT id FROM crm_leads WHERE id = $1 AND tenant_id = $2 AND assigned_to = $3`,
        [leadId, req.tenantId, req.user.id],
      );
      if (!acc.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const types = await loadConsentTypes(req.tenantId);
    const validKeys = new Set(types.map(t => t.key));

    const { rows: oldRows } = await db.query(
      `SELECT consent_key, value FROM crm_lead_consents WHERE lead_id = $1 AND tenant_id = $2`,
      [leadId, req.tenantId],
    );
    const oldValues = Object.fromEntries(oldRows.map(r => [r.consent_key, r.value]));

    for (const item of payload) {
      const { key, value } = item;
      if (!validKeys.has(key) || !VALID_VALUES.has(value)) continue;

      const oldVal = oldValues[key] || 'no_data';

      await db.query(
        `INSERT INTO crm_lead_consents (tenant_id, lead_id, consent_key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (lead_id, consent_key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.tenantId, leadId, key, value, req.user.id],
      );

      if (oldVal !== value) {
        const ct = types.find(t => t.key === key);
        await audit.log({
          user:        req.user,
          action:      'crm_lead_consent_update',
          beforeState: { consent_key: key, value: oldVal, label: VALUE_LABELS[oldVal] || oldVal },
          afterState:  { consent_key: key, value,         label: VALUE_LABELS[value]  || value  },
          metadata:    { lead_id: String(leadId), consent_label: ct?.label || key },
          ipAddress:   req.auditContext?.ipAddress,
        });
      }
    }

    const { rows: newRows } = await db.query(
      `SELECT lc.consent_key, lc.value, lc.updated_at, u.display_name AS updated_by_name
       FROM crm_lead_consents lc
       LEFT JOIN users u ON u.id = lc.updated_by
       WHERE lc.lead_id = $1 AND lc.tenant_id = $2`,
      [leadId, req.tenantId],
    );

    res.json(mergeWithTypes(types, newRows));
  } catch (err) { next(err); }
});

// ── GET /partners/:partnerId ──────────────────────────────────────────────────
router.get('/partners/:partnerId', async (req, res, next) => {
  try {
    const partnerId = req.params.partnerId;

    const isManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
    if (!isManager) {
      const { rows: acc } = await db.query(
        `SELECT id FROM crm_partners WHERE id = $1::uuid AND tenant_id = $2 AND manager_id = $3`,
        [partnerId, req.tenantId, req.user.id],
      );
      if (!acc.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const [types, { rows: dbRows }] = await Promise.all([
      loadConsentTypes(req.tenantId),
      db.query(
        `SELECT pc.consent_key, pc.value, pc.updated_at, u.display_name AS updated_by_name
         FROM crm_partner_consents pc
         LEFT JOIN users u ON u.id = pc.updated_by
         WHERE pc.partner_id = $1::uuid AND pc.tenant_id = $2`,
        [partnerId, req.tenantId],
      ),
    ]);

    res.json(mergeWithTypes(types, dbRows));
  } catch (err) { next(err); }
});

// ── PUT /partners/:partnerId ──────────────────────────────────────────────────
router.put('/partners/:partnerId', async (req, res, next) => {
  try {
    const partnerId = req.params.partnerId;

    const payload = Array.isArray(req.body) ? req.body : [];
    if (!payload.length) return res.status(400).json({ error: 'Pusta lista zgód' });

    const isManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
    if (!isManager) {
      const { rows: acc } = await db.query(
        `SELECT id FROM crm_partners WHERE id = $1::uuid AND tenant_id = $2 AND manager_id = $3`,
        [partnerId, req.tenantId, req.user.id],
      );
      if (!acc.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const types = await loadConsentTypes(req.tenantId);
    const validKeys = new Set(types.map(t => t.key));

    const { rows: oldRows } = await db.query(
      `SELECT consent_key, value FROM crm_partner_consents WHERE partner_id = $1::uuid AND tenant_id = $2`,
      [partnerId, req.tenantId],
    );
    const oldValues = Object.fromEntries(oldRows.map(r => [r.consent_key, r.value]));

    for (const item of payload) {
      const { key, value } = item;
      if (!validKeys.has(key) || !VALID_VALUES.has(value)) continue;

      const oldVal = oldValues[key] || 'no_data';

      await db.query(
        `INSERT INTO crm_partner_consents (tenant_id, partner_id, consent_key, value, updated_by, updated_at)
         VALUES ($1, $2::uuid, $3, $4, $5, now())
         ON CONFLICT (partner_id, consent_key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.tenantId, partnerId, key, value, req.user.id],
      );

      if (oldVal !== value) {
        const ct = types.find(t => t.key === key);
        await audit.log({
          user:        req.user,
          action:      'crm_partner_consent_update',
          beforeState: { consent_key: key, value: oldVal, label: VALUE_LABELS[oldVal] || oldVal },
          afterState:  { consent_key: key, value,         label: VALUE_LABELS[value]  || value  },
          metadata:    { partner_id: String(partnerId), consent_label: ct?.label || key },
          ipAddress:   req.auditContext?.ipAddress,
        });
      }
    }

    const { rows: newRows } = await db.query(
      `SELECT pc.consent_key, pc.value, pc.updated_at, u.display_name AS updated_by_name
       FROM crm_partner_consents pc
       LEFT JOIN users u ON u.id = pc.updated_by
       WHERE pc.partner_id = $1::uuid AND pc.tenant_id = $2`,
      [partnerId, req.tenantId],
    );

    res.json(mergeWithTypes(types, newRows));
  } catch (err) { next(err); }
});

module.exports = router;
