'use strict';
// src/routes/admin-pbx.js
//
// Tenant-admin management of other users' PBX PAT tokens within the SAME tenant.
// Self-service (each user managing their own token) lives in routes/pbx.js
// (/my-pat) instead — this file is only for an admin fixing/removing a
// colleague's token. requireAdmin here is tenant-scoped (checks req.user.is_admin,
// not super admin), so every query below is additionally filtered by
// req.tenantId to stop a tenant admin from touching another tenant's users.

const router = require('express').Router();
const axios  = require('axios');
const { body, param } = require('express-validator');
const db = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');

const PBX_BASE = 'https://ub24as22.ip-pbx.eu/virtualPBX/api/';

router.use(requireAuth, injectAuditContext, requireAdmin);

// GET /api/admin/pbx/credentials — lista userów TEGO tenanta z ich statusem PAT i numerem DPN
router.get('/credentials', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.display_name, u.email, u.crm_role, u.is_active,
        CASE WHEN c.pat_token IS NOT NULL THEN true ELSE false END AS has_pat,
        c.direct_phone,
        c.updated_at AS creds_updated_at
      FROM users u
      LEFT JOIN user_pbx_credentials c ON c.user_id = u.id
      WHERE u.tenant_id = $1
      ORDER BY u.last_name, u.first_name
    `, [req.tenantId]);
    res.json(rows);
  } catch (e) { next(e); }
});

// PUT /api/admin/pbx/credentials/:userId
// Weryfikuje PAT przez wywołanie ip-pbx.eu /me, pobiera direct_phone_number, zapisuje.
router.put('/credentials/:userId',
  [
    param('userId').isUUID(),
    body('pat_token').isString().notEmpty().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { pat_token } = req.body;

      const { rows: users } = await db.query(
        'SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [userId, req.tenantId]
      );
      if (!users.length) return res.status(404).json({ error: 'User not found' });

      // Weryfikuj PAT i pobierz direct_phone_number z ip-pbx.eu
      let direct_phone = null;
      try {
        const { data } = await axios.get(`${PBX_BASE}me`, {
          headers: { Authorization: `Bearer ${pat_token}` },
          timeout: 8_000,
        });
        direct_phone = data.direct_phone_number ?? null;
      } catch (err) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
          return res.status(422).json({ error: 'Nieprawidłowy PAT token — ip-pbx.eu odrzucił autoryzację.' });
        }
        // Timeout lub inny błąd serwera PBX — zapisz PAT bez numeru
        console.warn('[admin-pbx] /me fetch failed, saving PAT without phone:', err.message);
      }

      await db.query(`
        INSERT INTO user_pbx_credentials (user_id, pat_token, direct_phone)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET
          pat_token=$2, direct_phone=$3, updated_at=now()
      `, [userId, pat_token, direct_phone]);

      res.json({ ok: true, direct_phone });
    } catch (e) { next(e); }
  }
);

// DELETE /api/admin/pbx/credentials/:userId
router.delete('/credentials/:userId',
  [param('userId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: users } = await db.query(
        'SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [req.params.userId, req.tenantId]
      );
      if (!users.length) return res.status(404).json({ error: 'User not found' });

      await db.query('DELETE FROM user_pbx_credentials WHERE user_id = $1', [req.params.userId]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

module.exports = router;
