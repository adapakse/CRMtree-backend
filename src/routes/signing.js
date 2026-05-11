"use strict";

const router = require("express").Router();
const { body, param } = require("express-validator");
const { v4: uuidv4 } = require("uuid");
const db = require("../config/database");
const signus = require("../services/signusService");
const perms = require("../services/permissionService");
const audit = require("../services/auditService");
const { requireAuth } = require("../middleware/auth");
const { validate, injectAuditContext } = require("../middleware/errorHandler");
const { isTrainingMode } = require("../utils/trainingMode");

async function scheduleTrainingSignCompletion(docId, signatoryName, userId) {
  setTimeout(async () => {
    try {
      const { rows: docRows } = await db.query(
        `SELECT blob_path, name FROM documents WHERE id = $1`, [docId]
      );
      if (!docRows.length) return;
      const doc = docRows[0];

      const { rows: verRows } = await db.query(
        `SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM document_versions WHERE document_id = $1`, [docId]
      );
      const nextVersion = (verRows[0]?.max_ver || 0) + 1;
      const label = `Podpisany przez ${signatoryName} (symulacja)`;

      await db.query(
        `INSERT INTO document_versions (document_id, version_number, blob_path, label, is_signed, created_at)
         VALUES ($1, $2, $3, $4, true, NOW())
         ON CONFLICT DO NOTHING`,
        [docId, nextVersion, doc.blob_path, label],
      );
      await db.query(
        `UPDATE documents SET status = 'signed', signing_date = CURRENT_DATE, updated_at = NOW()
         WHERE id = $1`,
        [docId],
      );

      await audit.log({
        user: { id: userId },
        document: { id: docId, name: doc.name },
        action: 'signing_completed',
        afterState: { version_number: nextVersion, signed_by: signatoryName, training: true },
      });
    } catch (e) {
      console.warn('[Training] scheduleTrainingSignCompletion failed:', e.message);
    }
  }, 10_000);
}

// ────────────────────────────────────────────────────────────
// POST /api/documents/:id/sign/initiate
// ────────────────────────────────────────────────────────────
router.post(
  "/documents/:id/sign/initiate",
  requireAuth,
  injectAuditContext,
  [
    param("id").isUUID(),
    body("signatories").isArray({ min: 1 }),
    body("signatories.*.email").isEmail().normalizeEmail(),
    body("signatories.*.name").optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL",
        [req.params.id],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Document not found" });
      const doc = rows[0];

      await perms.assertCanFull(req.user.id, doc);

      const training = await isTrainingMode();

      if (!training && !doc.blob_path)
        return res.status(400).json({ error: "Document has no file attached" });

      let result;

      if (training) {
        const fakeEnvelopeId = `training_envelope_${uuidv4().replace(/-/g, '')}`;
        await db.query(
          `UPDATE documents SET status = 'being_signed', updated_at = NOW() WHERE id = $1`,
          [doc.id],
        );
        const signatoryName = req.body.signatories[0]?.name || req.body.signatories[0]?.email || 'Sygnatariusz';
        scheduleTrainingSignCompletion(doc.id, signatoryName, req.user?.id);
        result = { envelopeId: fakeEnvelopeId, training: true };
      } else {
        result = await signus.initiateSign({
          documentId: doc.id,
          blobPath: doc.blob_path,
          documentName: doc.name,
          docNumber: doc.doc_number,
          signatories: req.body.signatories,
          initiatedBy: req.user,
        });
      }

      await audit.log({
        user: req.user,
        document: doc,
        action: "signing_initiated",
        afterState: {
          signatories: req.body.signatories.map((s) => s.email),
          envelope_id: result.envelopeId,
          training: training || undefined,
        },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });

      res.json(result);
    } catch (err) {
      console.error("[settings GET]", err.message);
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// POST /api/signing/webhook — Signus callback
// (no auth — verified by HMAC signature)
// ────────────────────────────────────────────────────────────
router.post(
  "/webhook",
  // Raw body needed for HMAC verification — configured in server.js
  async (req, res, next) => {
    try {
      const signature = req.headers["x-signus-signature"] || "";
      const result = await signus.processWebhook(
        req.body,
        req.rawBody,
        signature,
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("Invalid Signus webhook signature")) {
        return res.status(401).json({ error: "Invalid signature" });
      }
      next(err);
    }
  },
);

module.exports = router;
