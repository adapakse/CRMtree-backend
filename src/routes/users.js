"use strict";

const router = require("express").Router();
const { body, query, param } = require("express-validator");
const bcrypt = require("bcryptjs");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAnyUUID = (field) => field.matches(UUID_RE).withMessage('Invalid UUID');
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

const contactFieldRules = [
  body('phone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
  body('company').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
  body('department').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
];

// An external account may only take part in projects: no admin rights, no
// CRM role, no creating projects. Returns the error message or null.
function externalAccountConflict({ is_external, is_admin, crm_role, can_create_projects }) {
  if (!is_external) return null;
  if (is_admin || crm_role || can_create_projects) {
    return 'Konto zewnętrzne nie może być adminem, mieć roli CRM ani zakładać projektów';
  }
  return null;
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
    ...contactFieldRules,
    body('is_external').optional({ nullable: true }).isBoolean(),
    body('can_create_projects').optional({ nullable: true }).isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { email, first_name, last_name, is_active = true, is_admin = false, crm_role = null } = req.body;
      const { phone = null, company = null, department = null } = req.body;
      const is_external = req.body.is_external === true;
      const can_create_projects = req.body.can_create_projects === true;

      const externalConflict = externalAccountConflict({ is_external, is_admin, crm_role, can_create_projects });
      if (externalConflict) return res.status(400).json({ error: externalConflict });

      const { rows } = await db.query(
        `INSERT INTO users (email, first_name, last_name, is_active, is_admin, crm_role, tenant_id,
                            phone, company, department, is_external, can_create_projects)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, email, first_name, last_name, display_name, is_active, is_admin, crm_role, created_at,
                   phone, company, department, is_external, can_create_projects`,
        [email, first_name, last_name, is_active, is_admin, crm_role, req.tenantId,
         phone, company, department, is_external, can_create_projects]
      );

      await audit.log({
        user:       req.user,
        action:     'user_created',
        afterState: { email, first_name, last_name, is_admin, crm_role, is_external, can_create_projects },
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
    isAnyUUID(query('group_id').optional()),
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

      // tenant scoping
      conditions.push(`u.tenant_id = $${p++}`);
      params.push(req.tenantId);

      if (search) {
        conditions.push(
          `(u.email ILIKE $${p} OR u.first_name ILIKE $${p} OR u.last_name ILIKE $${p})`,
        );
        params.push(`%${search}%`);
        p++;
      }
      if (group_id) {
        conditions.push(
          `u.id IN (SELECT user_id FROM user_group_roles WHERE group_id = $${p++} AND tenant_id = $1)`,
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
                  )) FILTER (WHERE ugr.group_id IS NOT NULL) AS roles,
                  -- Correlated subquery, NIE drugi LEFT JOIN: dwa jednoczesne
                  -- LEFT JOIN-y na relacjach jeden-do-wielu mnożyłyby wiersze
                  -- przez siebie (fan-out), zawyżając agregat roles.
                  (SELECT json_agg(json_build_object(
                            'id',            g.id,
                            'target_group_id', g.target_group_id,
                            'group_name',    ggp.name,
                            'group_display', ggp.display_name,
                            'module',        g.module,
                            'access_level',  g.access_level
                          ) ORDER BY ggp.name, g.module)
                     FROM crm_visibility_grants g
                     JOIN group_profiles ggp ON ggp.id = g.target_group_id
                    WHERE g.grantee_user_id = u.id AND g.tenant_id = $1) AS visibility_grants
           FROM users u
           LEFT JOIN user_group_roles ugr ON ugr.user_id = u.id AND ugr.tenant_id = $1
           LEFT JOIN group_profiles gp ON gp.id = ugr.group_id AND gp.tenant_id = $1
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
router.get("/:id", requireAdminOrSalesManager, [isAnyUUID(param("id"))], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.*, json_agg(json_build_object(
                'role_id', ugr.id, 'group_id', ugr.group_id,
                'group_name', gp.name, 'group_display', gp.display_name,
                'access_level', ugr.access_level, 'assigned_at', ugr.assigned_at
              )) FILTER (WHERE ugr.group_id IS NOT NULL) AS roles,
              (SELECT json_agg(json_build_object(
                        'id',              g.id,
                        'target_group_id', g.target_group_id,
                        'group_name',      ggp.name,
                        'group_display',   ggp.display_name,
                        'module',          g.module,
                        'access_level',    g.access_level,
                        'granted_at',      g.granted_at,
                        'note',            g.note
                      ) ORDER BY ggp.name, g.module)
                 FROM crm_visibility_grants g
                 JOIN group_profiles ggp ON ggp.id = g.target_group_id
                WHERE g.grantee_user_id = u.id AND g.tenant_id = $2) AS visibility_grants
       FROM users u
       LEFT JOIN user_group_roles ugr ON ugr.user_id = u.id AND ugr.tenant_id = $2
       LEFT JOIN group_profiles gp ON gp.id = ugr.group_id AND gp.tenant_id = $2
       WHERE u.id = $1 AND u.tenant_id = $2
       GROUP BY u.id`,
      [req.params.id, req.tenantId],
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
    isAnyUUID(param('id')),
    body('email').optional().isEmail().normalizeEmail(),
    body('first_name').optional().isString().trim().isLength({ max: 100 }),
    body('last_name').optional().isString().trim().isLength({ max: 100 }),
    body('is_active').optional().isBoolean(),
    body('is_admin').optional().isBoolean(),
    // ★ CRM role (null = usuń rolę CRM)
    body('crm_role').optional({ nullable: true }).isIn(['salesperson', 'sales_manager', null]),
    ...contactFieldRules,
    body('is_external').optional().isBoolean(),
    body('can_create_projects').optional().isBoolean(),
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

      // Sales Manager nie może modyfikować kont adminów ani przypisywać sales_manager
      if (!req.user?.is_admin) {
        if (before[0].is_admin) {
          return res.status(403).json({ error: 'Cannot modify admin accounts' });
        }
        delete req.body.is_admin;
        delete req.body.is_external;
        delete req.body.can_create_projects;
        if (req.body.crm_role === 'sales_manager' && before[0].crm_role !== 'sales_manager') {
          return res.status(403).json({ error: 'Only admin can assign sales_manager role' });
        }
      }
      const externalConflict = externalAccountConflict({ ...before[0], ...req.body });
      if (externalConflict) return res.status(400).json({ error: externalConflict });

      const allowed = [
        'email', 'first_name', 'last_name', 'is_active', 'is_admin', 'crm_role', // ★ crm_role
        'phone', 'company', 'department', 'is_external', 'can_create_projects',
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
        `UPDATE users SET ${setClauses.join(",")} WHERE id = $${p} AND tenant_id = $${p + 1} RETURNING *`,
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
    isAnyUUID(param("id")),
    isAnyUUID(body("group_id").notEmpty()),
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
        "SELECT id, name FROM group_profiles WHERE id = $1 AND is_active = TRUE AND tenant_id = $2",
        [group_id, req.tenantId],
      );
      if (!groupRows.length)
        return res.status(404).json({ error: "Group not found" });

      const { rows } = await db.query(
        `INSERT INTO user_group_roles (user_id, group_id, access_level, assigned_by, tenant_id)
         VALUES ($1,$2,$3::access_level,$4,$5)
         ON CONFLICT (user_id, group_id) DO UPDATE SET access_level = EXCLUDED.access_level, assigned_by = EXCLUDED.assigned_by
         RETURNING *`,
        [req.params.id, group_id, access_level, req.user.id, req.tenantId],
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
// POST /api/admin/users/:id/set-password — admin sets password
// ────────────────────────────────────────────────────────────
router.post(
  "/:id/set-password",
  requireAdminOnly,
  [
    isAnyUUID(param("id")),
    body("password").isString().isLength({ min: 8 }).withMessage("Minimum 8 znaków"),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT id FROM users WHERE id = $1 AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!rows.length) return res.status(404).json({ error: "User not found" });

      const hash = await bcrypt.hash(req.body.password, 12);
      await db.query(
        "UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2",
        [hash, req.params.id],
      );

      await audit.log({
        user: req.user,
        action: "user_password_set",
        metadata: { target_user_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:id — delete user
// ────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAdminOnly,
  [isAnyUUID(param("id"))],
  validate,
  async (req, res, next) => {
    try {
      if (req.params.id === req.user.id)
        return res.status(400).json({ error: "Cannot delete your own account" });

      const { rows } = await db.query(
        "DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING id, email, display_name",
        [req.params.id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "User not found" });

      await audit.log({
        user: req.user,
        action: "user_deleted",
        beforeState: rows[0],
        metadata: { target_user_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "User deleted", id: req.params.id });
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
  [isAnyUUID(param("id")), isAnyUUID(param("roleId"))],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `DELETE FROM user_group_roles
         WHERE id = $1 AND user_id = $2 AND tenant_id = $3
         RETURNING *, (SELECT name FROM group_profiles WHERE id = group_id AND tenant_id = $3) AS group_name`,
        [req.params.roleId, req.params.id, req.tenantId],
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

// ────────────────────────────────────────────────────────────
// GET /api/admin/users/:id/visibility-grants — granty widoczności CRM
// ────────────────────────────────────────────────────────────
router.get(
  "/:id/visibility-grants",
  requireAdminOnly,
  [isAnyUUID(param("id"))],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT g.id, g.target_group_id, g.module, g.access_level, g.granted_at, g.note,
                gp.name AS group_name, gp.display_name AS group_display
           FROM crm_visibility_grants g
           JOIN group_profiles gp ON gp.id = g.target_group_id
          WHERE g.grantee_user_id = $1 AND g.tenant_id = $2
          ORDER BY gp.name, g.module`,
        [req.params.id, req.tenantId],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// POST /api/admin/users/:id/visibility-grants — nadaj grant
// ────────────────────────────────────────────────────────────
router.post(
  "/:id/visibility-grants",
  requireAdminOnly,
  [
    isAnyUUID(param("id")),
    isAnyUUID(body("target_group_id").notEmpty()),
    body("module").notEmpty().isIn(["leads", "partners"]),
    body("access_level").notEmpty().isIn(["read", "full"]),
    body("note").optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { target_group_id, module, access_level, note = null } = req.body;

      const { rows: userRows } = await db.query(
        "SELECT id FROM users WHERE id = $1 AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!userRows.length) return res.status(404).json({ error: "User not found" });

      // Grant na własną grupę grantee'a jest dozwolony celowo — salesperson nie
      // widzi automatycznie rekordów innych członków swojej grupy, więc grant
      // 'full' na własną grupę podnosi jego widoczność do poziomu zespołu bez
      // zmiany roli CRM na managera.
      const { rows: groupRows } = await db.query(
        "SELECT id, name, display_name FROM group_profiles WHERE id = $1 AND is_active = TRUE AND tenant_id = $2",
        [target_group_id, req.tenantId],
      );
      if (!groupRows.length) return res.status(404).json({ error: "Group not found" });

      const { rows } = await db.query(
        `INSERT INTO crm_visibility_grants
           (tenant_id, grantee_user_id, target_group_id, module, access_level, granted_by, note)
         VALUES ($1, $2, $3, $4, $5::access_level, $6, $7)
         ON CONFLICT (grantee_user_id, target_group_id, module)
           DO UPDATE SET access_level = EXCLUDED.access_level,
                         granted_by   = EXCLUDED.granted_by,
                         granted_at   = NOW(),
                         note         = EXCLUDED.note
         RETURNING id, target_group_id, module, access_level, granted_at, note`,
        [req.tenantId, req.params.id, target_group_id, module, access_level, req.user.id, note],
      );

      await audit.log({
        user: req.user,
        action: "crm_visibility_grant_create",
        afterState: {
          grantee_user_id: req.params.id,
          target_group_id,
          group_name: groupRows[0].name,
          module,
          access_level,
        },
        metadata: { target_user_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });

      res.status(201).json({
        ...rows[0],
        group_name: groupRows[0].name,
        group_display: groupRows[0].display_name,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:id/visibility-grants/:grantId
// ────────────────────────────────────────────────────────────
router.delete(
  "/:id/visibility-grants/:grantId",
  requireAdminOnly,
  [isAnyUUID(param("id")), isAnyUUID(param("grantId"))],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `DELETE FROM crm_visibility_grants
          WHERE id = $1 AND grantee_user_id = $2 AND tenant_id = $3
          RETURNING target_group_id, module, access_level,
                    (SELECT name FROM group_profiles WHERE id = target_group_id) AS group_name`,
        [req.params.grantId, req.params.id, req.tenantId],
      );
      if (!rows.length) return res.status(404).json({ error: "Visibility grant not found" });

      await audit.log({
        user: req.user,
        action: "crm_visibility_grant_revoke",
        beforeState: { grantee_user_id: req.params.id, ...rows[0] },
        metadata: { target_user_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "Visibility grant removed", id: req.params.grantId });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
