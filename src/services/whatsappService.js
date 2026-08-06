'use strict';
// src/services/whatsappService.js
//
// WhatsApp Cloud API (Meta) — tenant-scoped messaging. Mirrors the
// tenant_email_providers model: one shared company WhatsApp number per
// tenant, configured by a super admin in Tenant management (see
// routes/admin-tenants.js, tenant_whatsapp_config), never per-user.
//
// Outbound send + inbound webhook (messages + delivery/read statuses). No
// message templates yet.

const crypto = require('crypto');
const { pool } = require('../config/database');
const { decrypt } = require('../utils/encrypt');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

class WhatsappNotConfiguredError extends Error {
  constructor() {
    super('WhatsApp nie jest skonfigurowany dla tej organizacji. Skontaktuj się z administratorem.');
    this.name   = 'WhatsappNotConfiguredError';
    this.status = 400;
    this.code   = 'WHATSAPP_NOT_CONFIGURED';
  }
}

class WhatsappSendError extends Error {
  constructor(message) {
    super(message);
    this.name   = 'WhatsappSendError';
    this.status = 502;
    this.code   = 'WHATSAPP_SEND_FAILED';
  }
}

class WhatsappInvalidPhoneError extends Error {
  constructor() {
    super('Numer telefonu musi być w formacie międzynarodowym, zaczynającym się od "+", np. +48 502 345 678.');
    this.name   = 'WhatsappInvalidPhoneError';
    this.status = 400;
    this.code   = 'WHATSAPP_INVALID_PHONE';
  }
}

async function getTenantConfig(tenantId) {
  if (!tenantId) return null;
  const { rows } = await pool.query(
    `SELECT phone_number_id, display_phone_number, access_token, is_enabled
     FROM tenant_whatsapp_config
     WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length || !rows[0].is_enabled) return null;
  return {
    phoneNumberId:      rows[0].phone_number_id,
    // Prefer the human-readable display number; fall back to the technical
    // phone_number_id if the tenant admin never filled it in, so callers
    // (e.g. whatsapp_messages.from_phone) always have something to store.
    displayPhoneNumber: rows[0].display_phone_number || rows[0].phone_number_id,
    accessToken:        decrypt(rows[0].access_token),
  };
}

// Status shown to regular CRM users (lead/partner WhatsApp tab) — deliberately
// narrower than getTenantConfig: only what's safe to display, never the
// access_token/app_secret/webhook_verify_token/waba_id/phone_number_id.
async function getStatus(tenantId) {
  if (!tenantId) return { configured: false, enabled: false, display_phone_number: null };
  const { rows } = await pool.query(
    `SELECT display_phone_number, is_enabled
     FROM tenant_whatsapp_config
     WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) return { configured: false, enabled: false, display_phone_number: null };
  return {
    configured: true,
    enabled: rows[0].is_enabled,
    display_phone_number: rows[0].display_phone_number || null,
  };
}

// Meta's Cloud API expects `to` as digits only (E.164 without the leading
// "+"). No country is ever assumed here — CRMtree is multi-country, so a
// bare national number (e.g. "502345678") is rejected rather than guessed
// at. The caller must supply an international number starting with "+";
// this only strips spaces/dashes/parens and drops the "+" itself.
function normalizePhone(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('+')) throw new WhatsappInvalidPhoneError();
  return trimmed.replace(/\D/g, '');
}

