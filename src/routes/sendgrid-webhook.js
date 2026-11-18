'use strict';
// routes/sendgrid-webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/webhooks/sendgrid/:token — SendGrid Event Webhook of ONE tenant (no CRM session).
// The token in the URL identifies the tenant (tenant_sendgrid_config.webhook_token).
// When the tenant saved the verification key, the ECDSA signature is required; before
// that (first setup) events are accepted with a warning in the log.
// Events are matched by custom_args (tenant_id, campaign_id, recipient_id) set at send
// time and must belong to the token's tenant. Unsubscribe / spam report → that
// person's campaign consent = denied + 'marketing_email' activity on the company.
// The body must stay raw (express.raw) for the signature — mounted in app.js before express.json.
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const db = require('../config/database');
const logger = require('../utils/logger');
const sendgrid = require('../services/sendgridService');

// Status "strength": a stronger one is never overwritten by a weaker one (e.g. a click after an unsubscribe)
const RANK = { queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, dropped: 8, bounced: 9, unsubscribed: 9, spam_report: 9 };
const STATUS_OF = { delivered: 'delivered', open: 'opened', click: 'clicked', bounce: 'bounced', dropped: 'dropped',
  unsubscribe: 'unsubscribed', group_unsubscribe: 'unsubscribed', spamreport: 'spam_report' };
const TIMESTAMP_COLUMN = { delivered: 'delivered_at', open: 'opened_at', click: 'clicked_at' };

// "dropped" = SendGrid did not send the mail. The reason says why: an address unsubscribed /
// bounced / reported spam earlier on this account — treated as such. Other reasons stay "dropped".
function droppedAs(reason) {
  const r = String(reason || '').trim();
  if (/^unsubscribed address$/i.test(r)) return 'unsubscribed';
  if (/^bounced address$/i.test(r) || /^invalid$/i.test(r)) return 'bounced';
  if (/^spam reporting address$/i.test(r)) return 'spam_report';
  return 'dropped';
}

