'use strict';

const router = require('express').Router();
const { param, query } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('../config/database');
const storage = require('../services/storageService');
const audit = require('../services/auditService');
const multer = require('multer');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { crmAuth, loadCrmScope, loadCrmModuleGrants, requireFeature } = require('../middleware/crm-rbac');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const service = require('../services/entityAttachmentService');

const allowedMimeTypes = new Set([
  ...config.upload.allowedMimeTypes,
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/x-zip-compressed',
]);
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: config.upload.maxSizeMb * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (allowedMimeTypes.has(file.mimetype)) return callback(null, true);
    const error = new Error('Unsupported attachment type');
    error.status = 400;
    callback(error);
  },
});

router.use(requireAuth, injectAuditContext);
router.use('/:type/:id',
  [param('type').isIn(Object.keys(service.SOURCES)), param('id').isLength({ min: 1, max: 40 })], validate,
  (req, res, next) => {
    const module = service.SOURCES[req.params.type].module;
    if (module) return crmAuth(req, res, next);
    return requireFeature('projects')(req, res, next);
  },
  (req, res, next) => {
    if (service.SOURCES[req.params.type].module) return loadCrmScope(req, res, next);
    next();
  },
  (req, res, next) => {
    const module = service.SOURCES[req.params.type].module;
    if (module) return loadCrmModuleGrants(module)(req, res, next);
    next();
  },
  async (req, res, next) => {
    if (!req.crmGlobalRead || req.method !== 'GET' || req.user.is_admin) return next();
    try {
      // Global read replaces the read scope with null. Resolve write rights
      // separately so the upload control still works for one's own/team records.
      const writeRequest = { user: req.user, method: 'POST' };
      let hasDeniedScope = false;
      let scopeError;
      const deniedResponse = {
        status: () => deniedResponse,
        json: () => { hasDeniedScope = true; },
      };
      await loadCrmScope(writeRequest, deniedResponse, error => { scopeError = error; });
      if (scopeError) return next(scopeError);
      if (!hasDeniedScope) {
        await loadCrmModuleGrants(service.SOURCES[req.params.type].module)(writeRequest, deniedResponse, error => { scopeError = error; });
        if (scopeError) return next(scopeError);
      }
      req.crmWriteScopeUserIds = hasDeniedScope ? [] : writeRequest.crmWriteScopeUserIds ?? writeRequest.crmScopeUserIds;
      next();
    } catch (error) { next(error); }
  },
  async (req, res, next) => {
    try {
      req.attachmentSource = await service.resolveSource(req, req.params.type, req.params.id);
      next();
    } catch (error) { next(error); }
  },
);

const listRules = [
  query('page').default(1).isInt({ min: 1, max: 1000000 }).toInt(),
  query('page_size').default(50).isInt({ min: 1, max: 50 }).toInt(),
  query('aggregate').optional().isIn(['true', 'false']),
  query('filename').optional().isString().isLength({ max: 300 }),
  query('place').optional().matches(/^(lead|partner|lead-activity|partner-activity|project|project-task):[0-9a-f-]{1,36}$/i),
  query('author').optional().isUUID(),
  query('source').optional().isIn(['direct', 'task', 'note', 'project', 'project-task', 'call', 'email', 'meeting', 'doc_sent', 'training', 'qbr']),
  query('sort').optional().isIn(['filename', 'source', 'place', 'author', 'created_at']),
  query('order').optional().isIn(['asc', 'desc']),
  ...['created_from', 'created_to'].map(name => query(name).optional().isISO8601({ strict: true }).isLength({ min: 10, max: 10 })),
];

router.get('/:type/:id', listRules, validate, async (req, res, next) => {
  try {
    const filters = { ...req.query };
    if (filters.filename) filters.filename = `%${filters.filename}%`;
    res.json(await service.listAttachments(req, req.attachmentSource, filters));
  } catch (error) { next(error); }
});

function requireWrite(req, res, next) {
  if (!req.attachmentSource.canWrite) return res.status(403).json({ error: 'Attachment write access required' });
  next();
}

router.post('/:type/:id', requireWrite, upload.single('file'), async (req, res, next) => {
  let blobPath;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let originalName = req.file.originalname;
    // Busboy decodes multipart filename headers as Latin-1; browsers send UTF-8.
    // eslint-disable-next-line no-control-regex -- byte-range check on purpose
    if (!/[^\x00-\xff]/.test(originalName)) {
      const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
      if (!decoded.includes('\ufffd')) originalName = decoded;
    }
    // eslint-disable-next-line no-control-regex -- strips control characters on purpose
    const filename = path.basename(originalName.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500);
    if (!filename) return res.status(400).json({ error: 'Invalid filename' });
    const id = uuidv4();
    blobPath = `entity-attachments/${req.tenantId}/${id}`;
    await storage.uploadBuffer(blobPath, req.file.buffer, req.file.mimetype);
    const { type, id: sourceId } = req.attachmentSource;
    const { rows: [attachment] } = await db.query(
      `INSERT INTO entity_attachments
        (id, tenant_id, ${service.SOURCES[type].column}, filename, mime_type, file_size, blob_path, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, filename, mime_type, file_size, created_at, created_by`,
      [id, req.tenantId, sourceId, filename, req.file.mimetype, req.file.size, blobPath, req.user.id],
    );
    blobPath = null;
    await audit.log({ user: req.user, action: 'attachment_uploaded', metadata: { attachment_id: id, source_type: type, source_id: sourceId }, ipAddress: req.auditContext?.ipAddress });
    res.status(201).json(attachment);
  } catch (error) {
    if (blobPath) await storage.deleteBlob(blobPath).catch(() => {});
    next(error);
  }
});

async function loadAttachment(req, res, next) {
  try {
    const source = req.attachmentSource;
    const { rows: [attachment] } = await db.query(
      `SELECT * FROM entity_attachments WHERE id = $1 AND tenant_id = $2 AND ${service.SOURCES[source.type].column} = $3`,
      [req.params.attachmentId, req.tenantId, source.id],
    );
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    req.entityAttachment = attachment;
    next();
  } catch (error) { next(error); }
}

const attachmentRule = [param('attachmentId').isUUID()];
router.get('/:type/:id/:attachmentId/download', attachmentRule, validate, loadAttachment, async (req, res, next) => {
  try {
    const attachment = req.entityAttachment;
    const { buffer } = await storage.downloadDocument(attachment.blob_path);
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.filename)}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    res.send(buffer);
  } catch (error) { next(error); }
});

router.delete('/:type/:id/:attachmentId', attachmentRule, validate, requireWrite, loadAttachment, async (req, res, next) => {
  try {
    const attachment = req.entityAttachment;
    await db.query('DELETE FROM entity_attachments WHERE id = $1 AND tenant_id = $2', [attachment.id, req.tenantId]);
    // A failed blob cleanup must not restore a file already removed from the CRM.
    await storage.deleteBlob(attachment.blob_path).catch(() => {});
    await audit.log({ user: req.user, action: 'attachment_deleted', metadata: { attachment_id: attachment.id, source_type: req.attachmentSource.type, source_id: req.attachmentSource.id }, ipAddress: req.auditContext?.ipAddress });
    res.sendStatus(204);
  } catch (error) { next(error); }
});

module.exports = router;
