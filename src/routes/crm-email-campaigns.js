'use strict';
// routes/crm-email-campaigns.js
// ─────────────────────────────────────────────────────────────────────────────
// E-mail campaigns via SendGrid (port from worktrips-doc). Every tenant sends from ITS
// OWN SendGrid account; templates are made in SendGrid (Dynamic Templates) — the CRM
// only picks one. Access: module flag 'email_campaigns' on the tenant + personal grant
// (user_feature_access); a tenant admin always has access. Everything is tenant-scoped.
//
// GET    /api/crm/email-campaigns/templates           — SendGrid templates (active version: subject, thumbnail)
// GET    /api/crm/email-campaigns/templates/:id       — one SendGrid template with HTML (preview)
// GET    /api/crm/email-campaigns/filter-options      — values for the recipient filters
// POST   /api/crm/email-campaigns/preview             — who gets the mail, who is skipped and why
// POST   /api/crm/email-campaigns/preview/export      — recipients and skipped people to .xlsx
// POST   /api/crm/email-campaigns/import-csv          — check a CSV list of addresses (report of rejected rows)
// GET    /api/crm/email-campaigns/sendgrid/status     — is sending configured (no secrets)
// GET    /api/crm/email-campaigns/sendgrid/settings   — tenant SendGrid settings (tenant admin; never the key)
// PUT    /api/crm/email-campaigns/sendgrid/settings   — save tenant SendGrid settings (tenant admin)
// POST   /api/crm/email-campaigns/sendgrid/test       — check the saved key against SendGrid (tenant admin)
// GET    /api/crm/email-campaigns                     — campaign list
// POST   /api/crm/email-campaigns/bulk                — archive / restore many
// GET    /api/crm/email-campaigns/requesters          — people who can order a campaign
// GET    /api/crm/email-campaigns/results(/export)    — results of sent campaigns
// GET    /api/crm/email-campaigns/:id                 — campaign
// POST   /api/crm/email-campaigns                     — new campaign (draft)
// PUT    /api/crm/email-campaigns/:id                 — save draft
// DELETE /api/crm/email-campaigns/:id                 — delete draft
// POST   /api/crm/email-campaigns/:id/archive|restore|duplicate
// POST   /api/crm/email-campaigns/:id/test-send       — test to own mailbox (remembers the template version)
// POST   /api/crm/email-campaigns/:id/send            — send through SendGrid (in the background)
// Webhook: routes/sendgrid-webhook.js (POST /api/webhooks/sendgrid/:token)
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const db     = require('../config/database');
const logger = require('../utils/logger');
const { requireAuth }        = require('../middleware/auth');
const { injectAuditContext } = require('../middleware/errorHandler');
const { requireFeature }     = require('../middleware/crm-rbac');
const audit    = require('../services/auditService');
const sendgrid = require('../services/sendgridService');
const campaigns = require('../services/emailCampaignService');
const { getStageConfig, stageLabel } = require('../services/leadStageService');
const { loadConsentTypes } = require('../services/consentService');
const { buildXlsx, XLSX_MIME } = require('../utils/xlsx');

const { EMAIL_RE, EXCLUSION_LABELS, arr, intOrNull, dateOrNull } = campaigns;

function requireTenant(req, res, next) {
  if (!req.tenantId) return res.status(403).json({ error: 'Brak dostępu' });
  next();
}

// Settings of the tenant's SendGrid account: tenant admin (or super admin) only
function requireTenantAdmin(req, res, next) {
  if (req.user?.is_admin || req.user?.is_super_admin) return next();
  return res.status(403).json({ error: 'Ustawienia SendGrid może zmieniać tylko administrator firmy' });
}

router.use(requireAuth, requireTenant, injectAuditContext, requireFeature('email_campaigns'));

// Campaign size limit (protects the SendGrid account reputation); a larger send only by an admin
const MAX_RECIPIENTS = Math.max(1, parseInt(process.env.CAMPAIGN_MAX_RECIPIENTS, 10) || 300);
const NOT_CONFIGURED = 'Szablony są w SendGrid — uzupełnij ustawienia SendGrid (klucz API) w kampaniach.';

const str = (v, max) => String(v ?? '').slice(0, max);
const SG_TEMPLATE_ID = /^d-[a-f0-9]{32}$/i;
const UUID_RE = /^[0-9a-f-]{36}$/i;
const idParam = req => parseInt(req.params.id, 10) || 0;
const previewCtx = req => ({ tenantId: req.tenantId, dwhPrefix: req.dwhPrefix });

// Template list per tenant: rarely changes — 60 s in memory; ?refresh=1 = straight from SendGrid
const templateCache = new Map();

async function campaignConsent(req, cfg) {
  return sendgrid.resolveTenantConsent(req.tenantId, cfg ?? await sendgrid.loadConfig(req.tenantId));
}

// ═════════════════════════════════════════════════════════════════════════════
// Templates — from SendGrid (Dynamic Templates). Edited only in SendGrid.
// In the template: {{imie}} (empty when the CRM does not know the first name — use
// {{#if imie}}…{{else}}…{{/if}}) and {{firma}}.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/templates', async (req, res, next) => {
  try {
    const cfg = await sendgrid.loadConfig(req.tenantId);
    const sg = sendgrid.status(cfg);
    if (!cfg?.apiKey) return res.status(409).json({ error: NOT_CONFIGURED, missing: sg.missing });
    const cached = templateCache.get(req.tenantId);
    if (!cached || req.query.refresh === '1' || Date.now() - cached.at > 60000) {
      templateCache.set(req.tenantId, { at: Date.now(), list: await sendgrid.listTemplates(cfg) });
    }
    res.json(templateCache.get(req.tenantId).list);
  } catch (err) {
    if (err.status) return res.status(502).json({ error: err.message });
    next(err);
  }
});

