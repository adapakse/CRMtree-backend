'use strict';
// src/routes/profile.js
// Ustawienia profilu zalogowanego usera (stopka email)

const router     = require('express').Router();
const { body }   = require('express-validator');
const db         = require('../config/database');
const { requireAuth }                  = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');

router.use(requireAuth, injectAuditContext);

// GET /api/profile/signature — pobierz HTML stopki bieżącego usera
router.get('/signature', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT html FROM user_email_signatures WHERE user_id = $1',
      [req.user.id]
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
        INSERT INTO user_email_signatures (user_id, html, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET html = EXCLUDED.html, updated_at = NOW()
      `, [req.user.id, html]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
