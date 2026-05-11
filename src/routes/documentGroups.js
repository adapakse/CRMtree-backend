"use strict";

const router = require("express").Router();
const { body, param } = require("express-validator");
const db = require("../config/database");
const audit = require("../services/auditService");
const { requireAuth } = require("../middleware/auth");
const { validate, injectAuditContext } = require("../middleware/errorHandler");

router.use(requireAuth, injectAuditContext);

// GET /api/document-groups
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT dg.*,
              COUNT(d.id) AS document_count,
              json_agg(json_build_object('id',d.id,'doc_number',d.doc_number,'name',d.name,'status',d.status)
                       ORDER BY d.doc_number) FILTER (WHERE d.id IS NOT NULL) AS documents
       FROM document_groups dg
       LEFT JOIN documents d ON d.document_group_id = dg.id AND d.deleted_at IS NULL AND d.tenant_id = $1
       WHERE dg.tenant_id = $1
       GROUP BY dg.id
       ORDER BY dg.name`,
      [req.tenantId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/document-groups/:id
router.get("/:id", [param("id").isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT dg.*,
              json_agg(json_build_object(
                'id',d.id,'doc_number',d.doc_number,'name',d.name,'status',d.status,
                'doc_type',d.doc_type,'owner_name',u.display_name
              ) ORDER BY d.doc_number) FILTER (WHERE d.id IS NOT NULL) AS documents
       FROM document_groups dg
       LEFT JOIN documents d ON d.document_group_id = dg.id AND d.deleted_at IS NULL AND d.tenant_id = $2
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE dg.id = $1 AND dg.tenant_id = $2
       GROUP BY dg.id`,
      [req.params.id, req.tenantId],
    );
    if (!rows.length)
      return res.status(404).json({ error: "Document group not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/document-groups
router.post(
  "/",
  [
    body("name").notEmpty().isString().trim().isLength({ max: 255 }),
    body("description").optional().isString().trim(),
    body("document_ids").optional().isArray(),
    body("document_ids.*").optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, description, document_ids = [] } = req.body;

      await db.transaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO document_groups (tenant_id, name, description, created_by)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.tenantId, name, description || null, req.user.id],
        );
        const group = rows[0];

        // Link documents
        for (const docId of document_ids) {
          await client.query(
            "UPDATE documents SET document_group_id = $1 WHERE id = $2 AND deleted_at IS NULL AND tenant_id = $3",
            [group.id, docId, req.tenantId],
          );
          await audit.log({
            user: req.user,
            action: "document_linked",
            metadata: { document_group_id: group.id, document_id: docId },
            client,
          });
        }

        await audit.log({
          user: req.user,
          action: "doc_group_created",
          afterState: group,
          metadata: { linked_count: document_ids.length },
          ipAddress: req.auditContext?.ipAddress,
          client,
        });

        res.status(201).json(group);
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/document-groups/:id
router.patch(
  "/:id",
  [
    param("id").isUUID(),
    body("name").optional().isString().trim().isLength({ max: 255 }),
    body("description").optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const setClauses = [];
      const params = [];
      let p = 1;

      if (req.body.name !== undefined) {
        setClauses.push(`name = $${p++}`);
        params.push(req.body.name);
      }
      if (req.body.description !== undefined) {
        setClauses.push(`description = $${p++}`);
        params.push(req.body.description || null);
      }

      if (!setClauses.length)
        return res.status(400).json({ error: "No fields to update" });
      params.push(req.params.id, req.tenantId);

      const { rows } = await db.query(
        `UPDATE document_groups SET ${setClauses.join(",")} WHERE id = $${p} AND tenant_id = $${p + 1} RETURNING *`,
        params,
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document group not found" });

      await audit.log({
        user: req.user,
        action: "doc_group_updated",
        afterState: req.body,
        metadata: { group_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/document-groups/:id/documents — add document to group
router.post(
  "/:id/documents",
  [param("id").isUUID(), body("document_id").notEmpty().isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: grp } = await db.query(
        "SELECT id FROM document_groups WHERE id = $1 AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      if (!grp.length)
        return res.status(404).json({ error: "Document group not found" });

      const { rows } = await db.query(
        "UPDATE documents SET document_group_id = $1 WHERE id = $2 AND deleted_at IS NULL AND tenant_id = $3 RETURNING id, doc_number, name",
        [req.params.id, req.body.document_id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document not found" });

      await audit.log({
        user: req.user,
        action: "document_linked",
        metadata: {
          document_group_id: req.params.id,
          document_id: req.body.document_id,
        },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "Document added to group", document: rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/document-groups/:id/documents/:documentId — remove from group
router.delete(
  "/:id/documents/:documentId",
  [param("id").isUUID(), param("documentId").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE documents SET document_group_id = NULL
         WHERE id = $1 AND document_group_id = $2 AND deleted_at IS NULL AND tenant_id = $3
         RETURNING id, doc_number, name`,
        [req.params.documentId, req.params.id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document not in this group" });

      await audit.log({
        user: req.user,
        action: "document_unlinked",
        metadata: {
          document_group_id: req.params.id,
          document_id: req.params.documentId,
        },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "Document removed from group" });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/document-groups/:id
router.delete(
  "/:id",
  [param("id").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      // Unlink all documents first (only this tenant's documents)
      await db.query(
        "UPDATE documents SET document_group_id = NULL WHERE document_group_id = $1 AND tenant_id = $2",
        [req.params.id, req.tenantId],
      );
      const { rows } = await db.query(
        "DELETE FROM document_groups WHERE id = $1 AND tenant_id = $2 RETURNING *",
        [req.params.id, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document group not found" });

      await audit.log({
        user: req.user,
        action: "doc_group_deleted",
        beforeState: rows[0],
        metadata: { group_id: req.params.id },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "Document group deleted", id: req.params.id });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