router.get('/templates/:id', async (req, res, next) => {
  try {
    if (!SG_TEMPLATE_ID.test(req.params.id)) return res.status(400).json({ error: 'Niepoprawny identyfikator szablonu' });
    const cfg = await sendgrid.loadConfig(req.tenantId);
    if (!cfg?.apiKey) return res.status(409).json({ error: NOT_CONFIGURED });
    res.json(await sendgrid.getTemplate(cfg, req.params.id));
  } catch (err) {
    if (err.status) return res.status(err.status === 404 ? 404 : 502).json({ error: err.status === 404 ? 'Szablonu nie ma już w SendGrid' : err.message });
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Recipients
// ═════════════════════════════════════════════════════════════════════════════
router.get('/filter-options', async (req, res, next) => {
  try {
    const t = req.tenantId;
    const [ind, pst, lst, own, tg, types, stageConfig, salesTable, cfg] = await Promise.all([
      db.query(`SELECT DISTINCT i FROM (
                  SELECT industry AS i FROM crm_partners WHERE tenant_id = $1
                  UNION SELECT industry FROM crm_leads WHERE tenant_id = $1 AND archived_at IS NULL) x
                WHERE i IS NOT NULL AND i <> '' ORDER BY i`, [t]),
      db.query(`SELECT status, count(*)::int AS n FROM crm_partners
                WHERE tenant_id = $1 AND status IS NOT NULL GROUP BY status ORDER BY n DESC`, [t]),
      db.query(`SELECT stage, count(*)::int AS n FROM crm_leads
                WHERE tenant_id = $1 AND archived_at IS NULL GROUP BY stage ORDER BY n DESC`, [t]),
      db.query(`SELECT u.id, u.display_name FROM users u
                WHERE u.tenant_id = $1 AND u.is_active
                  AND (u.id IN (SELECT manager_id FROM crm_partners WHERE tenant_id = $1)
                       OR u.id IN (SELECT assigned_to FROM crm_leads WHERE tenant_id = $1))
                ORDER BY u.display_name`, [t]),
      db.query(`SELECT DISTINCT tag FROM (
                  SELECT unnest(tags) AS tag FROM crm_partners WHERE tenant_id = $1
                  UNION SELECT unnest(tags) FROM crm_leads WHERE tenant_id = $1 AND archived_at IS NULL) x
                WHERE tag IS NOT NULL AND tag <> '' ORDER BY tag`, [t]),
      loadConsentTypes(t),
      getStageConfig(t),
      campaigns.dwhSalesTable(req.dwhPrefix),
      sendgrid.loadConfig(t),
    ]);
    const consent = sendgrid.resolveConsent(types, cfg?.consentKey);
    res.json({
      segments: campaigns.buildSegments(stageConfig, !!salesTable),
      industries: ind.rows.map(r => r.i),
      partner_statuses: pst.rows,
      lead_stages: lst.rows
        .filter(r => r.stage !== stageConfig.archivedKey)
        .map(r => ({ ...r, label: stageLabel(stageConfig.byKey.get(r.stage)) || r.stage })),
      owners: own.rows,
      tags: tg.rows.map(r => r.tag),
      company_sizes: [],
      turnover_available: !!salesTable,
      consent_types: types.filter(c => c && c.key).map(c => ({ key: c.key, label: c.label })),
      consent_key: consent.consent_key,
      consent_label: consent.consent_label,
    });
  } catch (err) { next(err); }
});

router.post('/preview', async (req, res, next) => {
  try {
    const consent = await campaignConsent(req);
    const rules = { ...(req.body?.rules || {}), consentKey: consent.consent_key };
    res.json(await campaigns.buildPreview(previewCtx(req), req.body?.criteria || {}, rules));
  } catch (err) { next(err); }
});

const ENTITY_LABEL = { partner: 'Partner', lead: 'Lead' };
const CONSENT_LABEL = { granted: 'Zgoda', denied: 'Odmowa', no_data: 'Brak danych' };
const today = () => new Date().toISOString().slice(0, 10);
function sendXlsx(res, filename, sheets) {
  res.set('Content-Type', XLSX_MIME).set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buildXlsx(sheets));
}

// Recipient list to Excel: sheets "Dostaną" and "Pominięci" (with the reason)
router.post('/preview/export', async (req, res, next) => {
  try {
    const [consent, stageConfig] = await Promise.all([campaignConsent(req), getStageConfig(req.tenantId)]);
    const rules = { ...(req.body?.rules || {}), consentKey: consent.consent_key };
    const p = await campaigns.buildPreview(previewCtx(req), req.body?.criteria || {}, rules, { full: true });
    const cols = [
      { header: 'Typ', width: 11 }, { header: 'Firma', width: 36 }, { header: 'Osoba kontaktowa', width: 24 }, { header: 'E-mail', width: 32 },
      { header: 'Status / etap', width: 20 }, { header: 'Branża', width: 20 }, { header: 'Opiekun', width: 20 },
      { header: 'Obrót od początku roku (PLN)', width: 18, type: 'int' }, { header: 'Ostatni kontakt', width: 17, type: 'date' },
      { header: consent.consent_label || 'Zgoda marketingowa', width: 16 },
    ];
    const row = r => [ENTITY_LABEL[r.entity_type] || 'Spoza CRM', r.company, r.contact_name, r.email,
      campaigns.entityStatusLabel(stageConfig, r.entity_type, r.status),
      r.industry, r.owner_name, r.turnover !== null && r.turnover !== undefined ? Math.round(r.turnover) : null, r.last_activity_at,
      CONSENT_LABEL[r.consent] || r.consent];
    sendXlsx(res, `odbiorcy-${today()}.xlsx`, [
      { name: `Dostaną (${p.to_send})`, columns: cols, rows: p.recipients.filter(r => !r.reason).map(row) },
      { name: `Pominięci (${p.excluded_total})`, columns: [{ header: 'Powód pominięcia', width: 34 }, ...cols],
        rows: p.recipients.filter(r => r.reason).map(r => [r.reason_label, ...row(r)]) },
    ]);
  } catch (err) { next(err); }
});

// A list of addresses from a file: only a check and a report — the list is saved with the draft.
// Rejected: rows without an address, invalid addresses, duplicates in the file. Consents and
// unsubscribes are checked later by the preview.
router.post('/import-csv', async (req, res, next) => {
  try {
    const text = str(req.body?.text, 5 * 1024 * 1024).replace(/^\uFEFF/, '');
    if (!text.trim()) return res.status(400).json({ error: 'Plik jest pusty' });
    const lines = text.split(/\r?\n/);
    const delim = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
    const split = l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
    const header = split(lines[0]).map(h => h.toLowerCase());
    let col = header.findIndex(h => /e-?mail|adres/.test(h));
    const hasHeader = col >= 0 || !header.some(h => h.includes('@'));
    if (col < 0) col = Math.max(0, split(lines.find(l => l.includes('@')) || '').findIndex(c => c.includes('@')));
    const seen = new Set(); const accepted = []; const rejected = [];
    lines.forEach((line, i) => {
      if (hasHeader && i === 0) return;
      if (!line.trim()) return;
      const raw = (split(line)[col] || '').trim();
      const email = raw.toLowerCase();
      const rowNo = i + 1;
      if (!email) rejected.push({ row: rowNo, value: line.slice(0, 120), reason: 'Brak adresu e-mail' });
      else if (!EMAIL_RE.test(email)) rejected.push({ row: rowNo, value: raw, reason: 'Niepoprawny adres e-mail' });
      else if (seen.has(email)) rejected.push({ row: rowNo, value: raw, reason: 'Duplikat w pliku' });
      else { seen.add(email); accepted.push(email); }
    });
    if (accepted.length > 20000) return res.status(400).json({ error: 'Plik ma ponad 20 000 adresów' });
    // How many of the valid addresses are in this tenant's CRM
    const { rows } = accepted.length ? await db.query(`
      SELECT count(DISTINCT e)::int AS n FROM (
        SELECT lower(trim(email)) AS e FROM crm_partners WHERE tenant_id = $1 AND lower(trim(email)) = ANY($2)
        UNION SELECT lower(trim(email)) FROM crm_partner_contacts WHERE tenant_id = $1 AND lower(trim(email)) = ANY($2)
        UNION SELECT lower(trim(email)) FROM crm_leads WHERE tenant_id = $1 AND archived_at IS NULL AND lower(trim(email)) = ANY($2)
        UNION SELECT lower(trim(lc.email)) FROM crm_lead_contacts lc JOIN crm_leads l ON l.id = lc.lead_id AND l.archived_at IS NULL
              WHERE lc.tenant_id = $1 AND lower(trim(lc.email)) = ANY($2)) x`, [req.tenantId, accepted]) : { rows: [{ n: 0 }] };
    res.json({
      rows_total: lines.filter((l, i) => l.trim() && !(hasHeader && i === 0)).length,
      email_column: hasHeader ? (split(lines[0])[col] || 'kolumna ' + (col + 1)) : 'kolumna ' + (col + 1),
      accepted: accepted.length, in_crm: rows[0].n, emails: accepted,
      rejected: rejected.slice(0, 500), rejected_total: rejected.length,
    });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// SendGrid account of the tenant
// ═════════════════════════════════════════════════════════════════════════════
router.get('/sendgrid/status', async (req, res, next) => {
  try {
    const cfg = await sendgrid.loadConfig(req.tenantId);
    const consent = await sendgrid.resolveTenantConsent(req.tenantId, cfg);
    res.json({ ...sendgrid.status(cfg), max_recipients: MAX_RECIPIENTS, can_send_large: !!req.user.is_admin, ...consent });
  } catch (err) { next(err); }
});

router.get('/sendgrid/settings', requireTenantAdmin, async (req, res, next) => {
  try {
    res.json(await sendgrid.settingsView(req.tenantId));
  } catch (err) { next(err); }
});

router.put('/sendgrid/settings', requireTenantAdmin, async (req, res, next) => {
  try {
    const types = await loadConsentTypes(req.tenantId);
    const patch = sendgrid.validateSettings(req.body, types);
    if (patch.error) return res.status(400).json({ error: patch.error });
    const before = await sendgrid.settingsView(req.tenantId);
    await sendgrid.saveSettings(req.tenantId, patch, req.user.id);
    templateCache.delete(req.tenantId);
    const after = await sendgrid.settingsView(req.tenantId);
    const snapshot = v => ({
      has_api_key: v.has_api_key, from_email: v.from_email, from_name: v.from_name, reply_to: v.reply_to,
      asm_group_id: v.asm_group_id, has_webhook_public_key: v.has_webhook_public_key, consent_key: v.consent_key,
    });
    await audit.log({
      user:        req.user,
      action:      'settings_updated',
      beforeState: snapshot(before),
      afterState:  snapshot(after),
      metadata:    {
        kind: 'tenant_sendgrid_config',
        api_key: patch.apiKey === undefined ? 'kept' : patch.apiKey === null ? 'removed' : 'replaced',
      },
      ipAddress:   req.auditContext?.ipAddress,
    });
    res.json(after);
  } catch (err) { next(err); }
});

router.post('/sendgrid/test', requireTenantAdmin, async (req, res, next) => {
  try {
    const cfg = await sendgrid.loadConfig(req.tenantId);
    if (!cfg?.apiKey) return res.status(400).json({ error: 'Najpierw zapisz klucz API SendGrid' });
    let templates;
    try {
      templates = await sendgrid.listTemplates(cfg);
    } catch (err) {
      return res.status(400).json({ error: err.status ? err.message : 'Nie udało się połączyć z SendGrid' });
    }
    templateCache.set(req.tenantId, { at: Date.now(), list: templates });
    res.json({ ok: true, templates: templates.length });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Campaigns
// ═════════════════════════════════════════════════════════════════════════════
// List: search, status, requester, period (send date; for a draft — creation), "show archived",
// sorting, pages of 20. status_counts ignore the status filter (counters on the status tabs).
// ids_only=1 → only the ids of every match (select all across pages).
const LIST_SORT = {
  updated: 'c.updated_at', date: 'COALESCE(c.sent_at, c.created_at)', name: 'lower(c.name)',
  recipients: `CASE WHEN c.status = 'draft' THEN c.estimated_recipients ELSE sc.sent END`,
};
router.get('/', async (req, res, next) => {
  try {
    const status = ['draft', 'sending', 'sent', 'failed'].includes(req.query.status) ? req.query.status : null;
    const requestedBy = UUID_RE.test(String(req.query.requested_by || '')) ? req.query.requested_by : null;
    const withArchived = req.query.archived === '1';
    const q = String(req.query.q || '').trim().slice(0, 100) || null;
    const from = dateOrNull(req.query.from), to = dateOrNull(req.query.to);
    const sortCol = LIST_SORT[req.query.sort] || LIST_SORT.updated;
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const pageSize = Math.min(100, Math.max(5, parseInt(req.query.page_size, 10) || 20));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    // $1 status kept apart: status counters use the same filters, just without it
    const base = `c.tenant_id = $7
        AND ($2::uuid IS NULL OR COALESCE(c.requested_by, c.created_by) = $2)
        AND ($3::boolean OR c.archived_at IS NULL)
        AND ($4::text IS NULL OR c.name ILIKE '%' || $4 || '%' OR c.sendgrid_template_name ILIKE '%' || $4 || '%')
        AND ($5::date IS NULL OR COALESCE(c.sent_at, c.created_at) >= $5::date)
        AND ($6::date IS NULL OR COALESCE(c.sent_at, c.created_at) < $6::date + 1)`;
    const where = `WHERE ($1::text IS NULL OR c.status = $1) AND ${base}`;
    const params = [status, requestedBy, withArchived, q, from, to, req.tenantId];
    const fromSql = `FROM crm_email_campaigns c`;
    if (req.query.ids_only === '1') {
      const { rows } = await db.query(`SELECT c.id, c.status, c.archived_at IS NOT NULL AS archived ${fromSql} ${where} LIMIT 5000`, params);
      return res.json({ items: rows });
    }
    const [list, count, counts, reqs, archived] = await Promise.all([
      db.query(`
        SELECT c.id, c.name, c.status, c.sendgrid_template_id, c.sendgrid_template_name AS template_name,
               c.estimated_recipients, c.estimated_excluded,
               c.created_at, c.updated_at, c.sent_at, c.archived_at, u.display_name AS created_by_name,
               COALESCE(c.requested_by, c.created_by) AS requested_by, ru.display_name AS requested_by_name,
               sc.sent AS sent_count, sc.opened AS opened_count, sc.clicked AS clicked_count
        FROM crm_email_campaigns c
        LEFT JOIN users u ON u.id = c.created_by
        LEFT JOIN users ru ON ru.id = COALESCE(c.requested_by, c.created_by)
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE r.status NOT IN ('excluded', 'queued', 'failed'))::int AS sent,
                 count(r.opened_at)::int AS opened, count(r.clicked_at)::int AS clicked
          FROM crm_campaign_recipients r WHERE r.campaign_id = c.id AND r.tenant_id = c.tenant_id) sc ON true
        ${where}
        ORDER BY c.archived_at IS NOT NULL, ${sortCol} ${dir} NULLS LAST, c.id DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
      db.query(`SELECT count(*)::int AS n ${fromSql} ${where}`, params),
      // $1 must appear in the query (pg types every parameter), but the status is not filtered here
      db.query(`SELECT c.status, count(*)::int AS n ${fromSql} WHERE ($1::text IS NULL OR true) AND ${base} GROUP BY c.status`, params),
      db.query(`SELECT DISTINCT u.id, u.display_name FROM crm_email_campaigns c
                JOIN users u ON u.id = COALESCE(c.requested_by, c.created_by)
                WHERE c.tenant_id = $1 ORDER BY u.display_name`, [req.tenantId]),
      // How many campaigns are archived — an empty list then says "they are in the archive"
      withArchived ? Promise.resolve({ rows: [{ n: 0 }] })
        : db.query(`SELECT count(*)::int AS n FROM crm_email_campaigns WHERE tenant_id = $1 AND archived_at IS NOT NULL`, [req.tenantId]),
    ]);
    const status_counts = Object.fromEntries(counts.rows.map(r => [r.status, r.n]));
    res.json({ items: list.rows, total: count.rows[0].n, page, page_size: pageSize, requesters: reqs.rows, status_counts, archived_total: archived.rows[0].n });
  } catch (err) { next(err); }
});

// Selected campaigns at once: archive / restore (campaigns being sent are skipped)
router.post('/bulk', async (req, res, next) => {
  try {
    const action = req.body?.action;
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(n => parseInt(n, 10)).filter(n => n > 0).slice(0, 5000);
    if (!['archive', 'restore'].includes(action) || !ids.length) return res.status(400).json({ error: 'Wybierz kampanie i akcję' });
    const sql = action === 'archive'
      ? `UPDATE crm_email_campaigns SET archived_at = NOW(), updated_by = $2
          WHERE tenant_id = $3 AND id = ANY($1) AND archived_at IS NULL AND status <> 'sending'`
      : `UPDATE crm_email_campaigns SET archived_at = NULL, updated_by = $2
          WHERE tenant_id = $3 AND id = ANY($1) AND archived_at IS NOT NULL`;
    const { rowCount } = await db.query(sql, [ids, req.user.id, req.tenantId]);
    res.json({ ok: true, done: rowCount, skipped: ids.length - rowCount });
  } catch (err) { next(err); }
});

// People who can be the requester (active users of the tenant)
router.get('/requesters', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, display_name FROM users WHERE tenant_id = $1 AND is_active ORDER BY display_name`, [req.tenantId]);
    res.json(rows);
  } catch (err) { next(err); }
});

async function campaignBody(req) {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return { error: 'Podaj nazwę kampanii' };
  const sgId = String(b.sendgrid_template_id || '').trim() || null;
  if (sgId && !SG_TEMPLATE_ID.test(sgId)) return { error: 'Niepoprawny identyfikator szablonu SendGrid' };
  let requestedBy = UUID_RE.test(String(b.requested_by || '')) ? b.requested_by : null;
  if (requestedBy) {
    const { rows } = await db.query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2`, [requestedBy, req.tenantId]);
    if (!rows.length) requestedBy = null;
  }
  const minDays = b.min_days_between_sends === 0 ? 0 : (intOrNull(b.min_days_between_sends) ?? 30);
  const recentDays = intOrNull(b.exclude_recent_contact_days);
  const criteria = b.filter_criteria && typeof b.filter_criteria === 'object' ? b.filter_criteria : {};
  const consent = await campaignConsent(req);
  const preview = await campaigns.buildPreview(previewCtx(req), criteria,
    { consentKey: consent.consent_key, min_days_between_sends: minDays, exclude_recent_contact_days: recentDays });
  return {
    name: name.slice(0, 200), sgId, sgName: sgId ? str(b.sendgrid_template_name, 200) || null : null,
    sgSubject: sgId ? str(b.sendgrid_template_subject, 300) || null : null, minDays, recentDays, requestedBy,
    criteria: JSON.stringify(criteria),
    utm: String(b.utm_campaign || '').trim().slice(0, 100) || null,
    toSend: preview.to_send, excluded: preview.excluded_total,
  };
}

router.post('/', async (req, res, next) => {
  try {
    const c = await campaignBody(req);
    if (c.error) return res.status(400).json({ error: c.error });
    const { rows } = await db.query(`
      INSERT INTO crm_email_campaigns (tenant_id, name, sendgrid_template_id, sendgrid_template_name, sendgrid_template_subject, filter_criteria,
                                       min_days_between_sends, exclude_recent_contact_days, utm_campaign, estimated_recipients, estimated_excluded,
                                       created_by, updated_by, requested_by)
      VALUES ($13, $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $11, COALESCE($12::uuid, $11)) RETURNING *`,
      [c.name, c.sgId, c.sgName, c.sgSubject, c.criteria, c.minDays, c.recentDays, c.utm, c.toSend, c.excluded, req.user.id, c.requestedBy, req.tenantId]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const c = await campaignBody(req);
    if (c.error) return res.status(400).json({ error: c.error });
    const { rows } = await db.query(`
      UPDATE crm_email_campaigns
      SET name = $1, sendgrid_template_id = $2, sendgrid_template_name = $3, sendgrid_template_subject = $4, filter_criteria = $5::jsonb,
          min_days_between_sends = $6, exclude_recent_contact_days = $7, utm_campaign = $8, estimated_recipients = $9, estimated_excluded = $10,
          -- "Me" (empty) = the person saving; a chosen person = that person
          updated_by = $11, updated_at = NOW(), requested_by = COALESCE($13::uuid, $11),
          -- another template = the previous test no longer counts
          tested_version = CASE WHEN sendgrid_template_id IS DISTINCT FROM $2 THEN NULL ELSE tested_version END
      WHERE id = $12 AND tenant_id = $14 AND status = 'draft' RETURNING *`,
      [c.name, c.sgId, c.sgName, c.sgSubject, c.criteria, c.minDays, c.recentDays, c.utm, c.toSend, c.excluded, req.user.id, idParam(req), c.requestedBy, req.tenantId]);
    if (!rows.length) return res.status(404).json({ error: 'Nie znaleziono szkicu kampanii' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(`DELETE FROM crm_email_campaigns WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [idParam(req), req.tenantId]);
    if (!rowCount) return res.status(404).json({ error: 'Można usunąć tylko szkic kampanii. Wysłaną kampanię zarchiwizuj.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Results of sent campaigns (from the SendGrid webhook), send date filter ──
const RESULT_COUNTS = `
  count(r.*) FILTER (WHERE r.status NOT IN ('excluded', 'queued', 'failed'))::int AS sent,
  count(r.delivered_at)::int AS delivered,
  count(r.opened_at)::int AS opened,
  count(r.clicked_at)::int AS clicked,
  count(*) FILTER (WHERE r.status = 'unsubscribed')::int AS unsub,
  count(*) FILTER (WHERE r.status = 'bounced')::int AS bounced,
  count(*) FILTER (WHERE r.status = 'spam_report')::int AS spam`;

const CLICKERS_SQL = `
  SELECT r.entity_type, COALESCE(r.partner_id::text, r.lead_id::text) AS entity_id, r.company, r.contact_name, r.email, r.clicked_at,
         (SELECT e.url FROM crm_campaign_events e WHERE e.recipient_id = r.id AND e.event = 'click' ORDER BY e.occurred_at DESC LIMIT 1) AS url,
         COALESCE(up.display_name, ul.display_name) AS owner_name, c.name AS campaign
  FROM crm_campaign_recipients r
  JOIN crm_email_campaigns c ON c.id = r.campaign_id AND c.tenant_id = r.tenant_id
  LEFT JOIN crm_partners p ON p.id = r.partner_id AND p.tenant_id = r.tenant_id LEFT JOIN users up ON up.id = p.manager_id
  LEFT JOIN crm_leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id LEFT JOIN users ul ON ul.id = l.assigned_to
  WHERE r.tenant_id = $1 AND r.campaign_id = ANY($2) AND r.clicked_at IS NOT NULL
  ORDER BY r.clicked_at DESC`;

router.get('/results', async (req, res, next) => {
  try {
    const from = dateOrNull(req.query.from), to = dateOrNull(req.query.to);
    const { rows: list } = await db.query(`
      SELECT c.id, c.name, c.sent_at, c.status, c.sendgrid_template_name AS template, ${RESULT_COUNTS}
      FROM crm_email_campaigns c
      LEFT JOIN crm_campaign_recipients r ON r.campaign_id = c.id AND r.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.status IN ('sending', 'sent') AND c.sent_at IS NOT NULL
        AND ($2::date IS NULL OR c.sent_at >= $2::date)
        AND ($3::date IS NULL OR c.sent_at < $3::date + 1)
      GROUP BY c.id
      ORDER BY c.sent_at DESC`, [req.tenantId, from, to]);
    // No campaign_id = every campaign of the period together (default view); campaign_id = one campaign
    const sel = parseInt(req.query.campaign_id, 10) || 0;
    const ids = sel ? [sel] : list.map(c => c.id);
    const [links, clickers] = ids.length ? await Promise.all([
      db.query(`SELECT url, count(*)::int AS clicks FROM crm_campaign_events
                WHERE tenant_id = $1 AND campaign_id = ANY($2) AND event = 'click' AND url IS NOT NULL
                GROUP BY url ORDER BY clicks DESC LIMIT 10`, [req.tenantId, ids]),
      db.query(`${CLICKERS_SQL} LIMIT 200`, [req.tenantId, ids]),
    ]) : [{ rows: [] }, { rows: [] }];
    res.json({ campaigns: list, selected_id: sel || null, links: links.rows, clickers: clickers.rows });
  } catch (err) { next(err); }
});

// Results report to Excel: yearly and monthly summary, campaigns, companies that clicked.
// campaign_id = one campaign (button at the bottom of a campaign); none = every campaign of the period.
router.get('/results/export', async (req, res, next) => {
  try {
    const from = dateOrNull(req.query.from), to = dateOrNull(req.query.to);
    const one = parseInt(req.query.campaign_id, 10) || null;
    const { rows: camps } = await db.query(`
      SELECT c.id, c.name, c.sent_at, c.status, c.sendgrid_template_name AS template,
             COALESCE(ru.display_name, u.display_name) AS requester, ${RESULT_COUNTS},
             count(*) FILTER (WHERE r.status = 'excluded')::int AS excluded
      FROM crm_email_campaigns c
      LEFT JOIN users u ON u.id = c.created_by
      LEFT JOIN users ru ON ru.id = c.requested_by
      LEFT JOIN crm_campaign_recipients r ON r.campaign_id = c.id AND r.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.status IN ('sending', 'sent', 'failed') AND c.sent_at IS NOT NULL
        AND ($2::int IS NULL OR c.id = $2)
        AND ($3::date IS NULL OR c.sent_at >= $3::date)
        AND ($4::date IS NULL OR c.sent_at < $4::date + 1)
      GROUP BY c.id, ru.display_name, u.display_name
      ORDER BY c.sent_at DESC`, [req.tenantId, one, from, to]);
    if (one && !camps.length) return res.status(404).json({ error: 'Ta kampania nie została jeszcze wysłana — nie ma wyników' });
    const ids = camps.map(c => c.id);
    const { rows: clickers } = ids.length ? await db.query(CLICKERS_SQL, [req.tenantId, ids]) : { rows: [] };

    const pct = (n, of) => (of ? n / of : null);
    const totals = list => {
      const t = { n: list.length, sent: 0, delivered: 0, opened: 0, clicked: 0, unsub: 0, bounced: 0, spam: 0 };
      list.forEach(c => { for (const k of Object.keys(t)) if (k !== 'n') t[k] += c[k]; });
      return t;
    };
    const sumRow = (label, t) => [label, t.n, t.sent, t.delivered, pct(t.delivered, t.sent), t.opened, pct(t.opened, t.delivered),
      t.clicked, pct(t.clicked, t.delivered), t.unsub, t.bounced + t.spam];
    const sumCols = first => [
      { header: first, width: 18 }, { header: 'Kampanie', width: 10, type: 'int' }, { header: 'Wysłane', width: 10, type: 'int' },
      { header: 'Dostarczone', width: 12, type: 'int' }, { header: '% dostarczonych', width: 15, type: 'pct' },
      { header: 'Otwarcia', width: 10, type: 'int' }, { header: '% otwarć', width: 10, type: 'pct' },
      { header: 'Kliknięcia', width: 11, type: 'int' }, { header: '% kliknięć', width: 11, type: 'pct' },
      { header: 'Wypisy', width: 9, type: 'int' }, { header: 'Odbite i spam', width: 13, type: 'int' },
    ];
    const plMonth = d => new Date(d).toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw', month: 'long', year: 'numeric' });
    const plYear = d => new Date(d).toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw', year: 'numeric' });
    const groupBy = fn => { const m = new Map(); camps.forEach(c => { const k = fn(c.sent_at); m.set(k, [...(m.get(k) || []), c]); }); return m; };
    const years = [...groupBy(plYear)].map(([y, l]) => sumRow(y, totals(l)));
    const months = [...groupBy(plMonth)].map(([m, l]) => sumRow(m, totals(l)));
    const all = totals(camps);

    const sheets = [];
    if (!one) {
      sheets.push({ name: 'Podsumowanie roczne', columns: sumCols('Rok'), rows: [...years, sumRow('Razem', all)], boldRows: new Set([years.length]) });
      sheets.push({ name: 'Miesiące', columns: sumCols('Miesiąc'), rows: months });
    }
    sheets.push({
      name: 'Kampanie',
      columns: [
        { header: 'Kampania', width: 34 }, { header: 'Wysłana', width: 17, type: 'date' }, { header: 'Szablon', width: 26 },
        { header: 'Zleceniodawca', width: 20 }, { header: 'Wysłane', width: 10, type: 'int' }, { header: 'Dostarczone', width: 12, type: 'int' },
        { header: '% dostarczonych', width: 15, type: 'pct' }, { header: 'Otwarcia', width: 10, type: 'int' }, { header: '% otwarć', width: 10, type: 'pct' },
        { header: 'Kliknięcia', width: 11, type: 'int' }, { header: '% kliknięć', width: 11, type: 'pct' }, { header: 'Wypisy', width: 9, type: 'int' },
        { header: 'Odbite', width: 9, type: 'int' }, { header: 'Spam', width: 8, type: 'int' }, { header: 'Pominięci przy wysyłce', width: 20, type: 'int' },
      ],
      rows: camps.map(c => [c.name, c.sent_at, c.template, c.requester, c.sent, c.delivered, pct(c.delivered, c.sent), c.opened,
        pct(c.opened, c.delivered), c.clicked, pct(c.clicked, c.delivered), c.unsub, c.bounced, c.spam, c.excluded]),
    });
    sheets.push({
      name: 'Firmy, które kliknęły',
      columns: [
        { header: 'Firma', width: 34 }, { header: 'Typ', width: 11 }, { header: 'Osoba', width: 22 }, { header: 'E-mail', width: 30 },
        { header: 'Kampania', width: 30 }, { header: 'Kliknięty link', width: 40 }, { header: 'Kiedy', width: 17, type: 'date' }, { header: 'Opiekun', width: 20 },
      ],
      rows: clickers.map(k => [k.company, ENTITY_LABEL[k.entity_type] || '', k.contact_name, k.email, k.campaign,
        String(k.url || '').replace(/[?#].*$/, ''), k.clicked_at, k.owner_name]),
    });
    // One campaign: the full recipient list with what happened to the mail
    if (one) {
      const STATUS_PL = { queued: 'W kolejce', sent: 'Wysłany', delivered: 'Dostarczony', opened: 'Otwarty', clicked: 'Kliknięty',
        bounced: 'Odbity', dropped: 'Nie wysłany przez SendGrid', unsubscribed: 'Wypisał(a) się', spam_report: 'Zgłosił(a) spam',
        failed: 'Błąd wysyłki', excluded: 'Pominięty' };
      const { rows: recs } = await db.query(`
        SELECT r.company, r.contact_name, r.email, r.entity_type, r.status, r.exclusion_reason, r.sent_at, r.delivered_at, r.opened_at, r.clicked_at
        FROM crm_campaign_recipients r WHERE r.tenant_id = $1 AND r.campaign_id = $2
        ORDER BY r.status = 'excluded', r.company`, [req.tenantId, one]);
      sheets.push({
        name: 'Odbiorcy',
        columns: [
          { header: 'Firma', width: 34 }, { header: 'Typ', width: 11 }, { header: 'Osoba', width: 22 }, { header: 'E-mail', width: 30 },
          { header: 'Status', width: 22 }, { header: 'Powód pominięcia', width: 30 }, { header: 'Wysłany', width: 17, type: 'date' },
          { header: 'Dostarczony', width: 17, type: 'date' }, { header: 'Otwarty', width: 17, type: 'date' }, { header: 'Kliknięty', width: 17, type: 'date' },
        ],
        rows: recs.map(r => [r.company, ENTITY_LABEL[r.entity_type] || '', r.contact_name, r.email, STATUS_PL[r.status] || r.status,
          r.exclusion_reason ? EXCLUSION_LABELS[r.exclusion_reason] || r.exclusion_reason : '', r.sent_at, r.delivered_at, r.opened_at, r.clicked_at]),
      });
    }
    const slug = v => String(v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    sendXlsx(res, one ? `wyniki-${slug(camps[0].name) || 'kampania'}.xlsx` : `wyniki-kampanii-${from || 'od-poczatku'}-${to || today()}.xlsx`, sheets);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM crm_email_campaigns WHERE id = $1 AND tenant_id = $2`, [idParam(req), req.tenantId]);
    if (!rows.length) return res.status(404).json({ error: 'Nie znaleziono kampanii' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post('/:id/archive', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE crm_email_campaigns SET archived_at = NOW(), updated_by = $2
        WHERE id = $1 AND tenant_id = $3 AND archived_at IS NULL AND status <> 'sending'`,
      [idParam(req), req.user.id, req.tenantId]);
    if (!rowCount) return res.status(404).json({ error: 'Nie można zarchiwizować tej kampanii (trwa wysyłka albo już jest w archiwum)' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/restore', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE crm_email_campaigns SET archived_at = NULL, updated_by = $2
        WHERE id = $1 AND tenant_id = $3 AND archived_at IS NOT NULL`,
      [idParam(req), req.user.id, req.tenantId]);
    if (!rowCount) return res.status(404).json({ error: 'Kampania nie jest w archiwum' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Copy = a new draft with the same settings (no send history)
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      INSERT INTO crm_email_campaigns (tenant_id, name, sendgrid_template_id, sendgrid_template_name, sendgrid_template_subject,
                                       filter_criteria, min_days_between_sends, exclude_recent_contact_days,
                                       utm_campaign, estimated_recipients, estimated_excluded, created_by, updated_by, requested_by)
      SELECT tenant_id, left(name || ' (kopia)', 200), sendgrid_template_id, sendgrid_template_name, sendgrid_template_subject,
             filter_criteria, min_days_between_sends, exclude_recent_contact_days,
             NULL, estimated_recipients, estimated_excluded, $2, $2, COALESCE(requested_by, created_by)
      FROM crm_email_campaigns WHERE id = $1 AND tenant_id = $3 RETURNING *`, [idParam(req), req.user.id, req.tenantId]);
    if (!rows.length) return res.status(404).json({ error: 'Nie znaleziono kampanii' });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── Test and send through SendGrid (dynamic template) ─────────────────────────
// The test goes to the user's own mailbox and remembers the template version. "Send" needs a
// test of the same version — if the designer changed the template in SendGrid, test again.
const versionKey = t => `${t.version_id || ''}|${t.updated_at || ''}`;
const firstNameOfUser = u => String(u.first_name || u.display_name || '').trim().split(/\s+/)[0] || '';

router.post('/:id/test-send', async (req, res, next) => {
  try {
    const cfg = await sendgrid.loadConfig(req.tenantId);
    const sg = sendgrid.status(cfg);
    if (!sg.configured) return res.status(409).json({ error: 'Test pójdzie, gdy ustawienia SendGrid będą kompletne. Brakuje: ' + sg.missing.join(', ') });
    const { rows } = await db.query(`SELECT * FROM crm_email_campaigns WHERE id = $1 AND tenant_id = $2`, [idParam(req), req.tenantId]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'Nie znaleziono kampanii' });
    if (!c.sendgrid_template_id) return res.status(400).json({ error: 'Wybierz szablon i zapisz szkic' });
    let to = (arr(req.body?.to) || []).map(x => x.trim().toLowerCase()).filter(x => EMAIL_RE.test(x));
    if (!to.length && req.user.email) to = [String(req.user.email).toLowerCase()];
    to = [...new Set(to)].slice(0, 5);
    if (!to.length) return res.status(400).json({ error: 'Podaj adres e-mail do testu' });
    const tpl = await sendgrid.getTemplate(cfg, c.sendgrid_template_id);
    const msg = sendgrid.templateMessage(cfg, { templateId: c.sendgrid_template_id, utm: c.utm_campaign, categories: ['crm-kampania-test'] });
    msg.personalizations = to.map(addr => ({
      to: [{ email: addr }],
      dynamic_template_data: { imie: firstNameOfUser(req.user), firma: `${cfg.tenantName || 'CRMtree'} (test)` },
    }));
    await sendgrid.send(cfg, msg);
    const { rows: u } = await db.query(
      `UPDATE crm_email_campaigns SET tested_version = $3, tested_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING tested_at, tested_version`,
      [c.id, req.tenantId, versionKey(tpl)]);
    res.json({ sent: true, to, tested_at: u[0].tested_at, tested_version: u[0].tested_version, template: tpl.name });
  } catch (err) {
    if (err.status) return res.status(502).json({ error: err.message });
    if (/^SendGrid \d+/.test(err.message || '')) return res.status(502).json({ error: err.message });
    next(err);
  }
});

router.post('/:id/send', async (req, res, next) => {
  try {
    const id = idParam(req);
    const cfg = await sendgrid.loadConfig(req.tenantId);
    const sg = sendgrid.status(cfg);
    if (!sg.configured) return res.status(409).json({ error: 'Wysyłka nie jest skonfigurowana. Brakuje w ustawieniach SendGrid: ' + sg.missing.join(', ') });
    const { rows: cr } = await db.query(`SELECT * FROM crm_email_campaigns WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
    const c = cr[0];
    if (!c) return res.status(404).json({ error: 'Nie znaleziono kampanii' });
    if (c.status !== 'draft') return res.status(409).json({ error: 'Ta kampania została już wysłana' });
    if (!c.sendgrid_template_id) return res.status(400).json({ error: 'Kampania nie ma szablonu' });
    const tpl = await sendgrid.getTemplate(cfg, c.sendgrid_template_id);
    if (!c.tested_version || c.tested_version !== versionKey(tpl)) {
      return res.status(409).json({ error: 'Najpierw wyślij test do siebie — szablon nie był testowany albo zmienił się w SendGrid od ostatniego testu.' });
    }
    const consent = await sendgrid.resolveTenantConsent(req.tenantId, cfg);
    const preview = await campaigns.buildPreview(previewCtx(req), c.filter_criteria || {}, {
      consentKey: consent.consent_key, min_days_between_sends: c.min_days_between_sends,
      exclude_recent_contact_days: c.exclude_recent_contact_days,
    }, { full: true });
    const toSend = preview.recipients.filter(r => !r.reason);
    if (!toSend.length) return res.status(400).json({ error: 'Nikt nie spełnia warunków — nie ma do kogo wysłać' });
    if (toSend.length > MAX_RECIPIENTS) {
      if (!req.user.is_admin) return res.status(403).json({ error: `Kampania ma ${toSend.length} odbiorców, a limit to ${MAX_RECIPIENTS}. Większą wysyłkę uruchamia admin — albo podziel listę na mniejsze kampanie.` });
      if (req.body?.confirm_large !== true) return res.status(409).json({ error: `Kampania ma ${toSend.length} odbiorców (limit ${MAX_RECIPIENTS}). Potwierdź większą wysyłkę.` });
    }
    // Double-click guard: only one request moves 'draft' to 'sending'.
    // Template name and subject are frozen at send time — history shows what went out.
    const lock = await db.query(
      `UPDATE crm_email_campaigns SET status = 'sending', sent_at = NOW(), send_error = NULL, updated_by = $2,
              sendgrid_template_name = $3, sendgrid_template_subject = $4
        WHERE id = $1 AND tenant_id = $5 AND status = 'draft' RETURNING *`,
      [id, req.user.id, tpl.name, tpl.subject, req.tenantId]);
    if (!lock.rowCount) return res.status(409).json({ error: 'Wysyłka już trwa' });
    const ins = await db.query(`
      INSERT INTO crm_campaign_recipients (tenant_id, campaign_id, entity_type, partner_id, lead_id, email, status, exclusion_reason, company, contact_name)
      SELECT $3, $1, x.entity_type, CASE WHEN x.entity_type = 'partner' THEN x.entity_id::uuid END,
             CASE WHEN x.entity_type = 'lead' THEN x.entity_id::int END, x.email,
             CASE WHEN x.reason IS NULL THEN 'queued' ELSE 'excluded' END, x.reason, x.company, x.contact_name
      FROM jsonb_to_recordset($2::jsonb) AS x(entity_type text, entity_id text, email text, reason text, company text, contact_name text)
      WHERE x.entity_type IS NOT NULL
      RETURNING id, email, status, company, contact_name, entity_type, partner_id, lead_id`,
      [id, JSON.stringify(preview.recipients.map(r => ({
        entity_type: r.entity_type, entity_id: r.entity_id, email: r.email || '', reason: r.reason, company: r.company, contact_name: r.contact_name,
      }))), req.tenantId]);
    const queued = ins.rows.filter(r => r.status === 'queued');
    res.status(202).json({ ok: true, queued: queued.length });
    campaigns.sendCampaign(cfg, lock.rows[0], queued, req.user.id).catch(err =>
      logger.error('[email-campaigns] send failed', { tenantId: req.tenantId, campaignId: id, error: err.message }));
  } catch (err) {
    if (err.status) return res.status(502).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
