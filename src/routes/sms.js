'use strict';
// src/routes/sms.js
//
// SMS integration — same provider/account as telephony (ip-pbx.eu), same
// per-user PAT (user_pbx_credentials). ip-pbx.eu has no webhook for incoming
// SMS, so unlike WhatsApp this is a local log (sms_messages) populated by a
// user-initiated sync (opening the tab / "Sprawdź nowe"), never push. Sync is
// always entity-scoped (a lead's or partner's known numbers), so lead_id/
// partner_id is known directly at insert time — no phone-lookup step needed,
// unlike WhatsApp's webhook-driven resolveIncomingSender().

const router = require('express').Router();
const axios  = require('axios');
const { body, param } = require('express-validator');
const db = require('../config/database');
const { requireAuth }             = require('../middleware/auth');
const { crmAuth, requireFeature } = require('../middleware/crm-rbac');
const { validate }                = require('../middleware/errorHandler');

const PBX_BASE = 'https://ub24as22.ip-pbx.eu/virtualPBX/api/';

router.use(requireAuth, crmAuth, requireFeature('pbx'));

// ip-pbx.eu rejects numbers without a country code (400) — CRM phone fields
// are often stored as bare 9-digit Polish numbers. Same normalization rule
// as pbx.service.ts's buildTarget() on the frontend (for SIP dialing).
function normalizePolishPhone(raw) {
  const trimmed = String(raw).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return '+' + digits;
  if (digits.startsWith('00') && digits.length > 11) return '+' + digits.slice(2);
  if (digits.length === 9) return '+48' + digits;
  return '+' + digits;
}

// Grouping/matching key — last 9 digits, ignores country-code prefix and
// formatting differences (spaces, +, 00 vs +). Same approach as /pbx/phone-lookup.
function last9(raw) {
  return String(raw || '').replace(/\D/g, '').slice(-9);
}

