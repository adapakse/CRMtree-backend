"use strict";

const router = require("express").Router();
const { body, param, query } = require("express-validator");
const db = require("../config/database");
const audit = require("../services/auditService");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate, injectAuditContext } = require("../middleware/errorHandler");

// Public list (all authenticated users need to know groups for UI)
router.use(requireAuth, injectAuditContext);

// ────────────────────────────────────────────────────────────
// GET /api/groups — list all active groups
// ────────────────────────────────────────────────────────────
router.get(
  "/",
  [query("include_inactive").optional().isBoolean().toBoolean()],
  validate,
  async (req, res, next) => {
    try {
      const showInactive = req.user?.is_admin && req.query.include_inactive;
      const { rows } = await db.query(
        `SELECT gp.*,
                COUNT(DISTINCT ugr.user_id)  AS member_count,
                COUNT(DISTINCT d.id)         AS document_count
         FROM group_profiles gp
         LEFT JOIN user_group_roles ugr ON ugr.group_id = gp.id AND ugr.tenant_id = $1
         LEFT JOIN documents d ON d.group_id = gp.id AND d.deleted_at IS NULL AND d.tenant_id = $1
         WHERE gp.tenant_id = $1${showInactive ? "" : " AND gp.is_active = TRUE"}
         GROUP BY gp.id
         ORDER BY gp.name`,
        [req.tenantId],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/groups/:id
// ────────────────────────────────────────────────────────────
router.get("/:id", [param("id").isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT gp.*,
              json_agg(json_build_object(
                'user_id', u.id, 'email', u.email, 'display_name', u.display_name,
                'access_level', ugr.access_level
              )) FILTER (WHERE ugr.user_id IS NOT NULL) AS members
       FROM group_profiles gp
       LEFT JOIN user_group_roles ugr ON ugr.group_id = gp.id AND ugr.tenant_id = $2
       LEFT JOIN users u ON u.id = ugr.user_id AND u.tenant_id = $2
       WHERE gp.id = $1 AND gp.tenant_id = $2
       GROUP BY gp.id`,
      [req.params.id, req.tenantId],
    );
    if (!rows.length) return res.status(404).json({ error: "Group not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/groups — create (admin only)
// ────────────────────────────────────────────────────────────
router.post(
  "/",
  requireAdmin,
  [
    body("name").notEmpty().isString().trim().isLength({ max: 100 }),
    body("display_name").optional().isString().trim().isLength({ max: 200 }),
    body("description").optional().isString().trim(),
    body("has_owner_restriction").optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        name,
        display_name,
        description,
        has_owner_restriction = false,
      } = req.body;
      const { rows } = await db.query(
        `INSERT INTO group_profiles (name, display_name, description, has_owner_restriction, created_by, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          name,
          display_name || name,
          description || null,
          has_owner_restriction,
          req.user.id,
          req.tenantId,
        ],
      );
      await audit.log({
        user: req.user,
        action: "group_created",
        afterState: rows[0],
        ipAddress: req.auditContext?.ipAddress,
      });
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === "23505")
        return res.status(409).json({ error: "Group name already exists" });
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// PATCH /api/groups/:id — update (admin only)
// ────────────────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAdmin,
  [
    param("id").isUUID(),
    body("display_name").optional().isString().trim().isLength({ max: 200 }),
    body("description").optional().isString().trim(),
    body("has_owner_restriction").optional().isBoolean(),
    body("is_active").optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows: before } = await db.query(
        "SELECT * FROM group_profiles WHERE id = $1 AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!before.length)
        return res.status(404).json({ error: "Group not found" });

      const allowed = [
        "display_name",
        "description",
        "has_owner_restriction",
        "is_active",
      ];
      const setClauses = [];
      const params = [];
      let p = 1;

      for (const field of allowed) {
        if (req.body[field] !== undefined) {
          setClauses.push(`${field} = $${p++}`);
          params.push(req.body[field]);
        }
      }
      if (!setClauses.length)
        return res.status(400).json({ error: "No fields to update" });
      params.push(req.params.id);
      params.push(req.tenantId);

      const { rows } = await db.query(
        `UPDATE group_profiles SET ${setClauses.join(",")} WHERE id = $${p} AND tenant_id = $${p + 1} RETURNING *`,
        params,
      );
      await audit.log({
        user: req.user,
        action: "group_updated",
        beforeState: Object.fromEntries(
          allowed
            .filter((f) => req.body[f] !== undefined)
            .map((f) => [f, before[0][f]]),
        ),
        afterState: req.body,
        metadata: { group_id: req.params.id, group_name: before[0].name },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// DELETE /api/groups/:id — deactivate (admin only)
// ────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAdmin,
  [param("id").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: docCheck } = await db.query(
        "SELECT COUNT(*) FROM documents WHERE group_id = $1 AND deleted_at IS NULL AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (parseInt(docCheck[0].count) > 0) {
        return res.status(409).json({
          error:
            "Cannot delete group with active documents. Reassign documents first.",
        });
      }

      const { rows } = await db.query(
        "UPDATE group_profiles SET is_active = FALSE WHERE id = $1 AND tenant_id = $2 RETURNING *",
        [req.params.id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Group not found" });

      await audit.log({
        user: req.user,
        action: "group_deleted",
        beforeState: rows[0],
        metadata: { group_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "Group deactivated", id: req.params.id });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
