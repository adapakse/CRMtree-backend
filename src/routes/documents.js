"use strict";

const router = require("express").Router();
const { body, query, param } = require("express-validator");
const db = require("../config/database");
const audit = require("../services/auditService");
const storage = require("../services/storageService");
const perms = require("../services/permissionService");
const email = require("../services/emailService");
const { requireAuth } = require("../middleware/auth");
const { validate, injectAuditContext } = require("../middleware/errorHandler");
const upload = require("../middleware/upload");

// All document routes require authentication
router.use(requireAuth, injectAuditContext);

// ── Helper: check if user has active task on a document ──
async function getTaskAccess(userId, documentId) {
  const { rows } = await db.query(
    `SELECT task_type FROM workflow_tasks
     WHERE document_id = $1 AND assigned_to = $2
       AND task_status IN ('pending','in_progress')
     ORDER BY created_at DESC LIMIT 1`,
    [documentId, userId],
  );
  if (!rows.length) return null;
  // edit/sign tasks grant full (edit metadata) access; read/approve grant read-only
  return ["edit", "sign"].includes(rows[0].task_type) ? "full" : "read";
}

// ────────────────────────────────────────────────────────────
// GET /api/documents — list with filtering & search
// ────────────────────────────────────────────────────────────
router.get(
  "/",
  [
    query("search").optional().isString().trim(),
    query("status").optional().isString(),
    query("doc_type").optional().isString(),
    query("group_id").optional().isUUID(),
    query("gdpr_type").optional().isString(),
    query("owner_id").optional().isUUID(),
    query("document_group_id").optional().isUUID(),
    query("expiry_before").optional().isISO8601(),
    query("expiry_after").optional().isISO8601(),
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("sort")
      .optional()
      .isIn(["created_at", "name", "doc_number", "status", "expiration_date"]),
    query("order").optional().isIn(["asc", "desc"]),
    query("no_files").optional().isIn(["true", "false"]),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        search,
        status,
        doc_type,
        group_id,
        gdpr_type,
        owner_id,
        document_group_id,
        expiry_before,
        expiry_after,
        no_files,
        page = 1,
        limit = 50,
        sort = "created_at",
        order = "desc",
      } = req.query;

      let conditions, params, p;

      if (req.user.is_admin) {
        // Admins see everything (still scoped to tenant)
        conditions = [`d.deleted_at IS NULL`, `d.tenant_id = $1`];
        params = [req.tenantId];
        p = 2;
      } else {
        // Build group-based visibility, then extend with task-based access
        const vis = await perms.buildVisibilityFilter(req.user.id);
        const taskParamIdx = vis.nextParamAt;
        // OR: user has an active (pending/in_progress) task on the document
        const extendedVis = `(
          ${vis.sql}
          OR d.id IN (
            SELECT document_id FROM workflow_tasks
            WHERE assigned_to = $${taskParamIdx}
              AND task_status IN ('pending','in_progress')
          )
        )`;
        conditions = [`d.deleted_at IS NULL`, extendedVis];
        params = [...vis.params, req.user.id];
        p = vis.nextParamAt + 1;
        // tenant scope
        conditions.push(`d.tenant_id = $${p++}`);
        params.push(req.tenantId);
      }

      if (search) {
        conditions.push(`(
          to_tsvector('simple', coalesce(d.doc_number,'') || ' ' || coalesce(d.name,'') || ' ' || coalesce(array_to_string(d.entities,' '),''))
          @@ plainto_tsquery('simple', $${p})
          OR d.name ILIKE $${p + 1}
          OR d.doc_number ILIKE $${p + 1}
          OR EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND (dt.key ILIKE $${p + 1} OR dt.value ILIKE $${p + 1}))
        )`);
        params.push(search, `%${search}%`);
        p += 2;
      }
      if (status) {
        conditions.push(`d.status = $${p++}::doc_status`);
        params.push(status);
      }
      if (doc_type) {
        conditions.push(`d.doc_type = $${p++}`);
        params.push(doc_type);
      }
      if (group_id) {
        conditions.push(`d.group_id = $${p++}`);
        params.push(group_id);
      }
      if (gdpr_type) {
        conditions.push(`d.gdpr_type = $${p++}::gdpr_type`);
        params.push(gdpr_type);
      }
      if (owner_id) {
        conditions.push(`d.owner_id = $${p++}`);
        params.push(owner_id);
      }
      if (document_group_id) {
        conditions.push(`d.document_group_id = $${p++}`);
        params.push(document_group_id);
      }
      if (expiry_before) {
        conditions.push(`d.expiration_date <= $${p++}`);
        params.push(expiry_before);
      }
      if (expiry_after) {
        conditions.push(`d.expiration_date >= $${p++}`);
        params.push(expiry_after);
      }
      if (no_files === "true") {
        conditions.push(`NOT EXISTS (SELECT 1 FROM document_versions dv WHERE dv.document_id = d.id)`);
      }

      const where = "WHERE " + conditions.join(" AND ");
      const offset = (page - 1) * limit;
      const sortCol = [
        "created_at",
        "name",
        "doc_number",
        "status",
        "expiration_date",
      ].includes(sort)
        ? sort
        : "created_at";
      const sortDir = order === "asc" ? "ASC" : "DESC";

      const [dataResult, countResult] = await Promise.all([
        db.query(
          `SELECT
             d.id, d.doc_number, d.name, d.doc_type, d.gdpr_type, d.status,
             d.entities, d.creation_date, d.signing_date, d.expiration_date,
             d.nip, d.country, d.contract_subject,
             d.contact_name, d.contact_email, d.contact_phone,
             d.blob_name, d.blob_size_bytes, d.created_at, d.updated_at,
             d.group_id, gp.name AS group_name, gp.display_name AS group_display,
             d.owner_id, u.display_name AS owner_name, u.email AS owner_email,
             d.document_group_id, dg.name AS document_group_name,
             d.signus_envelope_id,
             (SELECT json_agg(json_build_object('id',dt.id,'key',dt.key,'value',dt.value))
              FROM document_tags dt WHERE dt.document_id = d.id) AS tags,
             (SELECT COUNT(*) FROM document_versions dv WHERE dv.document_id = d.id) AS version_count,
             EXISTS (
               SELECT 1 FROM crm_partner_documents cpd WHERE cpd.document_id = d.id
             ) AS has_partner,
             (SELECT COUNT(*)
              FROM workflow_tasks wt
              WHERE wt.document_id = d.id
                AND wt.task_status IN ('pending','in_progress')) AS active_tasks,
             (SELECT json_agg(json_build_object(
               'id',          wt.id,
               'task_type',   wt.task_type,
               'task_status', wt.task_status,
               'assigned_to', wt.assigned_to,
               'assignee_name', au.display_name,
               'assigner_name', ab.display_name,
               'due_date',    wt.due_date,
               'message',     wt.message
             ) ORDER BY wt.created_at)
              FROM workflow_tasks wt
              LEFT JOIN users au ON au.id = wt.assigned_to
              LEFT JOIN users ab ON ab.id = wt.assigned_by
              WHERE wt.document_id = d.id
                AND wt.task_status IN ('pending','in_progress')) AS active_task_details
           FROM documents d
           LEFT JOIN group_profiles gp  ON gp.id  = d.group_id
           LEFT JOIN users u            ON u.id   = d.owner_id
           LEFT JOIN document_groups dg ON dg.id  = d.document_group_id
           ${where}
           ORDER BY d.${sortCol} ${sortDir} NULLS LAST
           LIMIT $${p} OFFSET $${p + 1}`,
          [...params, limit, offset],
        ),
        db.query(`SELECT COUNT(*) FROM documents d ${where}`, params),
      ]);

      res.json({
        data: dataResult.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        limit,
        pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// POST /api/documents — create new document + upload file
// ────────────────────────────────────────────────────────────
router.post(
  "/",
  upload.single("file"),
  [
    body("name").notEmpty().isString().trim().isLength({ max: 500 }),
    body("doc_type").notEmpty().isString().trim(),
    body("gdpr_type").notEmpty().isString().trim(),
    body("group_id").notEmpty().isUUID(),
    body("entities").optional().isArray(),
    body("owner_id").optional().isUUID(),
    body("document_group_id").optional().isUUID(),
    body("expiration_date").optional().isISO8601(),
    body("signing_date").optional().isISO8601(),
    body("nip").optional({ nullable: true }).isString().trim().isLength({ max: 15 }),
    body("country").optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
    body("contract_subject").optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
    body("contact_name").optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
    body("contact_email").optional({ nullable: true }).isEmail().normalizeEmail(),
    body("contact_phone").optional({ nullable: true }).isString().trim().isLength({ max: 50 }),
    body("tags").optional().isArray(),
    body("tags.*.key").optional().isString().trim(),
    body("tags.*.value").optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const canCreate = await perms.canCreateDocuments(req.user.id);
      if (!canCreate) {
        return res
          .status(403)
          .json({
            error:
              "Full access to at least one group is required to create documents",
          });
      }

      const {
        name,
        doc_type,
        gdpr_type,
        group_id,
        entities = [],
        owner_id,
        document_group_id,
        expiration_date,
        signing_date,
        nip,
        country,
        contract_subject,
        contact_name,
        contact_email,
        contact_phone,
        tags = [],
      } = req.body;

      const ownerId = owner_id || req.user.id;

      await db.transaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO documents
             (tenant_id, name, doc_type, gdpr_type, group_id, entities, owner_id,
              document_group_id, expiration_date, signing_date, created_by,
              nip, country, contract_subject, contact_name, contact_email, contact_phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING *`,
          [
            req.tenantId,
            name,
            doc_type,
            gdpr_type,
            group_id,
            entities,
            ownerId,
            document_group_id || null,
            expiration_date || null,
            signing_date || null,
            req.user.id,
            nip || null,
            country || null,
            contract_subject || null,
            contact_name || null,
            contact_email || null,
            contact_phone || null,
          ],
        );
        const doc = rows[0];

        let blobResult = null;
        if (req.file) {
          blobResult = await storage.uploadDocument(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
            doc.id,
            1,
          );
          await client.query(
            `UPDATE documents SET blob_path=$1, blob_name=$2, blob_size_bytes=$3, mime_type=$4 WHERE id=$5 AND tenant_id=$6`,
            [
              blobResult.blobPath,
              blobResult.blobName,
              blobResult.blobSizeBytes,
              req.file.mimetype,
              doc.id,
              req.tenantId,
            ],
          );
          await client.query(
            `INSERT INTO document_versions
               (document_id, version_number, label, blob_path, blob_name, blob_size_bytes, mime_type, created_by, tenant_id)
             VALUES ($1, 1, 'Original upload', $2, $3, $4, $5, $6, $7)`,
            [
              doc.id,
              blobResult.blobPath,
              blobResult.blobName,
              blobResult.blobSizeBytes,
              req.file.mimetype,
              req.user.id,
              req.tenantId,
            ],
          );
        }

        for (const tag of tags) {
          if (tag.key && tag.value) {
            await client.query(
              `INSERT INTO document_tags (document_id, key, value, created_by)
               VALUES ($1,$2,$3,$4) ON CONFLICT (document_id, key) DO UPDATE SET value = EXCLUDED.value`,
              [doc.id, tag.key.trim(), tag.value.trim(), req.user.id],
            );
          }
        }

        await audit.log({
          user: req.user,
          document: doc,
          action: "document_created",
          afterState: {
            name,
            doc_type,
            gdpr_type,
            group_id,
            entities,
            owner_id: ownerId,
          },
          ipAddress: req.auditContext?.ipAddress,
          userAgent: req.auditContext?.userAgent,
          client,
        });

        const { rows: full } = await client.query(
          `SELECT d.*, gp.name AS group_name, u.display_name AS owner_name
           FROM documents d
           LEFT JOIN group_profiles gp ON gp.id = d.group_id
           LEFT JOIN users u ON u.id = d.owner_id
           WHERE d.id = $1 AND d.tenant_id = $2`,
          [doc.id, req.tenantId],
        );
        res.status(201).json(full[0]);
      });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/documents/:id — get single document
// ────────────────────────────────────────────────────────────
router.get("/:id", [param("id").isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT d.*,
              gp.name AS group_name, gp.display_name AS group_display, gp.has_owner_restriction,
              u.display_name AS owner_name, u.email AS owner_email,
              dg.name AS document_group_name,
              (SELECT json_agg(json_build_object('id',dt.id,'key',dt.key,'value',dt.value,'created_at',dt.created_at) ORDER BY dt.key)
               FROM document_tags dt WHERE dt.document_id = d.id) AS tags,
              (SELECT json_agg(json_build_object(
                'id',dv.id,'version_number',dv.version_number,'label',dv.label,
                'is_signed',dv.is_signed,'blob_size_bytes',dv.blob_size_bytes,
                'mime_type',dv.mime_type,'signatory_name',dv.signatory_name,
                'signatory_email',dv.signatory_email,'created_at',dv.created_at) ORDER BY dv.version_number)
               FROM document_versions dv WHERE dv.document_id = d.id) AS versions,
              (SELECT json_agg(json_build_object(
                'id',wt.id,'task_type',wt.task_type,'task_status',wt.task_status,
                'assigned_to',wt.assigned_to,'assignee_name',au.display_name,
                'message',wt.message,'due_date',wt.due_date,'created_at',wt.created_at,
                'completed_at',wt.completed_at) ORDER BY wt.created_at)
               FROM workflow_tasks wt
               LEFT JOIN users au ON au.id = wt.assigned_to
               WHERE wt.document_id = d.id) AS workflow_tasks
       FROM documents d
       LEFT JOIN group_profiles gp  ON gp.id  = d.group_id
       LEFT JOIN users u            ON u.id   = d.owner_id
       LEFT JOIN document_groups dg ON dg.id  = d.document_group_id
       WHERE d.id = $1 AND d.deleted_at IS NULL AND d.tenant_id = $2`,
      [req.params.id, req.tenantId],
    );
    if (!rows.length)
      return res.status(404).json({ error: "Document not found" });
    const doc = rows[0];

    // Check group-based access first, then task-based fallback
    const groupCanRead =
      req.user.is_admin || (await perms.canRead(req.user.id, doc));
    let taskAccess = null;
    if (!groupCanRead) {
      taskAccess = await getTaskAccess(req.user.id, doc.id);
      if (!taskAccess) return res.status(403).json({ error: "Access denied" });
    }

    await audit.log({
      user: req.user,
      document: doc,
      action: "document_viewed",
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });

    // Determine final access level
    let accessLevel = "read";
    if (req.user.is_admin || (await perms.canFull(req.user.id, doc))) {
      accessLevel = "full";
    } else if (taskAccess === "full") {
      accessLevel = "full";
    }

    res.json({
      ...doc,
      _access: accessLevel,
      _task_access: !groupCanRead && !!taskAccess,
    });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────
// PATCH /api/documents/:id — update metadata / status
// ────────────────────────────────────────────────────────────
router.patch(
  "/:id",
  [
    param("id").isUUID(),
    body("name").optional().isString().trim().isLength({ max: 500 }),
    body("doc_type").optional().isString().trim(),
    body("gdpr_type").optional().isString().trim(),
    body("status").optional().isString().trim(),
    body("entities").optional().isArray(),
    body("owner_id").optional().isUUID(),
    body("group_id").optional().isUUID(),
    body("document_group_id").optional().isUUID(),
    body("expiration_date").optional({ nullable: true }).isISO8601(),
    body("signing_date").optional({ nullable: true }).isISO8601(),
    body("nip").optional({ nullable: true }).isString().trim().isLength({ max: 15 }),
    body("country").optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
    body("contract_subject").optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
    body("contact_name").optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
    body("contact_email").optional({ nullable: true }).isEmail().normalizeEmail(),
    body("contact_phone").optional({ nullable: true }).isString().trim().isLength({ max: 50 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows: docRows } = await db.query(
        "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!docRows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = docRows[0];

      // Check full access: group-based OR active edit/sign task
      const groupCanFull =
        req.user.is_admin || (await perms.canFull(req.user.id, doc));
      if (!groupCanFull) {
        const taskAccess = await getTaskAccess(req.user.id, doc.id);
        if (taskAccess !== "full") {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      const allowed = [
        "name",
        "doc_type",
        "gdpr_type",
        "status",
        "entities",
        "owner_id",
        "group_id",
        "document_group_id",
        "expiration_date",
        "signing_date",
        "nip",
        "country",
        "contract_subject",
        "contact_name",
        "contact_email",
        "contact_phone",
      ];
      const updates = {};
      const setClauses = [];
      const params = [];
      let p = 1;

      for (const field of allowed) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
          if (field === "status")
            setClauses.push(`status = $${p++}::doc_status`);
          else setClauses.push(`${field} = $${p++}`);
          params.push(req.body[field] === "" ? null : req.body[field]);
        }
      }

      if (setClauses.length === 0)
        return res.status(400).json({ error: "No fields to update" });
      params.push(req.params.id, req.tenantId);

      const { rows: updated } = await db.query(
        `UPDATE documents SET ${setClauses.join(", ")} WHERE id = $${p} AND tenant_id = $${p + 1} RETURNING *`,
        params,
      );

      const changedFields = Object.keys(updates);
      const isStatusChange = changedFields.includes("status");

      await audit.log({
        user: req.user,
        document: updated[0],
        action: isStatusChange ? "status_changed" : "metadata_updated",
        beforeState: Object.fromEntries(changedFields.map((f) => [f, doc[f]])),
        afterState: updates,
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });

      res.json(updated[0]);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// DELETE /api/documents/:id — soft delete (group full access only)
// ────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  [param("id").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = rows[0];

      // Delete requires proper group full access — task-based access is not enough
      await perms.assertCanFull(req.user.id, doc);

      await db.query(
        `UPDATE documents SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3`,
        [req.user.id, doc.id, req.tenantId],
      );

      await audit.log({
        user: req.user,
        document: doc,
        action: "document_deleted",
        beforeState: { id: doc.id, name: doc.name, status: doc.status },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });

      res.json({ message: "Document deleted", id: doc.id });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// POST /api/documents/:id/file — upload new version
// ────────────────────────────────────────────────────────────
router.post(
  "/:id/file",
  upload.single("file"),
  [param("id").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const { rows } = await db.query(
        "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = rows[0];

      // Allow upload if user has group full access OR active edit/sign task
      const groupCanFull =
        req.user.is_admin || (await perms.canFull(req.user.id, doc));
      if (!groupCanFull) {
        const taskAccess = await getTaskAccess(req.user.id, doc.id);
        if (taskAccess !== "full")
          return res.status(403).json({ error: "Access denied" });
      }

      const { rows: vRows } = await db.query(
        "SELECT COALESCE(MAX(version_number),0) AS max_v FROM document_versions WHERE document_id = $1",
        [doc.id],
      );
      const nextVer = parseInt(vRows[0].max_v) + 1;
      const blobResult = await storage.uploadDocument(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        doc.id,
        nextVer,
      );

      await db.transaction(async (client) => {
        await client.query(
          `INSERT INTO document_versions
             (document_id, version_number, label, blob_path, blob_name, blob_size_bytes, mime_type, created_by, tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            doc.id,
            nextVer,
            req.body.label || `Version ${nextVer}`,
            blobResult.blobPath,
            blobResult.blobName,
            blobResult.blobSizeBytes,
            req.file.mimetype,
            req.user.id,
            req.tenantId,
          ],
        );
        await client.query(
          `UPDATE documents SET blob_path=$1, blob_name=$2, blob_size_bytes=$3, mime_type=$4 WHERE id=$5 AND tenant_id=$6`,
          [
            blobResult.blobPath,
            blobResult.blobName,
            blobResult.blobSizeBytes,
            req.file.mimetype,
            doc.id,
            req.tenantId,
          ],
        );
        await audit.log({
          user: req.user,
          document: doc,
          action: "version_uploaded",
          afterState: { version: nextVer, fileName: req.file.originalname },
          ipAddress: req.auditContext?.ipAddress,
          client,
        });
      });

      res.status(201).json({ message: "File uploaded", version: nextVer });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/documents/:id/preview — stream PDF (read access)
// ────────────────────────────────────────────────────────────
router.get(
  "/:id/preview",
  [param("id").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = rows[0];
      if (!doc.blob_path)
        return res.status(404).json({ error: "No file attached" });

      // Allow preview if user has any access: group read OR any active task
      const groupCanRead =
        req.user.is_admin || (await perms.canRead(req.user.id, doc));
      if (!groupCanRead) {
        const taskAccess = await getTaskAccess(req.user.id, doc.id);
        if (!taskAccess)
          return res.status(403).json({ error: "Access denied" });
      }

      const { buffer, contentType } = await storage.downloadDocument(
        doc.blob_path,
      );
      res.set({
        "Content-Type": contentType || "application/pdf",
        "Content-Disposition": `inline; filename="${encodeURIComponent(doc.blob_name || "document.pdf")}"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      });
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/documents/:id/download — download (full access)
// ────────────────────────────────────────────────────────────
router.get(
  "/:id/download",
  [param("id").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = rows[0];
      if (!doc.blob_path)
        return res.status(404).json({ error: "No file attached" });

      // Allow download if user has full access: group OR active edit/sign task
      const groupCanFull =
        req.user.is_admin || (await perms.canFull(req.user.id, doc));
      if (!groupCanFull) {
        const taskAccess = await getTaskAccess(req.user.id, doc.id);
        if (taskAccess !== "full")
          return res.status(403).json({ error: "Access denied" });
      }

      const { buffer, contentType } = await storage.downloadDocument(
        doc.blob_path,
      );
      res.set({
        "Content-Type": contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(doc.blob_name || doc.doc_number + ".pdf")}"`,
      });

      await audit.log({
        user: req.user,
        document: doc,
        action: "document_downloaded",
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });

      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/documents/:id/versions/:versionId/preview
// ────────────────────────────────────────────────────────────
router.get(
  "/:id/versions/:versionId/preview",
  [param("id").isUUID(), param("versionId").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: docRows } = await db.query(
        "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!docRows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = docRows[0];

      const groupCanRead =
        req.user.is_admin || (await perms.canRead(req.user.id, doc));
      if (!groupCanRead) {
        const taskAccess = await getTaskAccess(req.user.id, doc.id);
        if (!taskAccess)
          return res.status(403).json({ error: "Access denied" });
      }

      const { rows: verRows } = await db.query(
        "SELECT * FROM document_versions WHERE id = $1 AND document_id = $2",
        [req.params.versionId, req.params.id],
      );
      if (!verRows.length)
        return res.status(404).json({ error: "Version not found" });

      const { buffer, contentType } = await storage.downloadDocument(
        verRows[0].blob_path,
      );
      res.set({
        "Content-Type": contentType || "application/pdf",
        "Content-Disposition": `inline; filename="${encodeURIComponent(verRows[0].blob_name || "version.pdf")}"`,
        "Cache-Control": "private, max-age=300",
      });
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/documents/:id/versions/:versionId/download
// ────────────────────────────────────────────────────────────
router.get(
  "/:id/versions/:versionId/download",
  [param("id").isUUID(), param("versionId").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: docRows } = await db.query(
        "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!docRows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = docRows[0];

      const groupCanFull =
        req.user.is_admin || (await perms.canFull(req.user.id, doc));
      if (!groupCanFull) {
        const taskAccess = await getTaskAccess(req.user.id, doc.id);
        if (taskAccess !== "full")
          return res.status(403).json({ error: "Access denied" });
      }

      const { rows: verRows } = await db.query(
        "SELECT * FROM document_versions WHERE id = $1 AND document_id = $2",
        [req.params.versionId, req.params.id],
      );
      if (!verRows.length)
        return res.status(404).json({ error: "Version not found" });

      const { buffer, contentType } = await storage.downloadDocument(
        verRows[0].blob_path,
      );
      res.set({
        "Content-Type": contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(verRows[0].blob_name || "version.pdf")}"`,
      });
      await audit.log({
        user: req.user,
        document: doc,
        action: "document_downloaded",
        metadata: {
          version_id: verRows[0].id,
          version_number: verRows[0].version_number,
        },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// GET /api/documents/:id/history
// ────────────────────────────────────────────────────────────
router.get(
  "/:id/history",
  [param("id").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: docRows } = await db.query(
        `SELECT d.*, ugr.access_level AS _access
         FROM documents d
         LEFT JOIN user_group_roles ugr ON ugr.group_id = d.group_id AND ugr.user_id = $2
         WHERE d.id = $1 AND d.deleted_at IS NULL AND d.tenant_id = $3`,
        [req.params.id, req.user.id, req.tenantId],
      );
      if (!docRows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = docRows[0];

      // Allow history if group access OR active task
      const access = req.user.is_admin ? "full" : doc._access;
      if (!access) {
        const taskAccess = await getTaskAccess(req.user.id, doc.id);
        if (!taskAccess)
          return res.status(403).json({ error: "Access denied" });
      }

      const { rows } = await db.query(
        `SELECT id, action, user_name, user_email, after_state, metadata, created_at
         FROM audit_logs WHERE document_id = $1
         ORDER BY created_at DESC LIMIT 200`,
        [req.params.id],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