async function getOwnCreds(userId) {
  const { rows } = await db.query(
    'SELECT pat_token, direct_phone FROM user_pbx_credentials WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

// crm_partners.id is a UUID, but partner detail views are also reachable by
// dwh_partner_id (integer) — same dual lookup as crm-whatsapp.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolvePartner(rawId, tenantId) {
  const cols = 'id, phone, billing_phone, agent_phone';
  if (UUID_RE.test(String(rawId))) {
    const { rows } = await db.query(
      `SELECT ${cols} FROM crm_partners WHERE id = $1 AND tenant_id = $2`,
      [rawId, tenantId],
    );
    return rows[0] || null;
  }
  const num = parseInt(rawId, 10);
  if (isNaN(num)) return null;
  const { rows } = await db.query(
    `SELECT ${cols} FROM crm_partners WHERE dwh_partner_id = $1 AND tenant_id = $2`,
    [num, tenantId],
  );
  return rows[0] || null;
}

async function collectLeadNumbers(leadId, tenantId) {
  const { rows: leadRows } = await db.query(
    'SELECT id, phone FROM crm_leads WHERE id = $1 AND tenant_id = $2',
    [leadId, tenantId],
  );
  if (!leadRows.length) return null;
  const numbers = [];
  if (leadRows[0].phone) numbers.push({ label: `Główny: ${leadRows[0].phone}`, number: leadRows[0].phone });
  const { rows: contacts } = await db.query(
    'SELECT contact_name, phone FROM crm_lead_contacts WHERE lead_id = $1 AND phone IS NOT NULL', [leadId]
  );
  contacts.forEach(c => { if (c.phone) numbers.push({ label: `${c.contact_name || 'Kontakt'}: ${c.phone}`, number: c.phone }); });
  return numbers;
}

function collectPartnerNumbers(partner) {
  const numbers = [];
  if (partner.phone)         numbers.push({ label: `Kontakt: ${partner.phone}`, number: partner.phone });
  if (partner.billing_phone) numbers.push({ label: `Rozliczenia: ${partner.billing_phone}`, number: partner.billing_phone });
  if (partner.agent_phone)   numbers.push({ label: `Agent: ${partner.agent_phone}`, number: partner.agent_phone });
  return numbers;
}

// Pulls the full thread for one external number from ip-pbx.eu and upserts
// each message into sms_messages (dedup via the partial unique index on
// (owner_user_id, ip_pbx_message_id) — safe to call repeatedly).
async function syncNumber({ userId, tenantId, creds, entityCol, entityId, number }) {
  try {
    const { data } = await axios.get(`${PBX_BASE}sms/correspondence`, {
      params: {
        company_side_type:  'direct',
        company_side_value: creds.direct_phone,
        external_number:    normalizePolishPhone(number),
        limit: 200,
        offset: 0,
      },
      headers: { Authorization: `Bearer ${creds.pat_token}` },
      timeout: 10_000,
    });

    for (const m of (data.messages || [])) {
      await db.query(`
        INSERT INTO sms_messages
          (tenant_id, owner_user_id, ${entityCol}, direction, from_phone, to_phone, body, status, ip_pbx_message_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (owner_user_id, ip_pbx_message_id) WHERE ip_pbx_message_id IS NOT NULL DO NOTHING
      `, [tenantId, userId, entityId, m.direction, m.from_value, m.to_value, m.body, m.status, m.id, m.created_at]);
    }
  } catch (err) {
    console.warn('[SMS sync] failed for number', number, ':', err.response?.status, err.message);
    // Best-effort — one failing number shouldn't block the rest of the thread.
  }
}

async function buildThreadResponse(res, { tenantId, userId, entityCol, entityId, numbers }) {
  const creds = await getOwnCreds(userId);
  if (!creds?.pat_token) {
    return res.status(404).json({ error: 'Brak tokenu PBX. Skonfiguruj swój token w Moich ustawieniach.' });
  }
  if (!creds.direct_phone) {
    return res.status(422).json({ error: 'Twoje konto ip-pbx.eu nie ma przypisanego numeru bezpośredniego.' });
  }

  for (const n of numbers) {
    await syncNumber({ userId, tenantId, creds, entityCol, entityId, number: n.number });
  }

  const { rows } = await db.query(
    `SELECT id, direction, from_phone, to_phone, body, status, created_at
     FROM sms_messages WHERE tenant_id = $1 AND ${entityCol} = $2 ORDER BY created_at ASC`,
    [tenantId, entityId],
  );

  // Every known number becomes its own conversation card, even with zero
  // messages so far — the user can still open it and send the first SMS.
  const conversations = numbers.map(n => ({
    label: n.label,
    number: n.number,
    messages: rows
      .filter(r => last9(r.direction === 'outbound' ? r.to_phone : r.from_phone) === last9(n.number))
      .map(r => ({
        id: r.id, direction: r.direction, body: r.body, status: r.status,
        created_at: r.created_at, from: r.from_phone, to: r.to_phone,
      })),
  }));

  res.json({ conversations });
}

// ── GET /thread/lead/:leadId ────────────────────────────────────────────────
router.get('/thread/lead/:leadId',
  [param('leadId').isInt()], validate,
  async (req, res) => {
    const leadId = parseInt(req.params.leadId, 10);
    const numbers = await collectLeadNumbers(leadId, req.tenantId);
    if (numbers === null) return res.status(404).json({ error: 'Lead nie znaleziony' });
    if (!numbers.length) return res.json({ conversations: [] });
    await buildThreadResponse(res, { tenantId: req.tenantId, userId: req.user.id, entityCol: 'lead_id', entityId: leadId, numbers });
  },
);

// ── GET /thread/partner/:partnerId ──────────────────────────────────────────
router.get('/thread/partner/:partnerId',
  [param('partnerId').isString().trim().notEmpty()], validate,
  async (req, res) => {
    const partner = await resolvePartner(req.params.partnerId, req.tenantId);
    if (!partner) return res.status(404).json({ error: 'Partner nie znaleziony' });
    const numbers = collectPartnerNumbers(partner);
    if (!numbers.length) return res.json({ conversations: [] });
    await buildThreadResponse(res, { tenantId: req.tenantId, userId: req.user.id, entityCol: 'partner_id', entityId: partner.id, numbers });
  },
);

async function sendSms(req, res, { toPhone }) {
  const creds = await getOwnCreds(req.user.id);
  if (!creds?.pat_token) {
    return res.status(404).json({ error: 'Brak tokenu PBX. Skonfiguruj swój token w Moich ustawieniach.' });
  }

  const normalizedTo = normalizePolishPhone(toPhone);
  try {
    await axios.post(`${PBX_BASE}sms`,
      { from: 'direct', to: normalizedTo, body: req.body.message },
      { headers: { Authorization: `Bearer ${creds.pat_token}` }, timeout: 10_000 },
    );

    // Deliberately NOT inserted into sms_messages here — the next thread sync
    // (tab reload / "Sprawdź nowe") will pull this exact message back from
    // ip-pbx.eu with its real ip_pbx_message_id and persist it then. Inserting
    // it here too used to create a permanent duplicate row (one with NULL
    // ip_pbx_message_id from this insert, one from the later sync) since the
    // dedup unique index can't match a NULL-keyed row to a real one.
    res.json({
      id: `pending-${Date.now()}`, direction: 'outbound', body: req.body.message,
      status: 'sent', created_at: new Date().toISOString(),
      from: creds.direct_phone || '', to: normalizedTo,
    });
  } catch (err) {
    const status = err.response?.status;
    console.error('[SMS send] error:', status, JSON.stringify(err.response?.data));
    res.status(status || 502).json({ error: 'Błąd wysyłki SMS', detail: err.message });
  }
}

// ── POST /send/lead/:leadId ────────────────────────────────────────────────
router.post('/send/lead/:leadId',
  [
    param('leadId').isInt(),
    body('message').isString().trim().notEmpty(),
    body('to_phone').optional({ nullable: true }).isString().trim(),
  ], validate,
  async (req, res) => {
    const leadId = parseInt(req.params.leadId, 10);
    const { rows } = await db.query(
      'SELECT id, phone FROM crm_leads WHERE id = $1 AND tenant_id = $2',
      [leadId, req.tenantId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead nie znaleziony' });

    const toPhone = req.body.to_phone || rows[0].phone;
    if (!toPhone) return res.status(400).json({ error: 'Brak numeru telefonu do wysyłki SMS.' });

    await sendSms(req, res, { toPhone });
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
    const partner = await resolvePartner(req.params.partnerId, req.tenantId);
    if (!partner) return res.status(404).json({ error: 'Partner nie znaleziony' });

    const toPhone = req.body.to_phone || partner.phone;
    if (!toPhone) return res.status(400).json({ error: 'Brak numeru telefonu do wysyłki SMS.' });

    await sendSms(req, res, { toPhone });
  },
);

module.exports = router;
