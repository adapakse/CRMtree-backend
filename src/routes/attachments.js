"use strict";

const router = require("express").Router({ mergeParams: true });
const { param } = require("express-validator");
const db = require("../config/database");
const audit = require("../services/auditService");
const storage = require("../services/storageService");
const upload = require("../middleware/upload");
const { requireAuth } = require("../middleware/auth");
const { validate, injectAuditContext } = require("../middleware/errorHandler");

router.use(requireAuth, injectAuditContext);

async function getDoc(docId, userId, isAdmin, tenantId) {
  const { rows } = await db.query(
    `SELECT d.*, ugr.access_level AS _access
     FROM documents d
     LEFT JOIN user_group_roles ugr ON ugr.group_id = d.group_id AND ugr.user_id = $2
     WHERE d.id = $1 AND d.deleted_at IS NULL AND d.tenant_id = $3`,
    [docId, userId, tenantId],
  );
  if (!rows.length) return null;
  const doc = rows[0];
  doc._access = isAdmin ? "full" : (doc._access ?? null);
  return doc;
}

// GET /api/documents/:id/attachments
router.get(
  "/",
  [param("documentId").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const doc = await getDoc(
        req.params.documentId,
        req.user.id,
        req.user.is_admin,
        req.tenantId,
      );
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (!doc._access) return res.status(403).json({ error: "Access denied" });
      const { rows } = await db.query(
        `SELECT a.*,
        COALESCE(json_agg(json_build_object(
          'id',av.id,'version_number',av.version_number,'label',av.label,
          'blob_name',av.blob_name,'blob_size_bytes',av.blob_size_bytes,
          'mime_type',av.mime_type,'created_at',av.created_at
        ) ORDER BY av.version_number) FILTER (WHERE av.id IS NOT NULL),'[]') AS versions
       FROM document_attachments a
       LEFT JOIN attachment_versions av ON av.attachment_id = a.id
       WHERE a.document_id = $1
         AND a.document_id IN (SELECT id FROM documents WHERE tenant_id = $2)
       GROUP BY a.id ORDER BY a.created_at`,
        [req.params.documentId, req.tenantId],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/documents/:id/attachments  (nowy zalacznik)
router.post(
  "/",
  [param("documentId").isUUID()],
  validate,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const doc = await getDoc(
        req.params.documentId,
        req.user.id,
        req.user.is_admin,
        req.tenantId,
      );
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (doc._access !== "full")
        return res.status(403).json({ error: "Full access required" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const name = req.body.name || req.file.originalname;
      const blob = await storage.uploadDocument(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        req.params.documentId,
        1,
      );
      const {
        rows: [att],
      } = await db.query(
        `INSERT INTO document_attachments (document_id,name,blob_path,blob_name,blob_size_bytes,mime_type,created_by,tenant_id)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8
         WHERE EXISTS (SELECT 1 FROM documents WHERE id = $1 AND tenant_id = $8)
         RETURNING *`,
        [
          req.params.documentId,
          name,
          blob.blobPath,
          blob.blobName,
          blob.blobSizeBytes,
          req.file.mimetype,
          req.user.id,
          req.tenantId,
        ],
      );
      if (!att) return res.status(404).json({ error: "Document not found" });
      await db.query(
        `INSERT INTO attachment_versions (attachment_id,version_number,label,blob_path,blob_name,blob_size_bytes,mime_type,created_by,tenant_id)
         VALUES ($1,1,'Original upload',$2,$3,$4,$5,$6,$7)`,
        [
          att.id,
          blob.blobPath,
          blob.blobName,
          blob.blobSizeBytes,
          req.file.mimetype,
          req.user.id,
          req.tenantId,
        ],
      );
      await audit.log({
        user: req.user,
        document: doc,
        action: "attachment_uploaded",
        afterState: { name, fileName: req.file.originalname },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.status(201).json({ ...att, versions: [] });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/documents/:id/attachments/:attId/versions  (nowa wersja zalacznika)
router.post(
  "/:attId/versions",
  [param("documentId").isUUID(), param("attId").isUUID()],
  validate,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const doc = await getDoc(
        req.params.documentId,
        req.user.id,
        req.user.is_admin,
        req.tenantId,
      );
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (doc._access !== "full")
        return res.status(403).json({ error: "Full access required" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const { rows: attRows } = await db.query(
        `SELECT a.* FROM document_attachments a
         JOIN documents d ON d.id = a.document_id AND d.tenant_id = $3
         WHERE a.id = $1 AND a.document_id = $2`,
        [req.params.attId, req.params.documentId, req.tenantId],
      );
      if (!attRows.length)
        return res.status(404).json({ error: "Attachment not found" });
      const {
        rows: [{ max_v }],
      } = await db.query(
        "SELECT COALESCE(MAX(version_number),0) AS max_v FROM attachment_versions WHERE attachment_id=$1",
        [req.params.attId],
      );
      const nextVer = max_v + 1;
      const blob = await storage.uploadDocument(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        req.params.documentId,
        1,
      );
      const label = req.body.label || `Version ${nextVer}`;
      await db.query(
        `INSERT INTO attachment_versions (attachment_id,version_number,label,blob_path,blob_name,blob_size_bytes,mime_type,created_by,tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          req.params.attId,
          nextVer,
          label,
          blob.blobPath,
          blob.blobName,
          blob.blobSizeBytes,
          req.file.mimetype,
          req.user.id,
          req.tenantId,
        ],
      );
      await db.query(
        `UPDATE document_attachments
         SET blob_path=$1,blob_name=$2,blob_size_bytes=$3,mime_type=$4,updated_at=NOW()
         WHERE id=$5
           AND document_id IN (SELECT id FROM documents WHERE tenant_id = $6)`,
        [
          blob.blobPath,
          blob.blobName,
          blob.blobSizeBytes,
          req.file.mimetype,
          req.params.attId,
          req.tenantId,
        ],
      );
      await audit.log({
        user: req.user,
        document: doc,
        action: "attachment_version_uploaded",
        afterState: { attachment_id: req.params.attId, version: nextVer },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.status(201).json({ message: "Version uploaded", version: nextVer });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/documents/:id/attachments/:attId/download
router.get(
  "/:attId/download",
  [param("documentId").isUUID(), param("attId").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const doc = await getDoc(
        req.params.documentId,
        req.user.id,
        req.user.is_admin,
        req.tenantId,
      );
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (!doc._access) return res.status(403).json({ error: "Access denied" });
      const { rows } = await db.query(
        `SELECT a.* FROM document_attachments a
         JOIN documents d ON d.id = a.document_id AND d.tenant_id = $3
         WHERE a.id = $1 AND a.document_id = $2`,
        [req.params.attId, req.params.documentId, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Attachment not found" });
      const att = rows[0];
      const { buffer, contentType } = await storage.downloadDocument(
        att.blob_path,
      );
      res.setHeader(
        "Content-Type",
        contentType || att.mime_type || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(att.blob_name || "attachment")}"`,
      );
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/documents/:id/attachments/:attId/versions/:verId/download
router.get(
  "/:attId/versions/:verId/download",
  [
    param("documentId").isUUID(),
    param("attId").isUUID(),
    param("verId").isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const doc = await getDoc(
        req.params.documentId,
        req.user.id,
        req.user.is_admin,
        req.tenantId,
      );
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (!doc._access) return res.status(403).json({ error: "Access denied" });
      const { rows } = await db.query(
        `SELECT av.* FROM attachment_versions av
         JOIN document_attachments a ON a.id = av.attachment_id
         JOIN documents d ON d.id = a.document_id AND d.tenant_id = $3
         WHERE av.id = $1 AND a.document_id = $2`,
        [req.params.verId, req.params.documentId, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Version not found" });
      const ver = rows[0];
      const { buffer, contentType } = await storage.downloadDocument(
        ver.blob_path,
      );
      res.setHeader(
        "Content-Type",
        contentType || ver.mime_type || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(ver.blob_name || "attachment")}"`,
      );
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/documents/:id/attachments/:attId
router.delete(
  "/:attId",
  [param("documentId").isUUID(), param("attId").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const doc = await getDoc(
        req.params.documentId,
        req.user.id,
        req.user.is_admin,
        req.tenantId,
      );
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (doc._access !== "full")
        return res.status(403).json({ error: "Full access required" });
      const { rows } = await db.query(
        `DELETE FROM document_attachments
         WHERE id = $1 AND document_id = $2
           AND document_id IN (SELECT id FROM documents WHERE tenant_id = $3)
         RETURNING *`,
        [req.params.attId, req.params.documentId, req.tenantId],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Attachment not found" });
      await audit.log({
        user: req.user,
        document: doc,
        action: "attachment_deleted",
        beforeState: { name: rows[0].name, blob_name: rows[0].blob_name },
        metadata: { attachment_id: req.params.attId },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "Attachment deleted" });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
