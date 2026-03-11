'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { injectAuditContext }        = require('../middleware/errorHandler');

// ─── GET /api/admin/settings ──────────────────────────────────────────────────
// Returns all settings as a flat key→value object.
// Available to all authenticated users (frontend needs thresholds to render).
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.key, s.value, s.label, s.description, s.value_type, s.category,
              s.updated_at, u.display_name AS updated_by_name
       FROM app_settings s
       LEFT JOIN users u ON u.id = s.updated_by
       ORDER BY s.category, s.key`
    );

    // Build flat map for easy consumption: { expiration_red_days: 90, ... }
    const flat = {};
    for (const row of rows) {
      flat[row.key] = row.value_type === 'number'  ? Number(row.value)
                    : row.value_type === 'boolean' ? row.value === 'true'
                    : row.value;
    }

    res.json({ settings: flat, meta: rows });
  } catch (err) { next(err); }
});

// ─── PUT /api/admin/settings ──────────────────────────────────────────────────
// Update one or more settings. Admin only.
// Body: { expiration_red_days: 60, default_page_size: 25, ... }
router.put('/', requireAuth, requireAdmin, injectAuditContext, async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Body must be a key/value object' });
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.status(400).json({ error: 'No settings provided' });

    // Validate all keys exist before touching the DB
    const { rows: existing } = await db.query(
      `SELECT key, value_type FROM app_settings WHERE key = ANY($1)`,
      [keys]
    );
    const existingKeys = new Set(existing.map(r => r.key));
    const unknown = keys.filter(k => !existingKeys.has(k));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown settings keys: ${unknown.join(', ')}` });
    }

    // Validate types
    const typeMap = Object.fromEntries(existing.map(r => [r.key, r.value_type]));
    for (const [key, val] of Object.entries(updates)) {
      if (typeMap[key] === 'number' && (isNaN(Number(val)) || Number(val) < 0)) {
        return res.status(400).json({ error: `${key} must be a non-negative number` });
      }
    }

    // Upsert each setting
    for (const [key, val] of Object.entries(updates)) {
      await db.query(
        `UPDATE app_settings SET value = $1, updated_at = now(), updated_by = $2 WHERE key = $3`,
        [String(val), req.user.id, key]
      );
    }

    // Return fresh settings
    const { rows } = await db.query(
      `SELECT s.key, s.value, s.label, s.description, s.value_type, s.category,
              s.updated_at, u.display_name AS updated_by_name
       FROM app_settings s
       LEFT JOIN users u ON u.id = s.updated_by
       ORDER BY s.category, s.key`
    );

    const flat = {};
    for (const row of rows) {
      flat[row.key] = row.value_type === 'number'  ? Number(row.value)
                    : row.value_type === 'boolean' ? row.value === 'true'
                    : row.value;
    }

    // Audit log
    if (req.auditLog) {
      await req.auditLog('settings_updated', null, null, { updated_keys: keys });
    }

    res.json({ settings: flat, meta: rows });
  } catch (err) { next(err); }
});

module.exports = router;
