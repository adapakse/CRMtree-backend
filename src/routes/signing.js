'use strict';

const router   = require('express').Router();
const { body, param } = require('express-validator');
const db       = require('../config/database');
const signus   = require('../services/signusService');
const perms    = require('../services/permissionService');
const audit    = require('../services/auditService');
const { requireAuth }        = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');

// ────────────────────────────────────────────────────────────
// POST /api/documents/:id/sign/initiate
// ────────────────────────────────────────────────────────────
router.post('/documents/:id/sign/initiate',
  requireAuth,
  injectAuditContext,
  [
    param('id').isUUID(),
    body('signatories').isArray({ min: 1 }),
    body('signatories.*.email').isEmail().normalizeEmail(),
    body('signatories.*.name').optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL',
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Document not found' });
      const doc = rows[0];

      await perms.assertCanFull(req.user.id, doc);
      if (!doc.blob_path) return res.status(400).json({ error: 'Document has no file attached' });

      const result = await signus.initiateSign({
        documentId:   doc.id,
        blobPath:     doc.blob_path,
        documentName: doc.name,
        docNumber:    doc.doc_number,
        signatories:  req.body.signatories,
        initiatedBy:  req.user,
      });

      await audit.log({
        user:      req.user,
        document:  doc,
        action:    'signing_initiated',
        afterState: {
          signatories:  req.body.signatories.map(s => s.email),
          envelope_id:  result.envelopeId,
        },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });

      res.json(result);
    } catch (err) { next(err); }
  }
);

// ────────────────────────────────────────────────────────────
// POST /api/signing/webhook — Signus callback
// (no auth — verified by HMAC signature)
// ────────────────────────────────────────────────────────────
router.post('/webhook',
  // Raw body needed for HMAC verification — configured in server.js
  async (req, res, next) => {
    try {
      const signature = req.headers['x-signus-signature'] || '';
      const result    = await signus.processWebhook(req.body, req.rawBody, signature);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes('Invalid Signus webhook signature')) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
      next(err);
    }
  }
);

module.exports = router;
