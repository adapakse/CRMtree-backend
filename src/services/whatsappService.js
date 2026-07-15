'use strict';
// src/services/whatsappService.js
//
// WhatsApp Cloud API (Meta) — tenant-scoped outbound text messaging.
// Mirrors the tenant_email_providers model: one shared company WhatsApp
// number per tenant, configured by a super admin in Tenant management
// (see routes/admin-tenants.js, tenant_whatsapp_config), never per-user.
//
// Step 2 scope: outbound text messages only. No webhook, no inbound
// handling, no message templates — those are later steps.

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

module.exports = {
  getStatus,
  sendTextMessage,
  WhatsappNotConfiguredError,
  WhatsappSendError,
  WhatsappInvalidPhoneError,
};
