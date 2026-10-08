'use strict';
// src/routes/profile.js
// Ustawienia profilu zalogowanego usera (stopka email, język interfejsu,
// powiadomienia o terminach w projektach)

const router     = require('express').Router();
const { body }   = require('express-validator');
const db         = require('../config/database');
const { requireAuth }                  = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { SUPPORTED_LOCALES }            = require('../config/locales');

router.use(requireAuth, injectAuditContext);

// PUT /api/profile/locale — interface language of the signed-in user.
// null clears the choice: the user follows the tenant's default again.
router.put('/locale',
  [body('locale').optional({ nullable: true }).isIn(SUPPORTED_LOCALES)],
  validate,
  async (req, res, next) => {
    try {
      const locale = req.body.locale ?? null;
      await db.query(
        'UPDATE users SET locale = $1 WHERE id = $2 AND tenant_id = $3',
        [locale, req.user.id, req.tenantId]
      );
      res.json({ locale });
    } catch (err) { next(err); }
  }
);

// PUT /api/profile/project-deadline-notifications — the user's own switch for
// the automatic project deadline e-mails (daily overdue summary, end date
// changed, project became delayed), in every project at once.
router.put('/project-deadline-notifications',
  [body('is_enabled').isBoolean({ strict: true })],
  validate,
  async (req, res, next) => {
    try {
      await db.query(
        'UPDATE users SET project_deadline_notifications_enabled = $1 WHERE id = $2 AND tenant_id = $3',
        [req.body.is_enabled, req.user.id, req.tenantId]
      );
      res.json({ project_deadline_notifications_enabled: req.body.is_enabled });
    } catch (err) { next(err); }
  }
);

// GET /api/profile/signature — pobierz HTML stopki bieżącego usera
router.get('/signature', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT html FROM user_email_signatures WHERE user_id = $1 AND tenant_id = $2',
      [req.user.id, req.tenantId]
    );
    res.json({ html: rows[0]?.html || '' });
  } catch (err) { next(err); }
});

// PUT /api/profile/signature — zapisz HTML stopki
router.put('/signature',
  [body('html').optional({ nullable: true }).isString()],
  validate,
  async (req, res, next) => {
    try {
      const html = req.body.html ?? '';
      await db.query(`
        INSERT INTO user_email_signatures (user_id, html, updated_at, tenant_id)
        VALUES ($1, $2, NOW(), $3)
        ON CONFLICT (user_id) DO UPDATE SET html = EXCLUDED.html, updated_at = NOW()
      `, [req.user.id, html, req.tenantId]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