router.post('/:token', async (req, res) => {
  let tenantId;
  let cfg;
  try {
    tenantId = await sendgrid.findTenantIdByWebhookToken(req.params.token);
    if (!tenantId) return res.status(404).end();
    cfg = await sendgrid.loadConfig(tenantId);
  } catch (err) {
    logger.error('[sendgrid-webhook] tenant lookup failed', { error: err.message });
    return res.status(500).end();
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  if (cfg.webhookKey) {
    const ok = sendgrid.verifyWebhookSignature(cfg.webhookKey, raw,
      req.get('X-Twilio-Email-Event-Webhook-Signature'), req.get('X-Twilio-Email-Event-Webhook-Timestamp'));
    if (!ok) return res.status(403).end();
  } else {
    // Without the verification key anyone knowing the URL could fake an unsubscribe — needed only for the first setup
    logger.warn('[sendgrid-webhook] unsigned events accepted — the tenant has no webhook verification key yet', { tenantId });
  }

  let events;
  try { events = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  if (!Array.isArray(events)) return res.status(400).end();
  res.status(200).end();   // SendGrid retries without a 2xx — answer at once, process afterwards

  await processEvents(tenantId, events);
});

async function processEvents(tenantId, events) {
  for (const e of events) {
    try {
      await handleEvent(tenantId, e);
    } catch (err) {
      logger.error('[sendgrid-webhook] event failed', { tenantId, event: e?.event, error: err.message });
    }
  }
}

async function handleEvent(tenantId, e) {
  const recipientId = parseInt(e?.recipient_id, 10);
  if (!recipientId) return;                                     // mail outside CRM campaigns (other systems on the account)
  if (e.crm && e.crm !== sendgrid.ENV_TAG) return;              // mail from another CRM environment (INT is a copy of PROD)
  if (String(e.tenant_id || '') !== String(tenantId)) return;   // event of another tenant — never cross tenants
  const { rows } = await db.query(
    `SELECT id, campaign_id, status, partner_id, lead_id, email
       FROM crm_campaign_recipients WHERE id = $1 AND tenant_id = $2`,
    [recipientId, tenantId]);
  const r = rows[0];
  // The recipient must belong to the campaign named in the same mail — otherwise it comes from another database
  if (!r || String(r.campaign_id) !== String(e.campaign_id)) return;

  const at = new Date((parseInt(e.timestamp, 10) || Date.now() / 1000) * 1000);
  const ins = await db.query(`
    INSERT INTO crm_campaign_events (tenant_id, recipient_id, campaign_id, event, url, sg_event_id, occurred_at, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (tenant_id, sg_event_id) WHERE sg_event_id IS NOT NULL DO NOTHING RETURNING id`,
    [tenantId, r.id, r.campaign_id, String(e.event || '').slice(0, 40), e.url ? String(e.url).slice(0, 2000) : null,
      e.sg_event_id ? String(e.sg_event_id).slice(0, 100) : null, at,
      JSON.stringify({ reason: e.reason, type: e.type, useragent: e.useragent })]);
  if (!ins.rowCount) return;   // already processed (SendGrid retried)

  const next = e.event === 'dropped' ? droppedAs(e.reason) : STATUS_OF[e.event];
  const col = TIMESTAMP_COLUMN[e.event];
  if (col) {
    const alsoOpened = col === 'clicked_at' ? ', opened_at = COALESCE(opened_at, $3)' : '';
    await db.query(`UPDATE crm_campaign_recipients SET ${col} = COALESCE(${col}, $3)${alsoOpened}, last_event_at = $3
                     WHERE id = $1 AND tenant_id = $2`, [r.id, tenantId, at]);
  } else {
    await db.query(`UPDATE crm_campaign_recipients SET last_event_at = $3 WHERE id = $1 AND tenant_id = $2`, [r.id, tenantId, at]);
  }
  if (next && (RANK[next] ?? 0) > (RANK[r.status] ?? 0)) {
    await db.query(`UPDATE crm_campaign_recipients SET status = $3 WHERE id = $1 AND tenant_id = $2`, [r.id, tenantId, next]);
  }

  // Unsubscribe or spam → the person's campaign consent is withdrawn (later campaigns skip them)
  if (next === 'unsubscribed' || next === 'spam_report') {
    const cfg = await sendgrid.loadConfig(tenantId);
    const { consent_key: consentKey } = await sendgrid.resolveTenantConsent(tenantId, cfg);
    const why = next === 'unsubscribed' ? 'Wypisał(a) się z maili marketingowych' : 'Zgłosił(a) mail z kampanii jako spam';
    await db.query(
      `INSERT INTO crm_contact_consents (tenant_id, email, consent_key, value, source, updated_at)
       VALUES ($1, lower(trim($2)), $3, 'denied', $4, NOW())
       ON CONFLICT (tenant_id, email, consent_key)
       DO UPDATE SET value = 'denied', source = EXCLUDED.source, note = NULL, updated_at = NOW(), updated_by = NULL`,
      [tenantId, r.email, consentKey, next === 'unsubscribed' ? 'sendgrid_unsubscribe' : 'sendgrid_spam']);
    const body = `Zgoda marketingowa osoby ${r.email} zmieniona na „Brak zgody”.`;
    if (r.partner_id) {
      await db.query(
        `INSERT INTO crm_partner_activities (partner_id, tenant_id, type, title, body, email_provider, activity_at)
         VALUES ($1, $2, 'marketing_email', $3, $4, 'sendgrid', NOW())`, [r.partner_id, tenantId, why, body]);
    }
    if (r.lead_id) {
      await db.query(
        `INSERT INTO crm_lead_activities (lead_id, tenant_id, type, title, body, email_provider, activity_at)
         VALUES ($1, $2, 'marketing_email', $3, $4, 'sendgrid', NOW())`, [r.lead_id, tenantId, why, body]);
    }
  }
}

module.exports = router;
module.exports.processEvents = processEvents;
