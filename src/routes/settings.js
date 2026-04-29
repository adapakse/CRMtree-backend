"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { injectAuditContext } = require("../middleware/errorHandler");

// ─── GET /api/admin/settings ──────────────────────────────────────────────────
// Returns all settings as a flat key→value object.
// Available to all authenticated users (frontend needs thresholds to render).
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT key, value, label, description, value_type, category,
              s.updated_at, u.display_name AS updated_by_name
       FROM app_settings s
       LEFT JOIN users u ON u.id = s.updated_by
       ORDER BY category, key`
    );

    // Build flat map for easy consumption: { expiration_red_days: 90, ... }
    const flat = {};
    for (const row of rows) {
      flat[row.key] =
        row.value_type === "number"
          ? Number(row.value)
          : row.value_type === "boolean"
            ? row.value === "true"
            : row.value;
    }

    res.json({ settings: flat, meta: rows });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/admin/settings ──────────────────────────────────────────────────
// Update one or more settings. Admin only.
// Body: { expiration_red_days: 60, default_page_size: 25, ... }
router.put(
  "/",
  requireAuth,
  requireAdmin,
  injectAuditContext,
  async (req, res, next) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
        return res
          .status(400)
          .json({ error: "Body must be a key/value object" });
      }

      const keys = Object.keys(updates);
      if (keys.length === 0)
        return res.status(400).json({ error: "No settings provided" });

      // Validate all keys exist before touching the DB
      const { rows: existing } = await db.query(
        `SELECT key, value_type FROM app_settings WHERE key = ANY($1)`,
        [keys],
      );
      const existingKeys = new Set(existing.map((r) => r.key));
      const unknown = keys.filter((k) => !existingKeys.has(k));
      if (unknown.length > 0) {
        return res
          .status(400)
          .json({ error: `Unknown settings keys: ${unknown.join(", ")}` });
      }

      // Update each key in DB
      const typeMap = {};
      for (const row of existing) typeMap[row.key] = row.value_type;

      for (const [key, rawValue] of Object.entries(updates)) {
        const vtype = typeMap[key];
        let strValue;
        if (vtype === 'number')  strValue = String(Number(rawValue));
        else if (vtype === 'boolean') strValue = rawValue === true || rawValue === 'true' ? 'true' : 'false';
        else if (vtype === 'json') strValue = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
        else strValue = String(rawValue ?? '');

        await db.query(
          `UPDATE app_settings SET value = $1, updated_by = $2, updated_at = now() WHERE key = $3`,
          [strValue, req.user?.id || null, key]
        );
      }

    // Return fresh settings
    const { rows } = await db.query(
      `SELECT key, value, label, description, value_type, category,
              s.updated_at, u.display_name AS updated_by_name
       FROM app_settings s
       LEFT JOIN users u ON u.id = s.updated_by
       ORDER BY category, key`
    );

      const flat = {};
      for (const row of rows) {
        flat[row.key] =
          row.value_type === "number"
            ? Number(row.value)
            : row.value_type === "boolean"
              ? row.value === "true"
              : row.value;
      }

      // Audit log
      if (req.auditLog) {
        await req.auditLog("settings_updated", null, null, {
          updated_keys: keys,
        });
      }

      res.json({ settings: flat, meta: rows });
    } catch (err) {
      next(err);
    }
  },
);


// ─── POST /api/admin/settings/tooltips ───────────────────────────────────────
// Upsert tooltip (create or update). Admin only.
// Body: { key, label, value }
router.post("/tooltips", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { key, label, value } = req.body;
    if (!key?.trim())   return res.status(400).json({ error: "'key' jest wymagany" });
    if (!value?.trim()) return res.status(400).json({ error: "'value' (treść tooltip) jest wymagana" });

    await db.query(
      `INSERT INTO app_settings (key, value, label, description, value_type, category, updated_by, updated_at)
       VALUES ($1, $2, $3, '', 'string', 'tooltip', $4, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, label = EXCLUDED.label,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key.trim(), value.trim(), label?.trim() || key.trim(), req.user?.id || null]
    );

    const { rows } = await db.query(
      `SELECT key, value, label, description, value_type, category,
              s.updated_at, u.display_name AS updated_by_name
       FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by
       WHERE s.key = $1`,
      [key.trim()]
    );
    res.status(200).json(rows[0]);
  } catch (err) { next(err); }
});

