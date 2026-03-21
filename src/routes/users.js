"use strict";

const router = require("express").Router();
const { body, query, param } = require("express-validator");
const db = require("../config/database");
const audit = require("../services/auditService");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate, injectAuditContext } = require("../middleware/errorHandler");

router.use(requireAuth, injectAuditContext);

// Middleware: admin LUB sales_manager
function requireAdminOrSalesManager(req, res, next) {
  if (req.user?.is_admin || req.user?.crm_role === 'sales_manager') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// Middleware: tylko admin (dla operacji tworzenia/usuwania userów i zmiany is_admin)
function requireAdminOnly(req, res, next) {
  if (req.user?.is_admin) return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// ────────────────────────────────────────────────────────────
// POST /api/admin/users — create user manually
// ────────────────────────────────────────────────────────────
router.post(
  "/",
  requireAdminOnly,
  [
    body('email').notEmpty().isEmail().normalizeEmail(),
    body('first_name').notEmpty().isString().trim().isLength({ max: 100 }),
    body('last_name').notEmpty().isString().trim().isLength({ max: 100 }),
    body('is_active').optional({ nullable: true }).isBoolean(),
    body('is_admin').optional({ nullable: true }).isBoolean(),
    // ★ CRM role
    body('crm_role').optional({ nullable: true }).isIn(['salesperson', 'sales_manager']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { email, first_name, last_name, is_active = true, is_admin = false, crm_role = null } = req.body;

      const { rows } = await db.query(
        `INSERT INTO users (email, first_name, last_name, is_active, is_admin, crm_role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, first_name, last_name, display_name, is_active, is_admin, crm_role, created_at`,
        [email, first_name, last_name, is_active, is_admin, crm_role]
      );

      await audit.log({
        user:       req.user,
        action:     'user_created',
        afterState: { email, first_name, last_name, is_admin, crm_role },
        ipAddress:  req.auditContext?.ipAddress,
      });

      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === "23505") {
        return res
          .status(409)
          .json({ error: "User with this email already exists" });
      }
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/admin/users — list all users
// ────────────────────────────────────────────────────────────
router.get(
  "/",
  requireAdminOrSalesManager,
  [
    query('search').optional().isString().trim(),
    query('group_id').optional().isUUID(),
    query('is_active').optional().isBoolean().toBoolean(),
    // ★ filtr po roli CRM
    query('crm_role').optional().isIn(['salesperson', 'sales_manager']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { search, group_id, is_active, crm_role, page = 1, limit = 50 } = req.query;
      const conditions = [];
      const params = [];
      let p = 1;

      if (search) {
        conditions.push(
          `(u.email ILIKE $${p} OR u.first_name ILIKE $${p} OR u.last_name ILIKE $${p})`,
        );
        params.push(`%${search}%`);
        p++;
      }
      if (group_id) {
        conditions.push(
          `u.id IN (SELECT user_id FROM user_group_roles WHERE group_id = $${p++})`,
        );
        params.push(group_id);
      }
      if (is_active !== undefined) {
        conditions.push(`u.is_active = $${p++}`);
        params.push(is_active);
      }
      // ★ filtr CRM
      if (crm_role) {
        conditions.push(`u.crm_role = $${p++}`);
        params.push(crm_role);
      }

      const where = conditions.length
        ? "WHERE " + conditions.join(" AND ")
        : "";
      const offset = (page - 1) * limit;

      const [data, count] = await Promise.all([
        db.query(
          `SELECT u.id, u.email, u.first_name, u.last_name, u.display_name,
                  u.is_admin, u.is_active, u.crm_role, u.last_login_at, u.created_at,
                  json_agg(json_build_object(
                    'role_id',     ugr.id,
                    'group_id',    ugr.group_id,
                    'group_name',  gp.name,
                    'group_display', gp.display_name,
                    'access_level', ugr.access_level
                  )) FILTER (WHERE ugr.group_id IS NOT NULL) AS roles
           FROM users u
           LEFT JOIN user_group_roles ugr ON ugr.user_id = u.id
           LEFT JOIN group_profiles gp ON gp.id = ugr.group_id
           ${where}
           GROUP BY u.id
           ORDER BY u.last_name, u.first_name
           LIMIT $${p} OFFSET $${p + 1}`,
          [...params, limit, offset],
        ),
        db.query(`SELECT COUNT(*) FROM users u ${where}`, params),
      ]);

      res.json({
        data: data.rows,
        total: parseInt(count.rows[0].count),
        page,
        limit,
        pages: Math.ceil(parseInt(count.rows[0].count) / limit),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/admin/users/:id
// ────────────────────────────────────────────────────────────
router.get("/:id", requireAdminOrSalesManager, [param("id").isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.*, json_agg(json_build_object(
                'role_id', ugr.id, 'group_id', ugr.group_id,
                'group_name', gp.name, 'group_display', gp.display_name,
                'access_level', ugr.access_level, 'assigned_at', ugr.assigned_at
              )) FILTER (WHERE ugr.group_id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_group_roles ugr ON ugr.user_id = u.id
       LEFT JOIN group_profiles gp ON gp.id = ugr.group_id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id — update user
// ────────────────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAdminOrSalesManager,
  [
    param('id').isUUID(),
    body('email').optional().isEmail().normalizeEmail(),
    body('first_name').optional().isString().trim().isLength({ max: 100 }),
    body('last_name').optional().isString().trim().isLength({ max: 100 }),
    body('is_active').optional().isBoolean(),
    body('is_admin').optional().isBoolean(),
    // ★ CRM role (null = usuń rolę CRM)
    body('crm_role').optional({ nullable: true }).isIn(['salesperson', 'sales_manager', null]),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows: before } = await db.query(
        "SELECT * FROM users WHERE id = $1",
        [req.params.id],
      );
      if (!before.length)
        return res.status(404).json({ error: "User not found" });

      // Sales Manager nie może zmieniać is_admin ani przypisywać innych sales_manager
      if (!req.user?.is_admin) {
        delete req.body.is_admin;
        if (req.body.crm_role === 'sales_manager' && before[0].crm_role !== 'sales_manager') {
          return res.status(403).json({ error: 'Only admin can assign sales_manager role' });
        }
      }
      const allowed = ['email', 'first_name', 'last_name', 'is_active', 'is_admin', 'crm_role']; // ★ crm_role
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

      const { rows } = await db.query(
        `UPDATE users SET ${setClauses.join(",")} WHERE id = $${p} RETURNING *`,
        params,
      );

      await audit.log({
        user: req.user,
        action: "user_updated",
        beforeState: Object.fromEntries(
          allowed
            .filter((f) => req.body[f] !== undefined)
            .map((f) => [f, before[0][f]]),
        ),
        afterState: req.body,
        metadata: { target_user_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });

      res.json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'User with this email already exists' });
      }
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// POST /api/admin/users/:id/roles — assign role to user
// ────────────────────────────────────────────────────────────
router.post(
  "/:id/roles",
  requireAdminOrSalesManager,
  [
    param("id").isUUID(),
    body("group_id").notEmpty().isUUID(),
    body("access_level").notEmpty().isIn(["read", "full"]),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { group_id, access_level } = req.body;

      const { rows: userRows } = await db.query(
        "SELECT id FROM users WHERE id = $1",
        [req.params.id],
      );
      if (!userRows.length)
        return res.status(404).json({ error: "User not found" });

      const { rows: groupRows } = await db.query(
        "SELECT id, name FROM group_profiles WHERE id = $1 AND is_active = TRUE",
        [group_id],
      );
      if (!groupRows.length)
        return res.status(404).json({ error: "Group not found" });

      const { rows } = await db.query(
        `INSERT INTO user_group_roles (user_id, group_id, access_level, assigned_by)
         VALUES ($1,$2,$3::access_level,$4)
         ON CONFLICT (user_id, group_id) DO UPDATE SET access_level = EXCLUDED.access_level, assigned_by = EXCLUDED.assigned_by
         RETURNING *`,
        [req.params.id, group_id, access_level, req.user.id],
      );

      await audit.log({
        user: req.user,
        action: "role_assigned",
        afterState: {
          user_id: req.params.id,
          group_id,
          access_level,
          group_name: groupRows[0].name,
        },
        metadata: { target_user_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:id/roles/:roleId — remove role
// ────────────────────────────────────────────────────────────
router.delete(
  "/:id/roles/:roleId",
  requireAdminOnly,
  [param("id").isUUID(), param("roleId").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `DELETE FROM user_group_roles
         WHERE id = $1 AND user_id = $2
         RETURNING *, (SELECT name FROM group_profiles WHERE id = group_id) AS group_name`,
        [req.params.roleId, req.params.id],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Role assignment not found" });

      await audit.log({
        user: req.user,
        action: "role_removed",
        beforeState: {
          user_id: req.params.id,
          group_id: rows[0].group_id,
          access_level: rows[0].access_level,
          group_name: rows[0].group_name,
        },
        metadata: { target_user_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "Role removed", id: req.params.roleId });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
