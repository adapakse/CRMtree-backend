'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-substitutions.js
//
// Substitutions during absence: register an absence window + name a
// substitute + send an informational email.
//
// The substitute's actual access to the absent person's records is granted
// in middleware/crm-rbac.js (loadCrmScope extends req.crmScopeUserIds with
// active substitutions) — no parallel permission system.
//
// Multi-tenant: every row and every query is scoped by req.tenantId.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body, param } = require('express-validator');
const db     = require('../config/database');
const audit  = require('../services/auditService');
const logger = require('../utils/logger');
const email  = require('../utils/email');
const { requireAuth }                  = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, loadCrmScope }        = require('../middleware/crm-rbac');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.use(requireAuth, injectAuditContext, crmAuth, loadCrmScope);

// Whether the current user may manage (create / cancel) an absence whose absent
// person is absentUserId. Same rules for POST and DELETE:
//   - the absent person themselves      → yes,
//   - admin                             → yes (any active CRM user),
//   - sales_manager                     → only if absentUserId belongs to one of
//                                         their groups (user_group_roles / req.crmGroupIds
//                                         — deliberately NOT req.crmScopeUserIds, which
//                                         also contains people they actively substitute;
//                                         being a substitute does not grant the right to
//                                         manage an absence of someone outside the group),
//   - a substitute without the above    → no.
async function canManageAbsenceFor(req, absentUserId) {
  if (absentUserId === req.user.id) return true;
  if (req.user.is_admin) return true;
  if (req.user.crm_role === 'sales_manager') {
    if (!Array.isArray(req.crmGroupIds) || req.crmGroupIds.length === 0) return false;
    const { rows } = await db.query(
      `SELECT 1 FROM user_group_roles
        WHERE group_id = ANY($1::uuid[]) AND user_id = $2 AND tenant_id = $3
        LIMIT 1`,
      [req.crmGroupIds, absentUserId, req.tenantId],
    );
    return rows.length > 0;
  }
  return false;
}