async function sendTextMessage({ tenantId, to, body }) {
  const cfg = await getTenantConfig(tenantId);
  if (!cfg) throw new WhatsappNotConfiguredError();

  const toPhone = normalizePhone(to);
  if (!toPhone) {
    const err = new Error('Brak numeru telefonu do wysyłki WhatsApp.');
    err.status = 400;
    throw err;
  }

  const res = await fetch(`${GRAPH_BASE}/${cfg.phoneNumberId}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to:   toPhone,
      type: 'text',
      text: { body },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const metaMessage = data?.error?.message || `HTTP ${res.status}`;
    throw new WhatsappSendError(`Błąd wysyłki WhatsApp (Meta): ${metaMessage}`);
  }

  return { messageId: data?.messages?.[0]?.id || null, fromPhone: cfg.displayPhoneNumber };
}

// ─────────────────────────────────────────────────────────────────
// Webhook helpers (incoming messages + delivery/read status updates)
// ─────────────────────────────────────────────────────────────────

// GET /webhook handshake: `webhook_verify_token` is encrypted per-tenant, so
// there's no way to look it up by value — instead, decrypt every enabled
// tenant's token and timing-safe-compare each against what Meta sent. Tenant
// counts here are small (one row per tenant with WhatsApp configured), so a
// full scan per verification request is cheap and avoids ever storing the
// token in a directly queryable (plaintext or hashed-for-lookup) form.
async function verifyWebhookToken(candidateToken) {
  if (!candidateToken) return false;
  const candidateBuf = Buffer.from(String(candidateToken));
  const { rows } = await pool.query(
    `SELECT webhook_verify_token FROM tenant_whatsapp_config WHERE is_enabled = true`,
  );
  for (const row of rows) {
    const decrypted = decrypt(row.webhook_verify_token);
    if (!decrypted) continue;
    const decryptedBuf = Buffer.from(decrypted);
    if (decryptedBuf.length !== candidateBuf.length) continue;
    if (crypto.timingSafeEqual(decryptedBuf, candidateBuf)) return true;
  }
  return false;
}

// Resolves the tenant a POST /webhook delivery belongs to, from the
// `phone_number_id` Meta always includes in value.metadata. Returns the
// still-encrypted app_secret — decrypting is the caller's job, since it's
// only needed once signature verification is actually attempted.
async function findTenantConfigByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { rows } = await pool.query(
    `SELECT tenant_id, phone_number_id, display_phone_number, app_secret
     FROM tenant_whatsapp_config
     WHERE phone_number_id = $1 AND is_enabled = true`,
    [phoneNumberId],
  );
  if (!rows.length) return null;
  return {
    tenantId:           rows[0].tenant_id,
    phoneNumberId:      rows[0].phone_number_id,
    displayPhoneNumber: rows[0].display_phone_number || rows[0].phone_number_id,
    appSecretEncrypted: rows[0].app_secret,
  };
}

// `rawBody` must be the exact bytes Meta signed (a Buffer captured by
// express.json()'s verify hook in app.js) — re-serializing req.body to JSON
// would not reliably reproduce the same bytes and would break verification.
function verifyWebhookSignature(rawBody, appSecret, signatureHeader) {
  if (!rawBody || !appSecret || !signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const providedHex = signatureHeader.slice('sha256='.length);

  let expectedBuf, providedBuf;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    providedBuf = Buffer.from(providedHex, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Digits-only form used purely for matching a webhook sender number against
// crm_leads.phone/crm_partners.phone — never used for what's actually sent
// to Meta (see normalizePhone above, which is stricter and throws on bad input).
function normalizePhoneDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// Exact digit-for-digit match only — never fuzzy/partial, per the "don't
// guess" rule. Returns both ids null if there's zero or more-than-one match
// in either table, or if the number matches both a lead AND a partner —
// ambiguous matches are left unassigned rather than guessed.
async function findCrmRecordByPhone(tenantId, digits) {
  if (!digits) return { leadId: null, partnerId: null };

  const [{ rows: leadRows }, { rows: partnerRows }] = await Promise.all([
    pool.query(
      `SELECT id FROM crm_leads
       WHERE tenant_id = $1 AND phone IS NOT NULL AND regexp_replace(phone, '\\D', '', 'g') = $2`,
      [tenantId, digits],
    ),
    pool.query(
      `SELECT id FROM crm_partners
       WHERE tenant_id = $1 AND phone IS NOT NULL AND regexp_replace(phone, '\\D', '', 'g') = $2`,
      [tenantId, digits],
    ),
  ]);

  if (leadRows.length === 1 && partnerRows.length === 0) return { leadId: leadRows[0].id, partnerId: null };
  if (partnerRows.length === 1 && leadRows.length === 0) return { leadId: null, partnerId: partnerRows[0].id };
  return { leadId: null, partnerId: null };
}

// Matches an incoming sender against this tenant's own most recent outgoing
// message to that same number — i.e. "who did we message that this reply is
// answering?". This is checked before findCrmRecordByPhone because a lead's
// crm_leads.phone can be blank/stale/differently formatted while the actual
// WhatsApp thread (what we sent to, what they replied from) is still exact.
// Only conversations already assigned to a lead/partner count as a match, so
// this can never assign an incoming message based on another unassigned one.
async function findConversationByPhone(tenantId, digits) {
  if (!digits) return { leadId: null, partnerId: null };
  const { rows } = await pool.query(
    `SELECT lead_id, partner_id
     FROM whatsapp_messages
     WHERE tenant_id = $1
       AND direction = 'outgoing'
       AND regexp_replace(to_phone, '\\D', '', 'g') = $2
       AND (lead_id IS NOT NULL OR partner_id IS NOT NULL)
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, digits],
  );
  if (!rows.length) return { leadId: null, partnerId: null };
  return { leadId: rows[0].lead_id, partnerId: rows[0].partner_id };
}

