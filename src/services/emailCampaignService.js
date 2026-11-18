'use strict';
// services/emailCampaignService.js
// ─────────────────────────────────────────────────────────────────────────────
// E-mail campaigns (port from worktrips-doc): who gets the mail and who is skipped
// (buildPreview) and the background send through the tenant's SendGrid account.
// Everything is scoped to one tenant — candidates, consents, send history.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');
const logger = require('../utils/logger');
const sendgrid = require('./sendgridService');
const { getStageConfig, stageLabel } = require('./leadStageService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INBOUND_SOURCES = ['website', 'formularz', 'formularz_online', 'inbound'];
const DWH_PREFIX_RE = /^[a-z][a-z0-9_]*$/;
const SEND_BATCH = 500;
const PREVIEW_LIMIT = 1000;

const EXCLUSION_LABELS = {
  no_email:       'Brak adresu e-mail',
  invalid_email:  'Niepoprawny adres e-mail',
  no_consent:     'Osoba nie ma zgody marketingowej',
  suppressed:     'Wypisany lub adres odbity',
  cooldown:       'Mail z kampanii w ostatnich dniach',
  recent_contact: 'Świeży kontakt handlowca',
  duplicate:      'Ten sam adres już jest na liście',
  not_in_crm:     'Adresu z pliku nie ma w CRM',
};

const PARTNER_STATUS_LABELS = { onboarding: 'Wdrożenie', active: 'Aktywny', inactive: 'Nieaktywny', churned: 'Utracony' };

function arr(v) {
  if (!Array.isArray(v)) return null;
  const out = v.filter(x => x !== null && x !== undefined && String(x).trim() !== '').map(String);
  return out.length ? out : null;
}
function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function numOrNull(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function dateOrNull(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
}

/** dwh.<prefix>_sales of the tenant, or null when the tenant has no warehouse data. */
async function dwhSalesTable(dwhPrefix) {
  if (!DWH_PREFIX_RE.test(String(dwhPrefix || ''))) return null;
  const table = `dwh.${dwhPrefix}_sales`;
  const { rows } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
  return rows[0]?.ok ? table : null;
}

/** Recipient groups. "Dormant" needs warehouse sales (no sale for 90 days); stage names follow the tenant's funnel. */
function buildSegments(stageConfig, hasDwh) {
  const open = stageConfig.stages.filter(s => s.active && s.kind === 'open');
  const inboundStages = open.slice(0, 2);
  const stageNames = inboundStages.map(s => `„${stageLabel(s)}”`).join(' lub ');
  return [
    { key: 'churn',              label: 'Churn — byli klienci',        audience: 'partners', description: 'Partnerzy ze statusem „Utracony”' },
    { key: 'dormant',            label: 'Dormant — brak zakupów',      audience: 'partners',
      description: hasDwh ? 'Partnerzy bez sprzedaży w hurtowni danych od 90 dni' : 'Brak danych sprzedażowych (hurtowni danych) dla tej firmy',
      ...(hasDwh ? {} : { unavailable: true }) },
    { key: 'no_contact_90',      label: 'Brak kontaktu od 3 miesięcy', audience: 'both',     description: 'Żadnej aktywności handlowca w CRM od 90 dni' },
    { key: 'inbound_no_contact', label: 'Inbound — brak połączenia',   audience: 'leads',
      description: `Leady ze strony WWW${stageNames ? ` na etapie ${stageNames}` : ''}, bez rozmowy ani spotkania` },
  ];
}

// criteria: { audience, segments[], industries[], statuses[], stages[], owners[], tags[],
//             turnover_min, turnover_max (PLN since the start of the year, partners from the DWH),
//             last_contact_from, last_contact_to (YYYY-MM-DD), source: 'filters' | 'csv', csv_emails[] }
// rules:    { consentKey, min_days_between_sends, exclude_recent_contact_days }
// opts:     { full: true } — the whole list without the preview limit (export, send)
async function buildPreview({ tenantId, dwhPrefix }, criteria = {}, rules = {}, opts = {}) {
  const [stageConfig, salesTable] = await Promise.all([getStageConfig(tenantId), dwhSalesTable(dwhPrefix)]);
  const segmentDefs = buildSegments(stageConfig, !!salesTable);
  const audience  = ['partners', 'leads', 'both'].includes(criteria.audience) ? criteria.audience : 'both';
  const segments  = (arr(criteria.segments) || []).filter(s => segmentDefs.some(x => x.key === s && !x.unavailable));
  const consent   = rules.consentKey;
  const minDays   = rules.min_days_between_sends === 0 ? 0 : (intOrNull(rules.min_days_between_sends) ?? 30);
  const recentDays = intOrNull(rules.exclude_recent_contact_days);

  const fromCsv    = criteria.source === 'csv';
  const csvEmails  = fromCsv ? [...new Set((arr(criteria.csv_emails) || []).map(e => e.trim().toLowerCase()))] : [];
  // A list from a file replaces groups and filters — the skip rules (consent, unsubscribes, spacing) still apply
  const industries = fromCsv ? null : arr(criteria.industries);
  const owners     = fromCsv ? null : arr(criteria.owners);
  const tags       = fromCsv ? null : arr(criteria.tags);
  const turnMin    = fromCsv ? null : numOrNull(criteria.turnover_min);
  const turnMax    = fromCsv ? null : numOrNull(criteria.turnover_max);
  const lcFrom     = fromCsv ? null : dateOrNull(criteria.last_contact_from);
  const lcTo       = fromCsv ? null : dateOrNull(criteria.last_contact_to);
  const audienceEff = fromCsv ? 'both' : (turnMin !== null || turnMax !== null ? 'partners' : audience);   // only partners have turnover

  const parts = [];
  // $1 tenant, $2 consent, $3 industries, $4 owners, $5 tags, $6 csv
  const params = [tenantId, consent, industries, owners, tags, fromCsv ? csvEmails : null];

  if (audienceEff !== 'leads') {
    params.push(fromCsv ? null : arr(criteria.statuses)); const pStatus = params.length;
    params.push(turnMin); const pTMin = params.length;
    params.push(turnMax); const pTMax = params.length;
    // salesTable is a validated identifier (DWH_PREFIX_RE + to_regclass), never user input
    const dwhJoin = salesTable ? `
      LEFT JOIN (
        SELECT partner_id,
               SUM(gross_sales_value_pln) FILTER (WHERE sale_date >= date_trunc('year', CURRENT_DATE)) AS turnover,
               MAX(sale_date) AS last_sale
        FROM ${salesTable} GROUP BY partner_id
      ) dw ON dw.partner_id = p.dwh_partner_id` : '';
    parts.push(`
      SELECT 'partner'::text AS entity_type, p.id::text AS entity_id, p.company, pp.contact_name,
             pp.email, p.industry, p.status AS status, p.manager_id AS owner_id, p.tags,
             (SELECT c.value FROM crm_contact_consents c
               WHERE c.tenant_id = p.tenant_id AND c.email = pp.email AND c.consent_key = $2) AS consent,
             (SELECT max(a.activity_at) FROM crm_partner_activities a
               WHERE a.partner_id = p.id AND a.tenant_id = p.tenant_id AND a.type <> 'marketing_email') AS last_activity_at,
             (p.status = 'churned') AS seg_churn,
             ${salesTable ? `COALESCE(dw.last_sale < CURRENT_DATE - 90, false)` : 'false'} AS seg_dormant,
             false AS seg_inbound,
             ${salesTable ? 'dw.turnover' : 'NULL::numeric'} AS turnover
      FROM crm_partners p
      ${dwhJoin}
      CROSS JOIN LATERAL (
        SELECT p.contact_name, NULLIF(lower(trim(p.email)), '') AS email
        UNION
        SELECT pc.contact_name, lower(trim(pc.email)) FROM crm_partner_contacts pc
        WHERE pc.partner_id = p.id AND pc.tenant_id = p.tenant_id AND NULLIF(trim(pc.email), '') IS NOT NULL
          AND lower(trim(pc.email)) IS DISTINCT FROM NULLIF(lower(trim(p.email)), '')
      ) pp
      WHERE p.tenant_id = $1
        AND ($3::text[] IS NULL OR p.industry = ANY($3))
        AND ($4::text[] IS NULL OR p.manager_id::text = ANY($4))
        AND ($5::text[] IS NULL OR p.tags && $5)
        AND ($6::text[] IS NULL OR pp.email = ANY($6))
        AND ($${pStatus}::text[] IS NULL OR p.status = ANY($${pStatus}))
        AND ($${pTMin}::numeric IS NULL OR COALESCE(${salesTable ? 'dw.turnover' : 'NULL::numeric'}, 0) >= $${pTMin})
        AND ($${pTMax}::numeric IS NULL OR COALESCE(${salesTable ? 'dw.turnover' : 'NULL::numeric'}, 0) <= $${pTMax})`);
  }
  if (audienceEff !== 'partners') {
    params.push(fromCsv ? null : arr(criteria.stages)); const lStage = params.length;
    params.push(INBOUND_SOURCES); const lInb = params.length;
    params.push(stageConfig.stages.filter(s => s.active && s.kind === 'open').slice(0, 2).map(s => s.key)); const lInbStages = params.length;
    params.push(stageConfig.archivedKey); const lArch = params.length;
    parts.push(`
      SELECT 'lead'::text AS entity_type, l.id::text AS entity_id, l.company, lp.contact_name,
             lp.email, l.industry, l.stage AS status, l.assigned_to AS owner_id, l.tags,
             (SELECT c.value FROM crm_contact_consents c
               WHERE c.tenant_id = l.tenant_id AND c.email = lp.email AND c.consent_key = $2) AS consent,
             (SELECT max(a.activity_at) FROM crm_lead_activities a
               WHERE a.lead_id = l.id AND a.tenant_id = l.tenant_id AND a.type <> 'marketing_email') AS last_activity_at,
             false AS seg_churn, false AS seg_dormant,
             (lower(COALESCE(l.source, '')) = ANY($${lInb})
              AND l.stage = ANY($${lInbStages})
              AND NOT EXISTS (SELECT 1 FROM crm_lead_activities a
                              WHERE a.lead_id = l.id AND a.tenant_id = l.tenant_id AND a.type IN ('call', 'meeting'))) AS seg_inbound,
             NULL::numeric AS turnover
      FROM crm_leads l
      CROSS JOIN LATERAL (
        SELECT l.contact_name, NULLIF(lower(trim(l.email)), '') AS email
        UNION
        SELECT lc.contact_name, lower(trim(lc.email)) FROM crm_lead_contacts lc
        WHERE lc.lead_id = l.id AND lc.tenant_id = l.tenant_id AND NULLIF(trim(lc.email), '') IS NOT NULL
          AND lower(trim(lc.email)) IS DISTINCT FROM NULLIF(lower(trim(l.email)), '')
      ) lp
      WHERE l.tenant_id = $1 AND l.archived_at IS NULL
        AND ($${lArch}::text IS NULL OR l.stage <> $${lArch})
        AND ($3::text[] IS NULL OR l.industry = ANY($3))
        AND ($4::text[] IS NULL OR l.assigned_to::text = ANY($4))
        AND ($5::text[] IS NULL OR l.tags && $5)
        AND ($6::text[] IS NULL OR lp.email = ANY($6))
        AND ($${lStage}::text[] IS NULL OR l.stage = ANY($${lStage}))`);
  }

  const { rows } = await db.query(`
    SELECT x.*, u.display_name AS owner_name
    FROM (${parts.join(' UNION ALL ')}) x
    LEFT JOIN users u ON u.id = x.owner_id AND u.tenant_id = $1
    ORDER BY x.company`, params);

  // Segments: OR between the chosen ones; none chosen = everyone matching the filters
  const now = Date.now();
  const noContact = r => !r.last_activity_at || (now - new Date(r.last_activity_at).getTime()) > 90 * 864e5;
  const inSegment = r => fromCsv || !segments.length || segments.some(s =>
    (s === 'churn' && r.seg_churn) || (s === 'dormant' && r.seg_dormant) ||
    (s === 'inbound_no_contact' && r.seg_inbound) || (s === 'no_contact_90' && noContact(r)));
  // Last salesperson contact within the date range (campaign mails do not count)
  const lcFromT = lcFrom ? new Date(lcFrom + 'T00:00:00').getTime() : null;
  const lcToT   = lcTo ? new Date(lcTo + 'T00:00:00').getTime() + 864e5 : null;
  const inContactRange = r => (lcFromT === null && lcToT === null) || (!!r.last_activity_at
    && (lcFromT === null || new Date(r.last_activity_at).getTime() >= lcFromT)
    && (lcToT === null || new Date(r.last_activity_at).getTime() < lcToT));
  const candidates = rows.filter(r => inSegment(r) && inContactRange(r));
  // Addresses from the file that are not in the CRM — shown as skipped, with the reason
  if (fromCsv) {
    const inCrm = new Set(rows.map(r => r.email).filter(Boolean));
    csvEmails.filter(e => !inCrm.has(e)).forEach(e => candidates.push({
      entity_type: null, entity_id: null, company: null, contact_name: null, email: e, not_in_crm: true,
    }));
  }

  // Send history of this tenant: unsubscribed/bounced for good, last send per address
  const emails = [...new Set(candidates.map(r => r.email).filter(Boolean))];
  const history = new Map();
  if (emails.length) {
    const { rows: h } = await db.query(`
      SELECT lower(email) AS email,
             bool_or(status IN ('bounced', 'unsubscribed', 'spam_report')) AS suppressed,
             max(sent_at) AS last_sent_at
      FROM crm_campaign_recipients
      WHERE tenant_id = $1 AND lower(email) = ANY($2)
      GROUP BY lower(email)`, [tenantId, emails]);
    h.forEach(x => history.set(x.email, x));
  }

  const seen = new Set();
  const excluded = Object.fromEntries(Object.keys(EXCLUSION_LABELS).map(k => [k, 0]));
  const list = candidates.map(r => {
    const hist = r.email ? history.get(r.email) : null;
    let reason = null;
    if (r.not_in_crm)                                                 reason = 'not_in_crm';
    else if (!r.email)                                                reason = 'no_email';
    else if (!EMAIL_RE.test(r.email))                                 reason = 'invalid_email';
    else if (r.consent !== 'granted')                                 reason = 'no_consent';
    else if (hist?.suppressed)                                        reason = 'suppressed';
    else if (minDays && hist?.last_sent_at && now - new Date(hist.last_sent_at).getTime() < minDays * 864e5) reason = 'cooldown';
    else if (recentDays && r.last_activity_at && now - new Date(r.last_activity_at).getTime() < recentDays * 864e5) reason = 'recent_contact';
    else if (seen.has(r.email))                                       reason = 'duplicate';
    if (reason) excluded[reason]++; else seen.add(r.email);
    return {
      entity_type: r.entity_type, entity_id: r.entity_id, company: r.company, contact_name: r.contact_name,
      email: r.email, industry: r.industry, status: r.status, owner_name: r.owner_name,
      consent: r.consent || 'no_data', last_activity_at: r.last_activity_at,
      turnover: r.turnover !== null && r.turnover !== undefined ? Number(r.turnover) : null,
      reason, reason_label: reason ? EXCLUSION_LABELS[reason] : null,
    };
  });

  return {
    total_candidates: candidates.length,
    to_send: seen.size,
    excluded,
    excluded_total: candidates.length - seen.size,
    exclusion_labels: EXCLUSION_LABELS,
    recipients: opts.full ? list : list.slice(0, PREVIEW_LIMIT),
    truncated: !opts.full && list.length > PREVIEW_LIMIT,
  };
}

/** First name for personalisation: first word of the contact name, skipping a title. */
function firstNameOf(contactName) {
  const words = String(contactName || '').trim().split(/\s+/);
  return /^(pan|pani|dr|mgr|inż\.?)$/i.test(words[0] || '') ? (words[1] || '') : (words[0] || '');
}

/** Background send in batches; every sent mail is logged as a 'marketing_email' activity of the company. */
async function sendCampaign(cfg, campaign, recipients, userId) {
  const tenantId = campaign.tenant_id;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += SEND_BATCH) {
    const part = recipients.slice(i, i + SEND_BATCH);
    const msg = sendgrid.templateMessage(cfg, {
      templateId: campaign.sendgrid_template_id, utm: campaign.utm_campaign,
      categories: ['crm-kampania', 'kampania-' + campaign.id],
    });
    msg.personalizations = part.map(r => ({
      to: [{ email: r.email }],
      dynamic_template_data: { imie: firstNameOf(r.contact_name), firma: r.company || '' },
      custom_args: { tenant_id: String(tenantId), campaign_id: String(campaign.id), recipient_id: String(r.id), crm: sendgrid.ENV_TAG },
    }));
    const ids = part.map(r => r.id);
    try {
      const messageId = await sendgrid.send(cfg, msg);
      await db.query(
        `UPDATE crm_campaign_recipients SET status = 'sent', sent_at = NOW(), sendgrid_message_id = $3
          WHERE tenant_id = $1 AND id = ANY($2)`, [tenantId, ids, messageId]);
      const title = ('Kampania e-mail: ' + campaign.name).slice(0, 300);
      const body = 'Wysłano mail z kampanii „' + campaign.name + '”.';
      const partners = part.filter(r => r.partner_id).map(r => r.partner_id);
      const leads = part.filter(r => r.lead_id).map(r => r.lead_id);
      if (partners.length) {
        await db.query(
          `INSERT INTO crm_partner_activities (partner_id, tenant_id, type, title, body, created_by, email_provider, activity_at)
           SELECT unnest($1::uuid[]), $2, 'marketing_email', $3, $4, $5, 'sendgrid', NOW()`,
          [partners, tenantId, title, body, userId]);
      }
      if (leads.length) {
        await db.query(
          `INSERT INTO crm_lead_activities (lead_id, tenant_id, type, title, body, created_by, email_provider, activity_at)
           SELECT unnest($1::int[]), $2, 'marketing_email', $3, $4, $5, 'sendgrid', NOW()`,
          [leads, tenantId, title, body, userId]);
      }
    } catch (err) {
      failed += part.length;
      const message = String(err.message).slice(0, 500);
      logger.error('[email-campaigns] SendGrid batch failed', { tenantId, campaignId: campaign.id, error: message });
      await db.query(`UPDATE crm_campaign_recipients SET status = 'failed', error = $3 WHERE tenant_id = $1 AND id = ANY($2)`,
        [tenantId, ids, message]);
      await db.query(`UPDATE crm_email_campaigns SET send_error = $3 WHERE tenant_id = $1 AND id = $2`,
        [tenantId, campaign.id, message]);
    }
  }
  await db.query(`UPDATE crm_email_campaigns SET status = $3, updated_at = NOW() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, campaign.id, failed === recipients.length ? 'failed' : 'sent']);
}

/** Status / stage label as the CRM shows it (partners: fixed statuses, leads: the tenant's funnel). */
function entityStatusLabel(stageConfig, entityType, status) {
  if (entityType === 'partner') return PARTNER_STATUS_LABELS[status] || status;
  if (entityType === 'lead') return stageLabel(stageConfig.byKey.get(status)) || status;
  return status;
}

module.exports = {
  EMAIL_RE,
  EXCLUSION_LABELS,
  buildPreview,
  buildSegments,
  dwhSalesTable,
  sendCampaign,
  firstNameOf,
  entityStatusLabel,
  arr,
  intOrNull,
  dateOrNull,
};
