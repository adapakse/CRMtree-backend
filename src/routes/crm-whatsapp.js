'use strict';
// src/routes/crm-whatsapp.js
//
// CRM WhatsApp API — self-service per-user config, outbound send, inbound
// webhook (messages/statuses), and read-only directories for oversight. No
// message templates yet.
//
// Each CRM user connects their own WhatsApp Business number (My Settings —
// /my-config below); there is no tenant-wide or admin-managed number. tenantId
// for the authenticated endpoints always comes from req.user (set by
// requireAuth) — never from the request body/params — so a lead/partner
// belonging to another tenant can never be messaged.
//
// GET/POST /webhook are the one exception: Meta calls them directly, with no
// CRM session, so they're registered BEFORE router.use(requireAuth, crmAuth)
// below — Express matches routes in registration order, so these two never
// reach that middleware. Their own auth is the handshake token (GET) and the
// X-Hub-Signature-256 HMAC (POST), not a JWT.

const router = require('express').Router();
const { body, param } = require('express-validator');
const db     = require('../config/database');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/encrypt');
const { requireAuth } = require('../middleware/auth');
const { crmAuth, requireFeature } = require('../middleware/crm-rbac');
const { validate }    = require('../middleware/errorHandler');
const whatsappService = require('../services/whatsappService');

// ── GET /webhook — Meta verify handshake (public, no auth) ────────────────
router.get('/webhook', async (req, res) => {
  try {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && await whatsappService.verifyWebhookToken(token)) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.status(403).json({ error: 'Verification failed' });
  } catch (err) {
    logger.error('WhatsApp webhook verify error', { error: err.message });
    res.status(403).json({ error: 'Verification failed' });
  }
});