// Single entry point the webhook uses to decide who an incoming message
// belongs to. Order of preference: existing conversation (see
// findConversationByPhone) first, direct crm_leads/crm_partners phone match
// second, unassigned otherwise. Returns match flags alongside the ids purely
// for safe (no-phone-number) diagnostic logging in the webhook route.
async function resolveIncomingSender(tenantId, digits) {
  const conversationMatch = await findConversationByPhone(tenantId, digits);
  const conversationMatchFound = Boolean(conversationMatch.leadId || conversationMatch.partnerId);
  if (conversationMatchFound) {
    return {
      leadId: conversationMatch.leadId,
      partnerId: conversationMatch.partnerId,
      conversationMatchFound: true,
      crmPhoneMatchFound: false,
      assignedTo: conversationMatch.leadId ? 'lead' : 'partner',
    };
  }

  const crmMatch = await findCrmRecordByPhone(tenantId, digits);
  const crmPhoneMatchFound = Boolean(crmMatch.leadId || crmMatch.partnerId);
  return {
    leadId: crmMatch.leadId,
    partnerId: crmMatch.partnerId,
    conversationMatchFound: false,
    crmPhoneMatchFound,
    assignedTo: crmMatch.leadId ? 'lead' : (crmMatch.partnerId ? 'partner' : 'unassigned'),
  };
}

// ON CONFLICT targets the partial unique index from migration 0207
// (tenant_id, meta_message_id) WHERE meta_message_id IS NOT NULL — DO NOTHING
// makes a retried Meta webhook delivery a harmless no-op instead of a duplicate row.
async function saveIncomingMessage({ tenantId, leadId, partnerId, fromPhone, toPhone, body, metaMessageId, rawPayload }) {
  await pool.query(
    `INSERT INTO whatsapp_messages
       (tenant_id, lead_id, partner_id, direction, from_phone, to_phone, body, meta_message_id, status, raw_payload)
     VALUES ($1, $2, $3, 'incoming', $4, $5, $6, $7, 'received', $8)
     ON CONFLICT (tenant_id, meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING`,
    [tenantId, leadId, partnerId, fromPhone, toPhone, body, metaMessageId, JSON.stringify(rawPayload)],
  );
}

// No-op if the message isn't found (e.g. status arrived for a message this
// tenant sent before whatsapp_messages existed, or an id typo from Meta).
async function updateMessageStatus({ tenantId, metaMessageId, status }) {
  if (!metaMessageId || !status) return;
  await pool.query(
    `UPDATE whatsapp_messages SET status = $1 WHERE tenant_id = $2 AND meta_message_id = $3`,
    [status, tenantId, metaMessageId],
  );
}

module.exports = {
  getStatus,
  sendTextMessage,
  WhatsappNotConfiguredError,
  WhatsappSendError,
  WhatsappInvalidPhoneError,
  verifyWebhookToken,
  findTenantConfigByPhoneNumberId,
  verifyWebhookSignature,
  normalizePhoneDigits,
  findCrmRecordByPhone,
  resolveIncomingSender,
  saveIncomingMessage,
  updateMessageStatus,
};
