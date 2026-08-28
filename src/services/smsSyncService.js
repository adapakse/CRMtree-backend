'use strict';
// src/services/smsSyncService.js
//
// Shared SMS sync logic — used by both routes/sms.js (on-demand "Sprawdź
// nowe" / opening the SMS tab) and jobs/sms-poller.js (periodic background
// sync, since ip-pbx.eu has no webhook for incoming SMS). Extracted so the
// axios call + dedup insert isn't duplicated between the two callers.

const axios  = require('axios');
const db     = require('../config/database');
const logger = require('../utils/logger');

const PBX_BASE = 'https://ub24as22.ip-pbx.eu/virtualPBX/api/';

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
          (tenant_id, owner_user_id, ${entityCol}, direction, from_phone, to_phone, body, status, ip_pbx_message_id, created_at, is_read)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (owner_user_id, ip_pbx_message_id) WHERE ip_pbx_message_id IS NOT NULL DO NOTHING
      `, [tenantId, userId, entityId, m.direction, m.from_value, m.to_value, m.body, m.status, m.id, m.created_at, m.direction === 'outbound']);
    }
  } catch (err) {
    logger.warn('[SmsSync] sync failed for number', { number, error: err.response?.status || err.message });
    // Best-effort — one failing number shouldn't block the rest of the thread/job.
  }
}

module.exports = { normalizePolishPhone, syncNumber, PBX_BASE };
