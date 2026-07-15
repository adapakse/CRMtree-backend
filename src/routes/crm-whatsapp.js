'use strict';
// src/routes/crm-whatsapp.js
//
// CRM WhatsApp API — outbound send + inbound webhook (messages/statuses). No
// message templates yet.
//
// tenantId for the authenticated CRM endpoints below always comes from
// req.user (set by requireAuth) — never from the request body/params — so a
// lead/partner belonging to another tenant can never be messaged, and the
// calling user never sees or chooses WhatsApp configuration (that's
// superadmin-only, in routes/admin-tenants.js).
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
const { crmAuth }     = require('../middleware/crm-rbac');
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
  // This is the first thing that runs, before anything can be skipped, so a
  // real incoming message from a phone that never shows up further down
  // (tenant lookup, signature check, ...) still leaves a trace here. If this
  // very log line never appears for a real phone-sent message, the request
  // never reached this process at all (Meta didn't send it, or it died at
  // the tunnel/proxy) — that's a problem outside this codebase.
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
      // Nothing routable to a tenant — ack so Meta doesn't retry, save nothing.
      // A dashboard "Test" send often hits this, since its sample payload
      // doesn't always carry a real metadata.phone_number_id.
      logger.info('whatsapp webhook skipped', { reason: 'NO_PHONE_NUMBER_ID' });
      return res.status(200).json({ received: true });
    }

    const tenantConfig = await whatsappService.findTenantConfigByPhoneNumberId(phoneNumberId);
    logger.info('whatsapp webhook tenant lookup', { tenantFound: Boolean(tenantConfig) });
    if (!tenantConfig) {
      // Unknown/disabled phone_number_id — ack, save nothing.
      logger.info('whatsapp webhook skipped', { reason: 'NO_TENANT_CONFIG' });
      return res.status(200).json({ received: true });
    }

    if (!tenantConfig.appSecretEncrypted) {
      logger.warn('WhatsApp webhook: tenant has no app_secret configured, cannot verify signature', {
        tenantId: tenantConfig.tenantId,
      });
      logger.info('whatsapp webhook skipped', { reason: 'NO_APP_SECRET' });
      return res.status(401).json({ error: 'Signature verification not configured for this tenant' });
    }

    const appSecret       = decrypt(tenantConfig.appSecretEncrypted);
    const signatureHeader = req.get('X-Hub-Signature-256');
    const signatureValid  = whatsappService.verifyWebhookSignature(req.rawBody, appSecret, signatureHeader);
    logger.info('whatsapp webhook signature check', { signatureValid });
    if (!signatureValid) {
      logger.warn('WhatsApp webhook: signature verification failed', { tenantId: tenantConfig.tenantId });
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
        } = await whatsappService.resolveIncomingSender(tenantConfig.tenantId, fromDigits);

        logger.info('whatsapp webhook incoming match', {
          conversationMatchFound, crmPhoneMatchFound, assignedTo,
        });

        await whatsappService.saveIncomingMessage({
          tenantId:      tenantConfig.tenantId,
          leadId, partnerId,
          fromPhone:     fromDigits ? `+${fromDigits}` : String(message.from || ''),
          toPhone:       tenantConfig.displayPhoneNumber,
          body:          message.text?.body ?? null,
          metaMessageId: message.id,
          rawPayload:    message,
        });
        savedIncomingCount++;
      }

      for (const status of value.statuses || []) {
        if (!status.id || !status.status) continue;
        await whatsappService.updateMessageStatus({
          tenantId:      tenantConfig.tenantId,
          metaMessageId: status.id,
          status:        status.status,
        });
        updatedStatusCount++;
      }
    }

    logger.info('whatsapp webhook processed', {
      tenantId: tenantConfig.tenantId, savedIncomingCount, updatedStatusCount,
    });

    res.status(200).json({ received: true });
  } catch (err) {
    // Never let our own bug trigger a Meta retry storm — log and ack.
    logger.error('WhatsApp webhook processing error', { error: err.message });
    res.status(200).json({ received: true });
  }
});

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

      const { messageId, fromPhone } = await whatsappService.sendTextMessage({
        tenantId: req.tenantId, to: toPhone, body: req.body.message,
      });

      const { rows: msgRows } = await db.query(
        `INSERT INTO whatsapp_messages
           (tenant_id, lead_id, direction, from_phone, to_phone, body, meta_message_id, status, created_by)
         VALUES ($1, $2, 'outgoing', $3, $4, $5, $6, 'sent', $7)
         RETURNING id`,
        [req.tenantId, lead.id, fromPhone, toPhone, req.body.message, messageId, req.user.id],
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
        tenantId: req.tenantId, to: toPhone, body: req.body.message,
      });

      const { rows: msgRows } = await db.query(
        `INSERT INTO whatsapp_messages
           (tenant_id, partner_id, direction, from_phone, to_phone, body, meta_message_id, status, created_by)
         VALUES ($1, $2, 'outgoing', $3, $4, $5, $6, 'sent', $7)
         RETURNING id`,
        [req.tenantId, partner.id, fromPhone, toPhone, req.body.message, messageId, req.user.id],
      );

      logger.info('WhatsApp message sent (partner)', { tenantId: req.tenantId, partnerId: partner.id, by: req.user.email });
      res.json({ messageId, id: msgRows[0].id });
    } catch (err) {
      sendServiceError(res, err, 'Błąd wysyłki WhatsApp');
    }
  },
);

// ── GET /history/lead/:leadId — WhatsApp conversation for this lead ────────
// Reads from whatsapp_messages (real conversation model), not activities.
// Chronological ascending order, like an email thread. Outgoing-only until
// the webhook/incoming step lands.
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

      const { rows } = await db.query(
        `SELECT m.id, m.created_at, m.direction, m.from_phone, m.to_phone, m.body, m.status,
                u.display_name AS created_by_name
         FROM whatsapp_messages m
         LEFT JOIN users u ON u.id = m.created_by
         WHERE m.lead_id = $1 AND m.tenant_id = $2
         ORDER BY m.created_at ASC`,
        [leadId, req.tenantId],
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

      const { rows } = await db.query(
        `SELECT m.id, m.created_at, m.direction, m.from_phone, m.to_phone, m.body, m.status,
                u.display_name AS created_by_name
         FROM whatsapp_messages m
         LEFT JOIN users u ON u.id = m.created_by
         WHERE m.partner_id = $1 AND m.tenant_id = $2
         ORDER BY m.created_at ASC`,
        [partner.id, req.tenantId],
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
