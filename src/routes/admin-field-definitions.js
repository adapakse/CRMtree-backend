'use strict';
// routes/admin-field-definitions.js
//
// Pola dodatkowe definiowane przez admina tenanta na formatkach leada, partnera
// i dokumentu (migracja 0328). Odpowiednik /api/admin/project-config/fields dla
// modułu Projekty — ten sam kształt tras i ta sama zasada: mutacja odpowiada
// pełną, świeżą listą, żeby ekran ustawień nie musiał dopytywać.
//
// GET   /api/admin/field-definitions              — wszystkie trzy formatki naraz
// POST  /api/admin/field-definitions              — nowe pole (entity w ciele)
// PATCH /api/admin/field-definitions/:id          — nazwa, opcje listy, aktywność
// PUT   /api/admin/field-definitions/:entity/order
//
// Celowo BRAK :tenantId w URL — zawsze req.tenantId z JWT, więc admin tenanta
// nie ma jak zaadresować cudzego tenanta (ten sam wzorzec co etapy leada i ICP).
//
// Typu pola nie da się zmienić po utworzeniu i nie ma trasy DELETE — pole się
// dezaktywuje. Powody w nagłówku services/tenantFieldService.js.

const router = require('express').Router();
const { body, param } = require('express-validator');
const audit = require('../services/auditService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const fieldService = require('../services/tenantFieldService');

router.use(requireAuth, requireAdmin, injectAuditContext);

function fieldMutation(mutate) {
  return async (req, res, next) => {
    try {
      const changed = await mutate(req);
      await audit.log({
        user: req.user,
        action: 'settings_updated',
        afterState: req.body,
        metadata: { area: 'field_definitions', ...req.params },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });
      res.json({ definitions: await fieldService.listAllDefinitions(req.tenantId), changed });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
}

router.get('/', async (req, res, next) => {
  try {
    res.json({
      definitions: await fieldService.listAllDefinitions(req.tenantId),
      entities: fieldService.ENTITIES,
      field_types: fieldService.FIELD_TYPES,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  [
    body('entity').isIn(fieldService.ENTITIES),
    body('name').isString().trim().notEmpty().isLength({ max: 120 }),
    body('field_type').isIn(fieldService.FIELD_TYPES),
    body('options').optional().isArray(),
  ],
  validate,
  fieldMutation((req) => fieldService.createDefinition(req.tenantId, req.body)),
);

router.patch(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
    body('options').optional().isArray(),
    body('is_active').optional().isBoolean({ strict: true }),
  ],
  validate,
  fieldMutation((req) => fieldService.updateDefinition(req.tenantId, req.params.id, req.body)),
);

router.put(
  '/:entity/order',
  [
    param('entity').isIn(fieldService.ENTITIES),
    body('ids').isArray({ min: 1 }),
    body('ids.*').isUUID(),
  ],
  validate,
  fieldMutation((req) =>
    fieldService.reorderDefinitions(req.tenantId, req.params.entity, req.body.ids)),
);

module.exports = router;