// ── GET /api/crm/substitutions ───────────────────────────────────
// My absences (as the absent person), the ones where I'm the substitute, and
// for a manager/admin also absences of people in their scope. Tenant-scoped.
router.get('/', async (req, res, next) => {
  try {
    const params = [req.tenantId];
    let visibility;

    if (req.user.is_admin) {
      visibility = 'TRUE';
    } else if (req.user.crm_role === 'sales_manager'
               && Array.isArray(req.crmScopeUserIds) && req.crmScopeUserIds.length) {
      params.push(req.user.id, req.crmScopeUserIds);
      visibility = `(a.absent_user_id = $2 OR a.substitute_user_id = $2 OR a.absent_user_id = ANY($3::uuid[]))`;
    } else {
      params.push(req.user.id);
      visibility = `(a.absent_user_id = $2 OR a.substitute_user_id = $2)`;
    }

    const { rows } = await db.query(`
      SELECT a.*,
             to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
             to_char(a.ends_on,   'YYYY-MM-DD') AS ends_on,
             ua.display_name AS absent_user_name,
             us.display_name AS substitute_user_name,
             uc.display_name AS created_by_name
      FROM crm_absences a
      JOIN users ua ON ua.id = a.absent_user_id
      JOIN users us ON us.id = a.substitute_user_id
      LEFT JOIN users uc ON uc.id = a.created_by
      WHERE a.tenant_id = $1 AND ${visibility}
      ORDER BY a.starts_on DESC, a.created_at DESC
    `, params);

    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/crm/substitutions ──────────────────────────────────
router.post('/',
  [
    body('substitute_user_id').matches(UUID_RE),
    body('absent_user_id').optional().matches(UUID_RE),
    body('starts_on').matches(DATE_RE),
    body('ends_on').matches(DATE_RE),
    body('reason').optional().isIn(['vacation', 'sick_leave', 'other']),
    body('note').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        substitute_user_id,
        starts_on,
        ends_on,
        reason = 'other',
        note = null,
      } = req.body;
      const absentUserId = req.body.absent_user_id || req.user.id;

      if (!(await canManageAbsenceFor(req, absentUserId))) {
        return res.status(403).json({
          error: 'Możesz rejestrować nieobecność tylko dla siebie (lub, jako manager, dla osób ze swojej grupy).',
        });
      }
      if (substitute_user_id === absentUserId) {
        return res.status(400).json({ error: 'Nie można wskazać tej samej osoby jako zastępcy.' });
      }
      if (ends_on < starts_on) {
        return res.status(400).json({ error: 'Data końca nie może być wcześniejsza niż data początku.' });
      }
      const today = new Date().toISOString().slice(0, 10);
      if (ends_on < today) {
        return res.status(400).json({ error: 'Okno nieobecności nie może w całości leżeć w przeszłości.' });
      }

      const { rows: userRows } = await db.query(
        `SELECT id, display_name, email, is_active, crm_role, is_admin
         FROM users WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [[absentUserId, substitute_user_id], req.tenantId],
      );
      const absent     = userRows.find(u => u.id === absentUserId);
      const substitute = userRows.find(u => u.id === substitute_user_id);
      if (!absent || !substitute) {
        return res.status(404).json({ error: 'Nie znaleziono wskazanego użytkownika.' });
      }
      const hasCrmSeat = (u) => u.is_active && (u.is_admin || u.crm_role === 'salesperson' || u.crm_role === 'sales_manager');
      if (!hasCrmSeat(substitute)) {
        return res.status(400).json({ error: 'Wskazany zastępca nie jest aktywnym użytkownikiem CRM.' });
      }

      // The substitute must not be absent themselves in an overlapping window.
      const { rows: subConflict } = await db.query(`
        SELECT id FROM crm_absences
        WHERE tenant_id = $1 AND absent_user_id = $2 AND cancelled_at IS NULL
          AND starts_on <= $4 AND ends_on >= $3
        LIMIT 1
      `, [req.tenantId, substitute_user_id, starts_on, ends_on]);
      if (subConflict.length) {
        return res.status(409).json({
          error: 'Nie można wskazać tej osoby — ma ona własną nieobecność w nakładającym się terminie.',
        });
      }

      // Guard against a duplicated absence for the same person in an overlapping window.
      const { rows: selfConflict } = await db.query(`
        SELECT id FROM crm_absences
        WHERE tenant_id = $1 AND absent_user_id = $2 AND cancelled_at IS NULL
          AND starts_on <= $4 AND ends_on >= $3
        LIMIT 1
      `, [req.tenantId, absentUserId, starts_on, ends_on]);
      if (selfConflict.length) {
        return res.status(409).json({
          error: 'Ta osoba ma już zarejestrowaną nieobecność w nakładającym się terminie.',
        });
      }

      const { rows } = await db.query(`
        INSERT INTO crm_absences
          (tenant_id, absent_user_id, substitute_user_id, starts_on, ends_on, reason, note, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *,
          to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
          to_char(ends_on,   'YYYY-MM-DD') AS ends_on
      `, [req.tenantId, absentUserId, substitute_user_id, starts_on, ends_on, reason, note, req.user.id]);

      await audit.log({
        user:       req.user,
        action:     'crm_substitution_create',
        afterState: {
          absent_user_id: absentUserId,
          substitute_user_id,
          starts_on, ends_on, reason,
        },
        metadata:   { absence_id: rows[0].id, on_behalf: absentUserId !== req.user.id },
        ipAddress:  req.auditContext?.ipAddress,
        userAgent:  req.auditContext?.userAgent,
      });

      if (substitute.email) {
        try {
          await email.sendSubstitutionAssigned({
            to:             substitute.email,
            substituteName: substitute.display_name || substitute.email,
            absentName:     absent.display_name || absent.email,
            assignerName:   req.user.display_name || req.user.email,
            startsOn:       starts_on,
            endsOn:         ends_on,
            reason,
            note,
          });
        } catch (mailErr) {
          logger.warn('[crm-substitutions] Błąd wysyłki maila do zastępcy', { error: mailErr.message });
        }
      }

      res.status(201).json({
        ...rows[0],
        absent_user_name:     absent.display_name,
        substitute_user_name: substitute.display_name,
      });
    } catch (err) {
      // Race of two concurrent POSTs — the DB rejects the overlapping window
      // (constraint crm_absences_no_overlap). Return 409, not 500.
      if (err && err.code === '23P01') {
        return res.status(409).json({
          error: 'Ta osoba ma już zarejestrowaną nieobecność w nakładającym się terminie.',
        });
      }
      next(err);
    }
  }
);

// ── DELETE /api/crm/substitutions/:id — cancel (soft) ─────────────
router.delete('/:id',
  [param('id').matches(UUID_RE)],
  validate,
  async (req, res, next) => {
    try {
      const { rows: existing } = await db.query(
        'SELECT * FROM crm_absences WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.tenantId],
      );
      if (!existing.length) return res.status(404).json({ error: 'Nie znaleziono wpisu nieobecności.' });

      const absence = existing[0];
      if (absence.cancelled_at) {
        return res.status(409).json({ error: 'Ten wpis został już odwołany.' });
      }
      if (!(await canManageAbsenceFor(req, absence.absent_user_id))) {
        return res.status(403).json({ error: 'Brak uprawnień do odwołania tej nieobecności.' });
      }

      const { rows } = await db.query(`
        UPDATE crm_absences
        SET cancelled_at = NOW(), cancelled_by = $1, updated_at = NOW()
        WHERE id = $2 AND tenant_id = $3
        RETURNING *,
          to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
          to_char(ends_on,   'YYYY-MM-DD') AS ends_on
      `, [req.user.id, req.params.id, req.tenantId]);

      await audit.log({
        user:        req.user,
        action:      'crm_substitution_cancel',
        beforeState: {
          absent_user_id: absence.absent_user_id,
          substitute_user_id: absence.substitute_user_id,
          starts_on: absence.starts_on, ends_on: absence.ends_on,
        },
        metadata:    { absence_id: absence.id, on_behalf: absence.absent_user_id !== req.user.id },
        ipAddress:   req.auditContext?.ipAddress,
        userAgent:   req.auditContext?.userAgent,
      });

      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

module.exports = router;
