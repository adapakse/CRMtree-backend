'use strict';
// src/services/whatsappService.js
//
// WhatsApp Cloud API (Meta) — per-tenant messaging. One shared company
// WhatsApp Business number per tenant (one Meta app, one phone_number_id,
// one access_token), configured by a super admin in Tenant management —
// never per-user. Business decision 2026-08-03: WhatsApp Business blocks
// simultaneous personal/business use of the same phone number, so letting
// each CRM user connect their own number wasn't viable in the field.
//
// Outbound send + inbound webhook (messages + delivery/read statuses).
// Free-form text is only allowed inside Meta's 24h customer-service window
// (counted from the customer's last incoming message); outside it the only
// way to reach a customer is an approved message template (sendTemplateMessage).

const crypto = require('crypto');
const { pool } = require('../config/database');
const { encrypt, decrypt } = require('../utils/encrypt');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

class WhatsappNotConfiguredError extends Error {
  constructor() {
    super('WhatsApp nie jest skonfigurowany dla tego tenanta. Skontaktuj się z administratorem.');
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

class WhatsappWindowClosedError extends Error {
  constructor() {
    super('Klient nie pisał do Was przez ostatnie 24 godziny — WhatsApp pozwala wtedy wysłać tylko zatwierdzony szablon wiadomości.');
    this.name   = 'WhatsappWindowClosedError';
    this.status = 400;
    this.code   = 'WHATSAPP_WINDOW_CLOSED';
  }
}

class WhatsappTemplateError extends Error {
  constructor(message) {
    super(message);
    this.name   = 'WhatsappTemplateError';
    this.status = 400;
    this.code   = 'WHATSAPP_TEMPLATE_INVALID';
  }
}

class WhatsappMetaVerificationError extends Error {
  constructor(metaMessage) {
    super(`Nie udało się zweryfikować numeru w Meta: ${metaMessage}`);
    this.name   = 'WhatsappMetaVerificationError';
    this.status = 400;
    this.code   = 'WHATSAPP_META_VERIFICATION_FAILED';
  }
}

// Ground truth for a phone number lives in Meta, not in whatever an admin
// types — a phone_number_id can silently point at the wrong resource (e.g.
// Meta's free Test Number instead of the real business number). Called on
// every tenant config save; display_phone_number is never accepted as
// free-text input, only ever this function's return value.
async function fetchPhoneNumberInfoFromMeta(phoneNumberId, accessToken) {
  const res = await fetch(
    `${GRAPH_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name,code_verification_status,quality_rating`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.display_phone_number) {
    const metaMessage = data?.error?.message || `HTTP ${res.status}`;
    throw new WhatsappMetaVerificationError(metaMessage);
  }
  return {
    displayPhoneNumber: data.display_phone_number,
    verifiedName: data.verified_name || null,
    codeVerificationStatus: data.code_verification_status || null,
    qualityRating: data.quality_rating || null,
  };
}

function generateWebhookVerifyToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ─────────────────────────────────────────────────────────────────
// Tenant configuration (super admin — Tenant management)
// ─────────────────────────────────────────────────────────────────

// Full row including the decrypted webhook verify token — the tenant admin
// needs to read it back to paste into their own Meta app webhook config;
// unlike access_token/app_secret, it's a value the CRM itself generated, not
// a third-party credential, so re-displaying it is safe.
async function getTenantConfig(tenantId) {
  const { rows } = await pool.query(
    `SELECT id, waba_id, phone_number_id, display_phone_number, verified_name,
            code_verification_status, is_enabled,
            access_token, app_secret, webhook_verify_token, created_at, updated_at
     FROM tenant_whatsapp_config
     WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: row.id,
    waba_id: row.waba_id,
    phone_number_id: row.phone_number_id,
    display_phone_number: row.display_phone_number,
    verified_name: row.verified_name,
    code_verification_status: row.code_verification_status,
    is_enabled: row.is_enabled,
    access_token_configured: Boolean(row.access_token),
    app_secret_configured: Boolean(row.app_secret),
    webhook_verify_token: decrypt(row.webhook_verify_token),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Narrow status shown in the lead/partner WhatsApp tab — just enough to
// decide whether the current viewer can compose a message.
async function getTenantStatus(tenantId) {
  if (!tenantId) return { configured: false, enabled: false, display_phone_number: null };
  const { rows } = await pool.query(
    `SELECT display_phone_number, is_enabled FROM tenant_whatsapp_config WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) return { configured: false, enabled: false, display_phone_number: null };
  return {
    configured: true,
    enabled: rows[0].is_enabled,
    display_phone_number: rows[0].display_phone_number || null,
  };
}

// Secrets follow the same contract as tenant_email_providers.client_secret:
// omitted/blank on an update keeps the previously saved encrypted value,
// required on first save. webhook_verify_token is never accepted from the
// client — generated here on first connect, kept stable across updates.
//
// display_phone_number/verified_name/code_verification_status are never
// accepted as input — always (re-)fetched from Meta on every save, using
// whichever access_token this save will end up storing (the new one if
// provided, otherwise the existing decrypted one). A phone_number_id/token
// pair Meta can't resolve fails the whole save rather than silently storing
// a number that doesn't match the number actually wired up.
async function upsertTenantConfig(tenantId, input) {
  const { rows: existing } = await pool.query(
    'SELECT access_token, app_secret, webhook_verify_token FROM tenant_whatsapp_config WHERE tenant_id = $1',
    [tenantId],
  );
  const prev = existing[0] || null;

  const encAccessToken = input.access_token
    ? encrypt(input.access_token)
    : (prev ? prev.access_token : null);
  if (!encAccessToken) {
    const err = new Error('Access Token jest wymagany.');
    err.status = 400;
    throw err;
  }

  const accessTokenForValidation = input.access_token || decrypt(prev.access_token);
  const metaInfo = await fetchPhoneNumberInfoFromMeta(input.phone_number_id, accessTokenForValidation);

  const encAppSecret = input.app_secret ? encrypt(input.app_secret) : (prev ? prev.app_secret : null);
  const encVerifyToken = prev ? prev.webhook_verify_token : encrypt(generateWebhookVerifyToken());

  const { rows } = await pool.query(
    `INSERT INTO tenant_whatsapp_config
       (tenant_id, waba_id, phone_number_id, display_phone_number, verified_name, code_verification_status, access_token, app_secret, webhook_verify_token, is_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id) DO UPDATE SET
       waba_id                  = EXCLUDED.waba_id,
       phone_number_id          = EXCLUDED.phone_number_id,
       display_phone_number     = EXCLUDED.display_phone_number,
       verified_name            = EXCLUDED.verified_name,
       code_verification_status = EXCLUDED.code_verification_status,
       access_token             = EXCLUDED.access_token,
       app_secret               = EXCLUDED.app_secret,
       is_enabled               = EXCLUDED.is_enabled,
       updated_at                = NOW()
     RETURNING id, waba_id, phone_number_id, display_phone_number, verified_name, code_verification_status, is_enabled, created_at, updated_at`,
    [tenantId, input.waba_id, input.phone_number_id, metaInfo.displayPhoneNumber, metaInfo.verifiedName, metaInfo.codeVerificationStatus,
      encAccessToken, encAppSecret, encVerifyToken, input.is_enabled !== false],
  );
  return {
    ...rows[0],
    access_token_configured: true,
    app_secret_configured: Boolean(encAppSecret),
    webhook_verify_token: decrypt(encVerifyToken),
  };
}

async function deleteTenantConfig(tenantId) {
  const { rowCount } = await pool.query('DELETE FROM tenant_whatsapp_config WHERE tenant_id = $1', [tenantId]);
  return rowCount > 0;
}

// ─────────────────────────────────────────────────────────────────
// Outbound send
// ─────────────────────────────────────────────────────────────────

async function getSenderConfig(tenantId) {
  if (!tenantId) return null;
  const { rows } = await pool.query(
    `SELECT waba_id, phone_number_id, display_phone_number, access_token, is_enabled
     FROM tenant_whatsapp_config
     WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length || !rows[0].is_enabled) return null;
  return {
    wabaId:             rows[0].waba_id,
    phoneNumberId:      rows[0].phone_number_id,
    displayPhoneNumber: rows[0].display_phone_number || rows[0].phone_number_id,
    accessToken:        decrypt(rows[0].access_token),
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

async function postMessageToMeta(cfg, payload) {
  const res = await fetch(`${GRAPH_BASE}/${cfg.phoneNumberId}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 131047 = "Re-engagement message": free-form text outside the 24h window.
    // Meta usually accepts such a send and reports 131047 later as a "failed"
    // status in the webhook, which is why isCustomerWindowOpen checks first —
    // this branch only covers the case where Meta rejects it synchronously.
    if (data?.error?.code === 131047) throw new WhatsappWindowClosedError();
    const metaMessage = data?.error?.error_data?.details || data?.error?.message || `HTTP ${res.status}`;
    throw new WhatsappSendError(`Błąd wysyłki WhatsApp (Meta): ${metaMessage}`);
  }
  return data?.messages?.[0]?.id || null;
}

function requireRecipient(to) {
  const toPhone = normalizePhone(to);
  if (!toPhone) {
    const err = new Error('Brak numeru telefonu do wysyłki WhatsApp.');
    err.status = 400;
    throw err;
  }
  return toPhone;
}

// Meta only accepts free-form text within 24h of the customer's last message
// to this business number — the window belongs to the number, not to a lead,
// so it's checked tenant-wide by digits (the same customer may be attached to
// a different lead/partner, or still unassigned).
async function isCustomerWindowOpen(tenantId, toDigits) {
  if (!toDigits) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM whatsapp_messages
     WHERE tenant_id = $1
       AND direction = 'incoming'
       AND regexp_replace(from_phone, '\\D', '', 'g') = $2
       AND created_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [tenantId, toDigits],
  );
  return rows.length > 0;
}

async function sendTextMessage({ tenantId, to, body }) {
  const cfg = await getSenderConfig(tenantId);
  if (!cfg) throw new WhatsappNotConfiguredError();

  const toPhone = requireRecipient(to);
  if (!await isCustomerWindowOpen(tenantId, toPhone)) throw new WhatsappWindowClosedError();

  const messageId = await postMessageToMeta(cfg, { to: toPhone, type: 'text', text: { body } });
  return { messageId, fromPhone: cfg.displayPhoneNumber };
}

// ─────────────────────────────────────────────────────────────────
// Message templates — created and approved in Meta's WhatsApp Manager;
// the CRM only lists approved ones and fills in their variables.
// ─────────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function extractPlaceholders(text) {
  const keys = [];
  for (const match of String(text || '').matchAll(PLACEHOLDER_RE)) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

function renderTemplateText(text, params) {
  return String(text || '').replace(PLACEHOLDER_RE, (whole, key) => (key in params ? params[key] : whole));
}

// Only variables in the BODY are supported — a template whose header needs a
// media file / variable, or whose button needs a variable (dynamic URL, copy
// code), can't be sent from the CRM yet, so it's reported as unsupported
// instead of failing at send time. Static headers/footers/buttons are fine:
// Meta fills those in itself.
function toCrmTemplate(raw) {
  const components = Array.isArray(raw.components) ? raw.components : [];
  const header  = components.find(c => c.type === 'HEADER');
  const bodyCmp = components.find(c => c.type === 'BODY');
  const footer  = components.find(c => c.type === 'FOOTER');
  const buttons = components.find(c => c.type === 'BUTTONS')?.buttons || [];

  let unsupportedReason = null;
  if (header && header.format && header.format !== 'TEXT') unsupportedReason = 'HEADER_MEDIA';
  else if (header && extractPlaceholders(header.text).length) unsupportedReason = 'HEADER_VARIABLE';
  else if (buttons.some(b => extractPlaceholders(b.url).length || ['COPY_CODE', 'OTP', 'FLOW', 'CATALOG', 'MPM'].includes(b.type))) {
    unsupportedReason = 'BUTTON_VARIABLE';
  }

  const bodyText     = bodyCmp?.text || '';
  const placeholders = extractPlaceholders(bodyText);
  const isNamed      = raw.parameter_format === 'NAMED' || placeholders.some(p => !/^\d+$/.test(p));

  // Sample values entered when the template was submitted to Meta — shown in
  // the CRM as input hints, so the user knows what each variable stands for.
  const examples = {};
  if (isNamed) {
    for (const ex of bodyCmp?.example?.body_text_named_params || []) examples[ex.param_name] = ex.example;
  } else {
    const positional = bodyCmp?.example?.body_text?.[0] || [];
    placeholders.forEach(p => { if (positional[Number(p) - 1] != null) examples[p] = positional[Number(p) - 1]; });
  }

  return {
    name:               raw.name,
    language:           raw.language,
    category:           raw.category,
    header_text:        header?.format === 'TEXT' ? header.text || null : null,
    body_text:          bodyText,
    footer_text:        footer?.text || null,
    buttons:            buttons.map(b => b.text).filter(Boolean),
    variables:          placeholders.map(key => ({ key, example: examples[key] ?? null })),
    parameter_format:   isNamed ? 'NAMED' : 'POSITIONAL',
    supported:          !unsupportedReason,
    unsupported_reason: unsupportedReason,
  };
}

async function fetchApprovedTemplates(cfg) {
  if (!cfg.wabaId) {
    throw new WhatsappTemplateError('Brak WABA ID w konfiguracji WhatsApp tego tenanta — nie da się pobrać szablonów.');
  }
  const templates = [];
  let url = `${GRAPH_BASE}/${cfg.wabaId}/message_templates?status=APPROVED&limit=100`
    + '&fields=name,language,status,category,components,parameter_format';
  // Capped so a misbehaving `paging.next` link can never loop forever.
  for (let page = 0; url && page < 20; page++) {
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${cfg.accessToken}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const metaMessage = data?.error?.message || `HTTP ${res.status}`;
      throw new WhatsappSendError(`Nie udało się pobrać szablonów z Meta: ${metaMessage}`);
    }
    for (const raw of data.data || []) {
      if (raw.status === 'APPROVED') templates.push(toCrmTemplate(raw));
    }
    url = data?.paging?.next || null;
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

async function listTemplates(tenantId) {
  const cfg = await getSenderConfig(tenantId);
  if (!cfg) throw new WhatsappNotConfiguredError();
  return fetchApprovedTemplates(cfg);
}

// The template is re-fetched from Meta on every send instead of trusting the
// browser's copy: the body stored in history must be exactly what Meta
// delivers, and a template can be paused/edited in WhatsApp Manager between
// opening the form and pressing "send".
async function sendTemplateMessage({ tenantId, to, templateName, language, params }) {
  const cfg = await getSenderConfig(tenantId);
  if (!cfg) throw new WhatsappNotConfiguredError();
  const toPhone = requireRecipient(to);

  const template = (await fetchApprovedTemplates(cfg)).find(t => t.name === templateName && t.language === language);
  if (!template) throw new WhatsappTemplateError('Ten szablon nie jest (już) zatwierdzony w Meta. Odśwież listę szablonów.');
  if (!template.supported) {
    throw new WhatsappTemplateError('Tego szablonu nie da się wysłać z CRM (wymaga zdjęcia/pliku albo zmiennej w nagłówku lub przycisku).');
  }

  const values = {};
  for (const { key } of template.variables) {
    const value = String(params?.[key] ?? '').trim();
    if (!value) throw new WhatsappTemplateError(`Uzupełnij wszystkie pola szablonu (brakuje {{${key}}}).`);
    // Meta rejects template parameters containing new lines, tabs or more than
    // 4 consecutive spaces (error 132018) — caught here with a clear message.
    if (/[\n\t]| {5,}/.test(value)) {
      throw new WhatsappTemplateError(`Pole {{${key}}} nie może zawierać nowych linii, tabulatorów ani wielu spacji z rzędu.`);
    }
    values[key] = value;
  }

  const components = [];
  if (template.variables.length) {
    components.push({
      type: 'body',
      parameters: template.variables.map(({ key }) => (template.parameter_format === 'NAMED'
        ? { type: 'text', parameter_name: key, text: values[key] }
        : { type: 'text', text: values[key] })),
    });
  }

  const messageId = await postMessageToMeta(cfg, {
    to:       toPhone,
    type:     'template',
    template: { name: template.name, language: { code: template.language }, components },
  });

  const renderedBody = [template.header_text, renderTemplateText(template.body_text, values), template.footer_text]
    .filter(Boolean).join('\n\n');
  return { messageId, fromPhone: cfg.displayPhoneNumber, body: renderedBody };
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
// answering?". Checked before findCrmRecordByPhone because a lead's
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

// ON CONFLICT targets the partial unique index from migration 0231
// (tenant_id, meta_message_id) WHERE meta_message_id IS NOT NULL — DO NOTHING
// makes a retried Meta webhook delivery a harmless no-op instead of a duplicate row.
async function saveIncomingMessage({ tenantId, leadId, partnerId, fromPhone, toPhone, body, metaMessageId, rawPayload }) {
  await pool.query(
    `INSERT INTO whatsapp_messages
       (tenant_id, lead_id, partner_id, direction, from_phone, to_phone, body, meta_message_id, status, raw_payload, is_read)
     VALUES ($1, $2, $3, 'incoming', $4, $5, $6, $7, 'received', $8, false)
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

// generateWebhookVerifyToken, the Whatsapp*Error classes,
// fetchPhoneNumberInfoFromMeta, and findCrmRecordByPhone are used only
// inside this file (by upsertTenantConfig, the send functions' throws, and
// resolveIncomingSender respectively) — not re-exported, since nothing
// outside this module references them by name.
module.exports = {
  getTenantConfig,
  getTenantStatus,
  upsertTenantConfig,
  deleteTenantConfig,
  sendTextMessage,
  listTemplates,
  sendTemplateMessage,
  verifyWebhookToken,
  findTenantConfigByPhoneNumberId,
  verifyWebhookSignature,
  normalizePhoneDigits,
  resolveIncomingSender,
  saveIncomingMessage,
  updateMessageStatus,
};
