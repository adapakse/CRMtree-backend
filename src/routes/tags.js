'use strict';

const router = require('express').Router({ mergeParams: true });
const { body, param } = require('express-validator');
const db    = require('../config/database');
const audit = require('../services/auditService');
const perms = require('../services/permissionService');
const { requireAuth }        = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');

router.use(requireAuth, injectAuditContext);

async function loadDoc(id) {
  const { rows } = await db.query(
    'SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL', [id]
  );
  return rows[0] || null;
}

// GET /api/documents/:documentId/tags
router.get('/', async (req, res, next) => {
  try {
    const doc = await loadDoc(req.params.documentId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await perms.assertCanRead(req.user.id, doc);

    const { rows } = await db.query(
      `SELECT id, key, value, created_at, updated_at
       FROM document_tags WHERE document_id = $1 ORDER BY key`,
      [doc.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/documents/:documentId/tags
router.post('/',
  [body('key').notEmpty().isString().trim().isLength({ max: 100 }),
   body('value').notEmpty().isString().trim().isLength({ max: 500 })],
  validate,
  async (req, res, next) => {
    try {
      const doc = await loadDoc(req.params.documentId);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      await perms.assertCanFull(req.user.id, doc);

      const { key, value } = req.body;
      const { rows } = await db.query(
        `INSERT INTO document_tags (document_id, key, value, created_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (document_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
         RETURNING *`,
        [doc.id, key, value, req.user.id]
      );
      await audit.log({
        user:      req.user, document: doc, action: 'tag_added',
        afterState: { key, value }, ipAddress: req.auditContext?.ipAddress,
      });
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// PATCH /api/documents/:documentId/tags/:tagId
router.patch('/:tagId',
  [param('tagId').isUUID(), body('value').notEmpty().isString().trim().isLength({ max: 500 })],
  validate,
  async (req, res, next) => {
    try {
      const doc = await loadDoc(req.params.documentId);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      await perms.assertCanFull(req.user.id, doc);

      const { rows: before } = await db.query(
        'SELECT * FROM document_tags WHERE id = $1 AND document_id = $2', [req.params.tagId, doc.id]
      );
      if (!before.length) return res.status(404).json({ error: 'Tag not found' });

      const { rows } = await db.query(
        'UPDATE document_tags SET value = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [req.body.value, req.params.tagId]
      );
      await audit.log({
        user:        req.user, document: doc, action: 'tag_updated',
        beforeState: { key: before[0].key, value: before[0].value },
        afterState:  { key: before[0].key, value: req.body.value },
        ipAddress:   req.auditContext?.ipAddress,
      });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// DELETE /api/documents/:documentId/tags/:tagId
router.delete('/:tagId', [param('tagId').isUUID()], validate, async (req, res, next) => {
  try {
    const doc = await loadDoc(req.params.documentId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await perms.assertCanFull(req.user.id, doc);

    const { rows } = await db.query(
      'DELETE FROM document_tags WHERE id = $1 AND document_id = $2 RETURNING *',
      [req.params.tagId, doc.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tag not found' });

    await audit.log({
      user:        req.user, document: doc, action: 'tag_removed',
      beforeState: { key: rows[0].key, value: rows[0].value },
      ipAddress:   req.auditContext?.ipAddress,
    });
    res.json({ message: 'Tag deleted', id: req.params.tagId });
  } catch (err) { next(err); }
});

module.exports = router;
