'use strict';
// src/routes/crm-whatsapp.js
//
// CRM WhatsApp API — outbound text messages only (step 2). No webhook, no
// inbound handling, no message templates yet.
//
// tenantId always comes from req.user (set by requireAuth) — never from the
// request body/params — so a lead/partner belonging to another tenant can
// never be messaged, and the calling user never sees or chooses WhatsApp
// configuration (that's superadmin-only, in routes/admin-tenants.js).

const router = require('express').Router();
const { body, param } = require('express-validator');
const db     = require('../config/database');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { crmAuth }     = require('../middleware/crm-rbac');
const { validate }    = require('../middleware/errorHandler');
const whatsappService = require('../services/whatsappService');

router.use(requireAuth, crmAuth);

// crm_partners.id is a UUID (see migrations/0159_align_local_to_server.sql),
// but partner detail views are also reachable by dwh_partner_id (integer) —
// same dual lookup crm-partners.js/crm-gmail.js already use for this table.
// Unlike those routes, this never lazy-creates a crm_partners row: by the
// time a user is on a partner's WhatsApp tab, that row already exists.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolvePartnerForWhatsapp(rawId, tenantId) {
  if (UUID_RE.test(String(rawId))) {
    const { rows } = await db.query(
      'SELECT id, phone FROM crm_partners WHERE id = $1 AND tenant_id = $2',
      [rawId, tenantId],
    );
    return rows[0] || null;
  }
  const num = parseInt(rawId, 10);
  if (isNaN(num)) return null;
  const { rows } = await db.query(
    'SELECT id, phone FROM crm_partners WHERE dwh_partner_id = $1 AND tenant_id = $2',
    [num, tenantId],
  );
  return rows[0] || null;
}

const KNOWN_WHATSAPP_ERROR_CODES = [
  'WHATSAPP_NOT_CONFIGURED',
  'WHATSAPP_SEND_FAILED',
  'WHATSAPP_INVALID_PHONE',
];

function sendServiceError(res, err, fallbackMessage) {
  if (KNOWN_WHATSAPP_ERROR_CODES.includes(err.code)) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  logger.error(fallbackMessage, { error: err.message });
  res.status(500).json({ error: fallbackMessage });
}

// ── GET /status — is WhatsApp configured for this tenant? ─────────────────
router.get('/status', async (req, res, next) => {
  try {
    const status = await whatsappService.getStatus(req.tenantId);
    res.json(status);
  } catch (err) { next(err); }
});

// ── POST /send/lead/:leadId ────────────────────────────────────────────────
router.post('/send/lead/:leadId',
  [
    param('leadId').isInt(),
    body('message').isString().trim().notEmpty(),
    body('to_phone').optional({ nullable: true }).isString().trim(),
  ], validate,
  async (req, res) => {
    try {
      const leadId = parseInt(req.params.leadId, 10);
      const { rows } = await db.query(
        'SELECT id, phone FROM crm_leads WHERE id = $1 AND tenant_id = $2',
        [leadId, req.tenantId],
      );
      if (!rows.length) return res.status(404).json({ error: 'Lead nie znaleziony' });
      const lead = rows[0];

      // Optional per-send override from the CRM user — used only for this
      // message, never written back to crm_leads.phone.
      const toPhone = req.body.to_phone || lead.phone;
      if (!toPhone) {
        return res.status(400).json({ error: 'Brak numeru telefonu do wysyłki WhatsApp.' });
      }

      const { messageId } = await whatsappService.sendTextMessage({
        tenantId: req.tenantId, to: toPhone, body: req.body.message,
      });

      const { rows: actRows } = await db.query(
        `INSERT INTO crm_lead_activities
           (lead_id, type, title, body, activity_at, created_by, tenant_id)
         VALUES ($1, 'whatsapp', 'WhatsApp', $2, NOW(), $3, $4)
         RETURNING id`,
        [lead.id, req.body.message, req.user.id, req.tenantId],
      );

      logger.info('WhatsApp message sent (lead)', { tenantId: req.tenantId, leadId: lead.id, by: req.user.email });
      res.json({ messageId, activityId: actRows[0].id });
    } catch (err) {
      sendServiceError(res, err, 'Błąd wysyłki WhatsApp');
    }
  },
);

// ── POST /send/partner/:partnerId ──────────────────────────────────────────
router.post('/send/partner/:partnerId',
  [
    param('partnerId').isString().trim().notEmpty(),
    body('message').isString().trim().notEmpty(),
    body('to_phone').optional({ nullable: true }).isString().trim(),
  ], validate,
  async (req, res) => {
    try {
      const partner = await resolvePartnerForWhatsapp(req.params.partnerId, req.tenantId);
      if (!partner) return res.status(404).json({ error: 'Partner nie znaleziony' });

      // Optional per-send override from the CRM user — used only for this
      // message, never written back to crm_partners.phone.
      const toPhone = req.body.to_phone || partner.phone;
      if (!toPhone) {
        return res.status(400).json({ error: 'Brak numeru telefonu do wysyłki WhatsApp.' });
      }

      const { messageId } = await whatsappService.sendTextMessage({
        tenantId: req.tenantId, to: toPhone, body: req.body.message,
      });

      const { rows: actRows } = await db.query(
        `INSERT INTO crm_partner_activities
           (partner_id, type, title, body, activity_at, created_by, tenant_id)
         VALUES ($1, 'whatsapp', 'WhatsApp', $2, NOW(), $3, $4)
         RETURNING id`,
        [partner.id, req.body.message, req.user.id, req.tenantId],
      );

      logger.info('WhatsApp message sent (partner)', { tenantId: req.tenantId, partnerId: partner.id, by: req.user.email });
      res.json({ messageId, activityId: actRows[0].id });
    } catch (err) {
      sendServiceError(res, err, 'Błąd wysyłki WhatsApp');
    }
  },
);

module.exports = router;