// ─── DELETE /api/admin/settings/tooltips/:key ─────────────────────────────────
// Usuwa tooltip. Admin only.
router.delete("/tooltips/:key", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM app_settings WHERE key = $1 AND category = 'tooltip'`,
      [req.params.key]
    );
    if (!rowCount) return res.status(404).json({ error: "Tooltip nie znaleziony" });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── GET /api/admin/settings/groups ──────────────────────────────────────────
// Lista grup użytkowników (group_profiles). Tylko admin.
router.get("/groups", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, display_name, description, has_owner_restriction, is_active,
              (SELECT COUNT(*) FROM user_group_roles ugr WHERE ugr.group_id = gp.id)::int AS member_count,
              (SELECT COUNT(*) FROM documents d WHERE d.group_id = gp.id AND d.deleted_at IS NULL)::int AS document_count
       FROM group_profiles gp
       ORDER BY name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── POST /api/admin/settings/groups ─────────────────────────────────────────
// Tworzy nową grupę użytkowników. Tylko admin.
router.post("/groups", requireAuth, requireAdmin, injectAuditContext, async (req, res, next) => {
  try {
    const { name, display_name, description, has_owner_restriction } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Pole 'name' jest wymagane" });
    if (!display_name?.trim()) return res.status(400).json({ error: "Pole 'display_name' jest wymagane" });

    const { rows } = await db.query(
      `INSERT INTO group_profiles (name, display_name, description, has_owner_restriction, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [name.trim(), display_name.trim(), description?.trim() || null, has_owner_restriction === true]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Grupa o nazwie '${req.body.name}' już istnieje` });
    next(err);
  }
});

// ─── PATCH /api/admin/settings/groups/:id ────────────────────────────────────
// Aktualizuje grupę. Tylko admin.
router.patch("/groups/:id", requireAuth, requireAdmin, injectAuditContext, async (req, res, next) => {
  try {
    const { display_name, description, has_owner_restriction, is_active } = req.body;
    const { rows: existing } = await db.query(
      "SELECT * FROM group_profiles WHERE id = $1", [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: "Grupa nie znaleziona" });

    const { rows } = await db.query(
      `UPDATE group_profiles
       SET display_name          = COALESCE($1, display_name),
           description           = COALESCE($2, description),
           has_owner_restriction = COALESCE($3, has_owner_restriction),
           is_active             = COALESCE($4, is_active)
       WHERE id = $5
       RETURNING *`,
      [
        display_name?.trim() ?? null,
        description?.trim() ?? null,
        has_owner_restriction ?? null,
        is_active ?? null,
        req.params.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── DELETE /api/admin/settings/groups/:id ───────────────────────────────────
// Usuwa grupę. Blokuje usunięcie jeśli są przypisani użytkownicy lub dokumenty.
router.delete("/groups/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows: existing } = await db.query(
      `SELECT gp.*,
              (SELECT COUNT(*) FROM user_group_roles WHERE group_id = gp.id)::int AS member_count,
              (SELECT COUNT(*) FROM documents WHERE group_id = gp.id AND deleted_at IS NULL)::int AS document_count
       FROM group_profiles gp WHERE id = $1`,
      [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: "Grupa nie znaleziona" });
    const g = existing[0];
    if (g.member_count > 0 || g.document_count > 0) {
      return res.status(409).json({
        error: `Nie można usunąć grupy — ma ${g.member_count} użytkowników i ${g.document_count} dokumentów.`,
      });
    }
    await db.query("DELETE FROM group_profiles WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;