// ── POST /webhook — incoming messages + delivery/read statuses (public, no auth) ──
// req.body is already parsed (express.json() runs at the app level); req.rawBody
// is the exact Buffer express.json()'s verify hook captured in app.js, needed
// for HMAC signature verification since a re-serialized JSON body could differ
// byte-for-byte from what Meta actually signed.
router.post('/webhook', async (req, res) => {
  // Diagnostic logging only — never the raw payload, tokens, or app secret.
  const hasRawBody        = Buffer.isBuffer(req.rawBody);
  const hasSignatureHeader = Boolean(req.get('X-Hub-Signature-256'));
  const entries            = Array.isArray(req.body?.entry) ? req.body.entry : [];

  logger.info('whatsapp webhook POST received', {
    hasRawBody,
    rawBodyLength: hasRawBody ? req.rawBody.length : 0,
    hasSignatureHeader,
    hasEntry: entries.length > 0,
    entryCount: entries.length,
  });

  try {
    const allChanges    = entries.flatMap(e => Array.isArray(e.changes) ? e.changes : []);
    const values        = allChanges.map(c => c.value).filter(Boolean);
    const phoneNumberId = values.find(v => v.metadata?.phone_number_id)?.metadata?.phone_number_id;
    const messagesCount = values.reduce((n, v) => n + (Array.isArray(v.messages) ? v.messages.length : 0), 0);
    const statusesCount = values.reduce((n, v) => n + (Array.isArray(v.statuses) ? v.statuses.length : 0), 0);

    logger.info('whatsapp webhook payload summary', {
      hasPhoneNumberId: Boolean(phoneNumberId),
      changesCount: allChanges.length,
      valuesCount:  values.length,
      messagesCount,
      statusesCount,
    });

    if (!phoneNumberId) {
      // Nothing routable to a user — ack so Meta doesn't retry, save nothing.
      // A dashboard "Test" send often hits this, since its sample payload
      // doesn't always carry a real metadata.phone_number_id.
      logger.info('whatsapp webhook skipped', { reason: 'NO_PHONE_NUMBER_ID' });
      return res.status(200).json({ received: true });
    }

    const config = await whatsappService.findConfigByPhoneNumberId(phoneNumberId);
    logger.info('whatsapp webhook config lookup', { configFound: Boolean(config) });
    if (!config) {
      // Unknown/disabled phone_number_id — ack, save nothing.
      logger.info('whatsapp webhook skipped', { reason: 'NO_CONFIG' });
      return res.status(200).json({ received: true });
    }

    if (!config.appSecretEncrypted) {
      logger.warn('WhatsApp webhook: user has no app_secret configured, cannot verify signature', {
        ownerUserId: config.ownerUserId,
      });
      logger.info('whatsapp webhook skipped', { reason: 'NO_APP_SECRET' });
      return res.status(401).json({ error: 'Signature verification not configured for this number' });
    }

    const appSecret       = decrypt(config.appSecretEncrypted);
    const signatureHeader = req.get('X-Hub-Signature-256');
    const signatureValid  = whatsappService.verifyWebhookSignature(req.rawBody, appSecret, signatureHeader);
    logger.info('whatsapp webhook signature check', { signatureValid });
    if (!signatureValid) {
      logger.warn('WhatsApp webhook: signature verification failed', { ownerUserId: config.ownerUserId });
      logger.info('whatsapp webhook skipped', { reason: 'INVALID_SIGNATURE' });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (messagesCount === 0 && statusesCount === 0) {
      logger.info('whatsapp webhook skipped', { reason: 'NO_MESSAGES_OR_STATUSES' });
    }

    let savedIncomingCount = 0;
    let updatedStatusCount = 0;

    for (const value of values) {
      for (const message of value.messages || []) {
        if (message.type !== 'text' || !message.id) continue;

        const fromDigits = whatsappService.normalizePhoneDigits(message.from);
        const {
          leadId, partnerId, conversationMatchFound, crmPhoneMatchFound, assignedTo,
        } = await whatsappService.resolveIncomingSender(config.tenantId, config.ownerUserId, fromDigits);

        logger.info('whatsapp webhook incoming match', {
          conversationMatchFound, crmPhoneMatchFound, assignedTo,
        });

        await whatsappService.saveIncomingMessage({
          tenantId:      config.tenantId,
          ownerUserId:   config.ownerUserId,
          leadId, partnerId,
          fromPhone:     fromDigits ? `+${fromDigits}` : String(message.from || ''),
          toPhone:       config.displayPhoneNumber,
          body:          message.text?.body ?? null,
          metaMessageId: message.id,
          rawPayload:    message,
        });
        savedIncomingCount++;
      }

      for (const status of value.statuses || []) {
        if (!status.id || !status.status) continue;
        await whatsappService.updateMessageStatus({
          ownerUserId:   config.ownerUserId,
          metaMessageId: status.id,
          status:        status.status,
        });
        updatedStatusCount++;
      }
    }

    logger.info('whatsapp webhook processed', {
      ownerUserId: config.ownerUserId, savedIncomingCount, updatedStatusCount,
    });

    res.status(200).json({ received: true });
  } catch (err) {
    // Never let our own bug trigger a Meta retry storm — log and ack.
    logger.error('WhatsApp webhook processing error', { error: err.message });
    res.status(200).json({ received: true });
  }
});

router.use(requireAuth, crmAuth);
router.use(requireFeature('whatsapp'));

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

// Placeholder used by the frontend to mean "unchanged" for a masked secret
// field — matches the convention already used for tenant email providers.
function isMaskedSecretPlaceholder(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && /^[*•●·]+$/.test(trimmed);
}

// ── GET /my-config — my own WhatsApp connection (My Settings) ─────────────
router.get('/my-config', async (req, res, next) => {
  try {
    const cfg = await whatsappService.getMyConfig(req.user.id);
    res.json(cfg ? { ...cfg, configured: true } : { configured: false });
  } catch (err) { next(err); }
});

// ── PUT /my-config — connect/update my own WhatsApp number ────────────────
router.put('/my-config',
  [
    body('waba_id').isString().trim().notEmpty(),
    body('phone_number_id').isString().trim().notEmpty(),
    body('display_phone_number').optional({ nullable: true }).isString().trim(),
    body('access_token').optional({ nullable: true }).isString(),
    body('app_secret').optional({ nullable: true }).isString(),
    body('is_enabled').optional().isBoolean(),
  ], validate,
  async (req, res) => {
    try {
      const accessTokenInput = isMaskedSecretPlaceholder(req.body.access_token) ? null : (req.body.access_token || null);
      const appSecretInput   = isMaskedSecretPlaceholder(req.body.app_secret) ? null : (req.body.app_secret || null);

      const saved = await whatsappService.upsertMyConfig(req.user.id, req.tenantId, {
        waba_id: req.body.waba_id,
        phone_number_id: req.body.phone_number_id,
        display_phone_number: req.body.display_phone_number || null,
        access_token: accessTokenInput,
        app_secret: appSecretInput,
        is_enabled: req.body.is_enabled,
      });

      logger.info('User connected/updated own WhatsApp number', { userId: req.user.id, phoneNumberId: saved.phone_number_id });
      res.json({ ...saved, configured: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error('Błąd zapisu konfiguracji WhatsApp', { error: err.message });
      res.status(500).json({ error: 'Błąd zapisu konfiguracji WhatsApp' });
    }
  },
);

// ── DELETE /my-config — disconnect my WhatsApp number ──────────────────────
// Conversation history stays (whatsapp_messages.owner_user_id is independent
// of whatsapp_configs), only the live connection is removed.
router.delete('/my-config', async (req, res, next) => {
  try {
    const deleted = await whatsappService.deleteMyConfig(req.user.id);
    if (!deleted) return res.status(404).json({ error: 'WhatsApp nie jest podłączony' });
    logger.info('User disconnected own WhatsApp number', { userId: req.user.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── GET /tenant-directory — connected numbers in my tenant (managers/admins only) ──
router.get('/tenant-directory', async (req, res, next) => {
  try {
    if (!req.isCrmManager) return res.status(403).json({ error: 'Brak uprawnień' });
    const rows = await whatsappService.getTenantDirectory(req.tenantId);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /status — is WhatsApp configured for the current user? ────────────
router.get('/status', async (req, res, next) => {
  try {
    const status = await whatsappService.getMyStatus(req.user.id);
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

      const { messageId, fromPhone } = await whatsappService.sendTextMessage({
        userId: req.user.id, to: toPhone, body: req.body.message,
      });

      const { rows: msgRows } = await db.query(
        `INSERT INTO whatsapp_messages
           (tenant_id, owner_user_id, lead_id, direction, from_phone, to_phone, body, meta_message_id, status, created_by)
         VALUES ($1, $2, $3, 'outgoing', $4, $5, $6, $7, 'sent', $8)
         RETURNING id`,
        [req.tenantId, req.user.id, lead.id, fromPhone, toPhone, req.body.message, messageId, req.user.id],
      );

      logger.info('WhatsApp message sent (lead)', { tenantId: req.tenantId, leadId: lead.id, by: req.user.email });
      res.json({ messageId, id: msgRows[0].id });
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

      const { messageId, fromPhone } = await whatsappService.sendTextMessage({
        userId: req.user.id, to: toPhone, body: req.body.message,
      });

      const { rows: msgRows } = await db.query(
        `INSERT INTO whatsapp_messages
           (tenant_id, owner_user_id, partner_id, direction, from_phone, to_phone, body, meta_message_id, status, created_by)
         VALUES ($1, $2, $3, 'outgoing', $4, $5, $6, $7, 'sent', $8)
         RETURNING id`,
        [req.tenantId, req.user.id, partner.id, fromPhone, toPhone, req.body.message, messageId, req.user.id],
      );

      logger.info('WhatsApp message sent (partner)', { tenantId: req.tenantId, partnerId: partner.id, by: req.user.email });
      res.json({ messageId, id: msgRows[0].id });
    } catch (err) {
      sendServiceError(res, err, 'Błąd wysyłki WhatsApp');
    }
  },
);

// Visibility: the number owner sees their own conversations; a tenant admin
// or sales_manager (req.isCrmManager, set by crmAuth) sees every
// conversation in the tenant. Any other CRM user sees nothing for a thread
// that isn't theirs, rather than a 403 — an empty history reads the same as
// "no conversation yet" and avoids leaking that a thread exists.
function ownerVisibilityClause(req, paramIndex) {
  if (req.isCrmManager) return { clause: '', params: [] };
  return { clause: ` AND m.owner_user_id = $${paramIndex}`, params: [req.user.id] };
}

// ── GET /history/lead/:leadId — WhatsApp conversation for this lead ────────
router.get('/history/lead/:leadId',
  [param('leadId').isInt()], validate,
  async (req, res, next) => {
    try {
      const leadId = parseInt(req.params.leadId, 10);
      const { rows: leadRows } = await db.query(
        'SELECT id FROM crm_leads WHERE id = $1 AND tenant_id = $2',
        [leadId, req.tenantId],
      );
      if (!leadRows.length) return res.status(404).json({ error: 'Lead nie znaleziony' });

      const visibility = ownerVisibilityClause(req, 3);
      const { rows } = await db.query(
        `SELECT m.id, m.created_at, m.direction, m.from_phone, m.to_phone, m.body, m.status,
                u.display_name AS created_by_name
         FROM whatsapp_messages m
         LEFT JOIN users u ON u.id = m.created_by
         WHERE m.lead_id = $1 AND m.tenant_id = $2${visibility.clause}
         ORDER BY m.created_at ASC`,
        [leadId, req.tenantId, ...visibility.params],
      );

      res.json(rows.map(r => ({
        id: r.id,
        created_at: r.created_at,
        direction: r.direction,
        from_phone: r.from_phone,
        to_phone: r.to_phone,
        message: r.body,
        status: r.status,
        created_by_name: r.created_by_name || null,
      })));
    } catch (err) { next(err); }
  },
);

// ── GET /history/partner/:partnerId — WhatsApp conversation for this partner ──
router.get('/history/partner/:partnerId',
  [param('partnerId').isString().trim().notEmpty()], validate,
  async (req, res, next) => {
    try {
      const partner = await resolvePartnerForWhatsapp(req.params.partnerId, req.tenantId);
      if (!partner) return res.status(404).json({ error: 'Partner nie znaleziony' });

      const visibility = ownerVisibilityClause(req, 3);
      const { rows } = await db.query(
        `SELECT m.id, m.created_at, m.direction, m.from_phone, m.to_phone, m.body, m.status,
                u.display_name AS created_by_name
         FROM whatsapp_messages m
         LEFT JOIN users u ON u.id = m.created_by
         WHERE m.partner_id = $1 AND m.tenant_id = $2${visibility.clause}
         ORDER BY m.created_at ASC`,
        [partner.id, req.tenantId, ...visibility.params],
      );

      res.json(rows.map(r => ({
        id: r.id,
        created_at: r.created_at,
        direction: r.direction,
        from_phone: r.from_phone,
        to_phone: r.to_phone,
        message: r.body,
        status: r.status,
        created_by_name: r.created_by_name || null,
      })));
    } catch (err) { next(err); }
  },
);

module.exports = router;
