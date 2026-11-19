'use strict';
// services/sendgridService.js
// ─────────────────────────────────────────────────────────────────────────────
// SendGrid for e-mail campaigns — every tenant uses ITS OWN SendGrid account
// (decision 2026-11-18). Settings live in tenant_sendgrid_config; the API key is
// encrypted (utils/encrypt.js) and never leaves the backend. Only
// CAMPAIGN_MAX_RECIPIENTS stays an env var.
//
// Event Webhook: POST /api/webhooks/sendgrid/:token — the random token identifies
// the tenant, the tenant's public key (ECDSA P-256) verifies the signature.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config');
const { encrypt, decrypt } = require('../utils/encrypt');
const { loadConsentTypes } = require('./consentService');

const API = 'https://api.sendgrid.com/v3';
const DEFAULT_CONSENT_KEY = 'marketing_comm';

/**
 * Environment tag in every mail's custom_args (host of APP_URL). The INT database is
 * a copy of PROD, so a mail sent from INT carries ids that also exist on PROD —
 * the webhook drops events whose tag does not match this environment.
 */
const ENV_TAG = String(config.appUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'local';

// ── Tenant configuration ─────────────────────────────────────────────────────

async function loadConfig(tenantId) {
  const { rows } = await db.query(
    `SELECT s.*, t.name AS tenant_name
       FROM tenants t
       LEFT JOIN tenant_sendgrid_config s ON s.tenant_id = t.id
      WHERE t.id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tenantId,
    tenantName: row.tenant_name,
    apiKey:     decrypt(row.api_key_encrypted) || '',
    apiKeyHint: row.api_key_hint || null,
    fromEmail:  row.from_email || '',
    fromName:   row.from_name || row.tenant_name || '',
    replyTo:    row.reply_to || '',
    asmGroupId: row.asm_group_id || null,
    webhookKey: row.webhook_public_key || '',
    webhookToken: row.webhook_token || null,
    consentKey: row.consent_key || null,
  };
}

/** What is set and what is missing for sending — safe to show in the CRM (no secret values). */
function status(cfg) {
  const missing = [];
  if (!cfg?.apiKey) missing.push('api_key');
  if (!cfg?.fromEmail) missing.push('from_email');
  if (!cfg?.asmGroupId) missing.push('asm_group_id');
  return {
    configured: missing.length === 0,
    missing,
    from_email: cfg?.fromEmail || null,
    from_name: cfg?.fromName || null,
    asm_group_id: cfg?.asmGroupId || null,
    webhook_signed: !!cfg?.webhookKey,
  };
}

/**
 * Consent type a person needs to receive campaigns. Consent types are editable per
 * tenant, so 'marketing_comm' may not exist — order: the saved choice, 'marketing_comm',
 * the first type that looks like e-mail/newsletter, the first type.
 */
function resolveConsent(types, savedKey) {
  const list = Array.isArray(types) ? types.filter(t => t && t.key) : [];
  const pick = (savedKey && list.find(t => t.key === savedKey))
    || list.find(t => t.key === DEFAULT_CONSENT_KEY)
    || list.find(t => /e-?mail|newsletter/i.test(`${t.key} ${t.label || ''}`))
    || list[0];
  if (!pick) return { consent_key: savedKey || DEFAULT_CONSENT_KEY, consent_label: null };
  return { consent_key: pick.key, consent_label: pick.label || pick.key };
}

async function resolveTenantConsent(tenantId, cfg) {
  const types = await loadConsentTypes(tenantId);
  return resolveConsent(types, cfg?.consentKey);
}

function webhookUrl(token) {
  if (!token) return null;
  return `${String(config.appUrl || '').replace(/\/+$/, '')}/api/webhooks/sendgrid/${token}`;
}

async function settingsView(tenantId) {
  const cfg = await loadConfig(tenantId);
  const types = await loadConsentTypes(tenantId);
  return {
    has_api_key: !!cfg?.apiKey,
    api_key_hint: cfg?.apiKey ? cfg.apiKeyHint : null,
    from_email: cfg?.fromEmail || null,
    from_name: cfg?.fromName || null,
    reply_to: cfg?.replyTo || null,
    asm_group_id: cfg?.asmGroupId || null,
    has_webhook_public_key: !!cfg?.webhookKey,
    webhook_url: webhookUrl(cfg?.webhookToken),
    consent_key: resolveConsent(types, cfg?.consentKey).consent_key,
    consent_types: types.filter(t => t && t.key).map(t => ({ key: t.key, label: t.label || t.key })),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The public key from SendGrid (Mail Settings → Event Webhook) must be an EC P-256 key in SPKI DER, base64. */
function isValidWebhookPublicKey(value) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(value).trim(), 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

/**
 * Validates the PUT body. Missing/empty api_key or webhook_public_key = keep the saved
 * value; api_key: null = remove the key. Returns { error } or the normalized patch.
 */
function validateSettings(body, consentTypes) {
  const b = body || {};
  const fromEmail = String(b.from_email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(fromEmail)) return { error: 'Podaj poprawny adres nadawcy (from_email)' };
  const replyTo = String(b.reply_to ?? '').trim().toLowerCase();
  if (replyTo && !EMAIL_RE.test(replyTo)) return { error: 'Niepoprawny adres do odpowiedzi (reply_to)' };

  let asmGroupId = null;
  if (b.asm_group_id !== undefined && b.asm_group_id !== null && String(b.asm_group_id).trim() !== '') {
    const raw = String(b.asm_group_id).trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 0 || Number(raw) > 2147483647) {
      return { error: 'Numer grupy wypisów (asm_group_id) musi być liczbą całkowitą' };
    }
    asmGroupId = Number(raw);
  }

  let apiKey;   // undefined = keep, null = remove, string = replace
  if (b.api_key === null) apiKey = null;
  else if (typeof b.api_key === 'string' && b.api_key.trim()) {
    apiKey = b.api_key.trim();
    if (apiKey.length > 500 || /\s/.test(apiKey)) return { error: 'Niepoprawny klucz API SendGrid' };
  }

  let webhookKey;
  if (typeof b.webhook_public_key === 'string' && b.webhook_public_key.trim()) {
    webhookKey = b.webhook_public_key.trim();
    if (!isValidWebhookPublicKey(webhookKey)) {
      return { error: 'Niepoprawny klucz weryfikacji webhooka — wklej „Verification Key” z SendGrid (EC P-256, base64)' };
    }
  }

  let consentKey;
  if (b.consent_key !== undefined && b.consent_key !== null && String(b.consent_key).trim() !== '') {
    consentKey = String(b.consent_key).trim();
    if (!(consentTypes || []).some(t => t && t.key === consentKey)) {
      return { error: 'Nie ma takiego typu zgody' };
    }
  } else if (b.consent_key === null || b.consent_key === '') {
    consentKey = null;
  }

  return {
    fromEmail,
    fromName: String(b.from_name ?? '').trim().slice(0, 200) || null,
    replyTo: replyTo || null,
    asmGroupId,
    apiKey,
    webhookKey,
    consentKey,
  };
}

async function saveSettings(tenantId, patch, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const keepKey = patch.apiKey === undefined;
  const encryptedKey = patch.apiKey ? encrypt(patch.apiKey) : null;
  const hint = patch.apiKey ? patch.apiKey.slice(-4) : null;
  await db.query(
    `INSERT INTO tenant_sendgrid_config
       (tenant_id, api_key_encrypted, api_key_hint, from_email, from_name, reply_to, asm_group_id,
        webhook_public_key, webhook_token, consent_key, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       api_key_encrypted  = CASE WHEN $12 THEN tenant_sendgrid_config.api_key_encrypted ELSE EXCLUDED.api_key_encrypted END,
       api_key_hint       = CASE WHEN $12 THEN tenant_sendgrid_config.api_key_hint ELSE EXCLUDED.api_key_hint END,
       from_email         = EXCLUDED.from_email,
       from_name          = EXCLUDED.from_name,
       reply_to           = EXCLUDED.reply_to,
       asm_group_id       = EXCLUDED.asm_group_id,
       webhook_public_key = COALESCE(EXCLUDED.webhook_public_key, tenant_sendgrid_config.webhook_public_key),
       consent_key        = CASE WHEN $13 THEN tenant_sendgrid_config.consent_key ELSE EXCLUDED.consent_key END,
       updated_by         = EXCLUDED.updated_by,
       updated_at         = NOW()`,
    [tenantId, encryptedKey, hint, patch.fromEmail, patch.fromName, patch.replyTo, patch.asmGroupId,
      patch.webhookKey || null, token, patch.consentKey ?? null, userId, keepKey, patch.consentKey === undefined],
  );
}

async function findTenantIdByWebhookToken(token) {
  if (!/^[a-f0-9]{32,128}$/.test(String(token || ''))) return null;
  const { rows } = await db.query(
    `SELECT s.tenant_id FROM tenant_sendgrid_config s
       JOIN tenants t ON t.id = s.tenant_id AND t.deleted_at IS NULL
      WHERE s.webhook_token = $1`,
    [token],
  );
  return rows[0]?.tenant_id || null;
}

// ── SendGrid API ─────────────────────────────────────────────────────────────

/** One Mail Send call (up to 1000 recipients in personalizations). Returns X-Message-Id. */
async function send(cfg, body) {
  const r = await fetch(`${API}/mail/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status !== 202) {
    const text = await r.text().catch(() => '');
    throw new Error(`SendGrid ${r.status}: ${text.slice(0, 400)}`);
  }
  return r.headers.get('x-message-id');
}

async function apiGet(cfg, path) {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(r.status === 401
      ? 'SendGrid odrzucił klucz API — sprawdź klucz w ustawieniach SendGrid.'
      : r.status === 403
        ? 'Klucz SendGrid nie ma dostępu do szablonów (potrzebne uprawnienie „Template Engine: Read”).'
        : `SendGrid ${r.status}: ${text.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

const activeVersion = t => (t.versions || []).find(v => v.active === 1) || null;

/** Dynamic templates with their active version (subject, thumbnail, last change). */
async function listTemplates(cfg) {
  const d = await apiGet(cfg, '/templates?generations=dynamic&page_size=200');
  return (d.result || d.templates || []).map(t => {
    const v = activeVersion(t);
    return {
      id: t.id, name: t.name, subject: v?.subject || '', thumbnail_url: v?.thumbnail_url || null,
      version_id: v?.id || null, updated_at: v?.updated_at || t.updated_at || null,
    };
  });
}

/** One template with the active version's HTML (preview in the CRM). */
async function getTemplate(cfg, id) {
  const t = await apiGet(cfg, `/templates/${encodeURIComponent(id)}`);
  const v = activeVersion(t);
  return {
    id: t.id, name: t.name, subject: v?.subject || '', html: v?.html_content || '', thumbnail_url: v?.thumbnail_url || null,
    version_id: v?.id || null, updated_at: v?.updated_at || t.updated_at || null,
  };
}

/** Message from a dynamic template: subject and content are in the template, SendGrid adds UTM. */
function templateMessage(cfg, { templateId, utm, categories = [] }) {
  const msg = {
    from: { email: cfg.fromEmail, name: cfg.fromName },
    template_id: templateId,
    asm: cfg.asmGroupId ? { group_id: cfg.asmGroupId } : undefined,
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
      ...(utm ? { ganalytics: { enable: true, utm_source: 'crm', utm_medium: 'email', utm_campaign: utm } } : {}),
    },
    categories: categories.slice(0, 10),
  };
  if (cfg.replyTo) msg.reply_to = { email: cfg.replyTo };
  return msg;
}

/** Event Webhook signature: ECDSA P-256 / SHA-256 over timestamp + raw body. */
function verifyWebhookSignature(publicKey, rawBody, signature, timestamp) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('sha256', Buffer.concat([Buffer.from(String(timestamp || '')), rawBody]),
      key, Buffer.from(String(signature || ''), 'base64'));
  } catch {
    return false;
  }
}

module.exports = {
  ENV_TAG,
  loadConfig,
  status,
  resolveConsent,
  resolveTenantConsent,
  settingsView,
  validateSettings,
  saveSettings,
  isValidWebhookPublicKey,
  findTenantIdByWebhookToken,
  webhookUrl,
  send,
  listTemplates,
  getTemplate,
  templateMessage,
  verifyWebhookSignature,
};
