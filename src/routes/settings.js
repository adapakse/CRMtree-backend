"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { body, param } = require("express-validator");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { injectAuditContext, validate } = require("../middleware/errorHandler");
const aiConfigService = require("../services/ai/aiConfigService");
const { clearTrainingModeCache } = require("../utils/trainingMode");
const { SUPPORTED_LOCALES } = require("../config/locales");

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
       WHERE s.tenant_id = $1
       ORDER BY category, key`,
      [req.tenantId]
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
        `SELECT key, value_type FROM app_settings WHERE tenant_id = $1 AND key = ANY($2)`,
        [req.tenantId, keys],
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
          `UPDATE app_settings SET value = $1, updated_by = $2, updated_at = now()
           WHERE tenant_id = $3 AND key = $4`,
          [strValue, req.user?.id || null, req.tenantId, key]
        );
      }

    // Return fresh settings
    const { rows } = await db.query(
      `SELECT key, value, label, description, value_type, category,
              s.updated_at, u.display_name AS updated_by_name
       FROM app_settings s
       LEFT JOIN users u ON u.id = s.updated_by
       WHERE s.tenant_id = $1
       ORDER BY category, key`,
      [req.tenantId]
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

      if (keys.includes('crm_training_mode')) clearTrainingModeCache(req.tenantId);

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


// ─── /api/admin/settings/ai ──────────────────────────────────────────────────
// Dostawca AI, klucz API i model — OSOBNO DLA KAŻDEJ FUNKCJI (migracja 0327).
// Celowo BRAK :tenantId w URL — zawsze req.tenantId z JWT, więc admin tenanta
// nie ma jak zaadresować cudzego tenanta (ten sam wzorzec co etapy leada i ICP).
//
// GET    /ai                 — konfiguracja wszystkich funkcji + rejestr dostawców
// PUT    /ai/:purpose        — zapis jednej funkcji (weryfikacja przed zapisem)
// DELETE /ai/:purpose        — wyłączenie jednej funkcji
// POST   /ai/:purpose/recheck
// POST   /ai/models          — modele dostępne na koncie u danego dostawcy
//
// Klucz API nigdy nie wraca z GET — tylko api_key_hint (4 ostatnie znaki).
// Reguły (weryfikacja przed zapisem, dziedziczenie klucza między funkcjami tego
// samego dostawcy, brak fallbacku na klucz systemowy): aiConfigService.js.

router.get("/ai", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    res.json(await aiConfigService.getConfig(req.tenantId));
  } catch (err) {
    next(err);
  }
});

// Lista modeli dostępnych na koncie u wskazanego dostawcy. POST, nie GET, bo w
// ciele może jechać świeżo wklejony klucz (jeszcze nie zapisany) — nie wolno mu
// wylądować w URL-u, logach dostępu ani historii przeglądarki. Zarejestrowane
// PRZED /ai/:purpose, żeby "models" nie zostało wzięte za nazwę funkcji.
router.post("/ai/models",
  requireAuth, requireAdmin,
  [
    body("provider").optional({ nullable: true }).isString().trim(),
    body("api_key").optional({ nullable: true }).isString(),
    body("base_url").optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  ], validate,
  async (req, res, next) => {
    try {
      res.json(await aiConfigService.listModels(req.tenantId, {
        provider: req.body.provider,
        apiKey: req.body.api_key,
        baseUrl: req.body.base_url,
      }));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
);

router.put("/ai/:purpose",
  requireAuth, requireAdmin, injectAuditContext,
  [
    param("purpose").isString().trim().notEmpty(),
    // Dostawca jest OPCJONALNY — backend rozpoznaje go z klucza i potwierdza
    // odpytaniem. Podaje się go tylko wtedy, gdy rozpoznanie nie wystarcza.
    body("provider").optional({ nullable: true }).isString().trim(),
    // Klucz opcjonalny: admin zmieniający sam model nie musi (i nie może) wklejać
    // go ponownie, a przy nowej funkcji tego samego dostawcy klucz jest dziedziczony.
    body("api_key").optional({ nullable: true }).isString(),
    // Pusty model = domyślny dla tego dostawcy i tej funkcji.
    body("model").optional({ nullable: true }).isString().trim().isLength({ max: 128 }),
    body("base_url").optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  ], validate,
  async (req, res, next) => {
    try {
      const config = await aiConfigService.saveConfig(req.tenantId, req.params.purpose, {
        provider: req.body.provider,
        apiKey: req.body.api_key,
        model: req.body.model,
        baseUrl: req.body.base_url,
      }, { actorUserId: req.user?.id ?? null });

      if (req.auditLog) {
        // Logujemy funkcję, dostawcę i model, NIGDY klucza ani jego fragmentu.
        await req.auditLog("settings_updated", null, null, {
          ai_purpose: config.purpose,
          ai_provider: config.provider,
          ai_model: config.model,
        });
      }
      res.json({ config });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
);

router.post("/ai/:purpose/recheck",
  requireAuth, requireAdmin,
  [param("purpose").isString().trim().notEmpty()], validate,
  async (req, res, next) => {
    try {
      res.json(await aiConfigService.recheckConfig(req.tenantId, req.params.purpose));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
);

router.delete("/ai/:purpose",
  requireAuth, requireAdmin, injectAuditContext,
  [param("purpose").isString().trim().notEmpty()], validate,
  async (req, res, next) => {
    try {
      const result = await aiConfigService.deleteConfig(req.tenantId, req.params.purpose);
      if (req.auditLog) {
        await req.auditLog("settings_updated", null, null, { ai_config_deleted: req.params.purpose });
      }
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
);

module.exports = router;
