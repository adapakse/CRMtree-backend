"use strict";
// src/routes/crm-yandex.js
//
// Yandex Mail — OAuth2. Mirrors the OAUTH2 section of crm-zoho.js.
//
// Real mail operations (send, thread, sync) are stage 2: with a real Yandex app
// the mail routes below answer 501 via yandexService.NotImplementedError. With
// the tenant's client_id set to "demo" they run the simulated mailbox from
// services/yandexDemo.js, so the whole flow can be shown on INT.
//
// Difference from the Zoho callback: Yandex has no accounts-server parameter,
// because a single set of endpoints serves every regional mailbox. There is one
// less thing to validate and one less thing to store.

const express        = require("express");
const router         = express.Router();
const { pool }       = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const { crmAuth }    = require("../middleware/crm-rbac");
const yandexService  = require("../services/yandexService");
const yandexDemo     = require("../services/yandexDemo");
const config         = require("../config");
const { autoSaveLeadContacts, autoSavePartnerContacts } = require("../services/emailContactSync");
const { isTrainingThreadId, buildTrainingThreadResponse } = require("../utils/trainingThread");
const { requireActiveEmailProvider, resolveProviderGate } = require("../middleware/email-provider");

// Guards send/sync actions — blocks them unless this tenant's active provider
// is 'yandex' (bypassed automatically for crm_training_mode tenants).
const yandexGate = requireActiveEmailProvider("yandex");

// multer — the unified send route accepts attachments; demo mode ignores them.
let upload = null;
try {
  const multer = require("multer");
  upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
} catch (_) {
  console.warn("[Yandex] multer niedostępny — wysyłka bez załączników.");
}

const CALLBACK_PATH = "/crm/yandex/callback";

function frontendRedirect(res, params) {
  const qs = new URLSearchParams(params).toString();
  return res.redirect(`${config.frontendUrl}${CALLBACK_PATH}?${qs}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// OAUTH2
// ═══════════════════════════════════════════════════════════════════════════════

// Each CRM user connects their own Yandex mailbox. The tenant only configures
// WHICH provider is active; the mailbox always belongs to req.user.
async function oauthUrlHandler(req, res, next) {
  try {
    const gate = await resolveProviderGate(req.tenantId, "yandex");
    if (!gate.ok) {
      return res.status(gate.active ? 403 : 400).json({
        error: gate.active
          ? `Ta organizacja korzysta z innego dostawcy poczty (${gate.active}).`
          : "Yandex nie jest aktywnym providerem dla tego tenanta.",
        code: "PROVIDER_NOT_ACTIVE",
      });
    }
    const url = await yandexService.getAuthUrl(req.user.id);
    res.json({ url });
  } catch (err) { next(err); }
}
router.get("/oauth/url", requireAuth, crmAuth, oauthUrlHandler);

// No requireAuth — Yandex redirects the browser without an Authorization
// header. userId is carried in the HMAC-signed `state` from /oauth/url.
router.get("/oauth/callback", async (req, res) => {
  try {
    const { code, error, state } = req.query;

    if (error) return frontendRedirect(res, { status: "error", reason: error });
    if (!code)  return frontendRedirect(res, { status: "error", reason: "no_code" });
    if (!state) return frontendRedirect(res, { status: "error", reason: "missing_state" });

    const userId = yandexService.parseOAuthState(state);
    if (!userId) {
      console.error("[Yandex] OAuth callback: invalid_state, raw state=", state);
      return frontendRedirect(res, { status: "error", reason: "invalid_state" });
    }

    const { rows: uRows } = await pool.query("SELECT tenant_id FROM users WHERE id = $1", [userId]);
    const tenantId = uRows[0]?.tenant_id ?? null;
    const gate = await resolveProviderGate(tenantId, "yandex");
    if (!gate.ok) {
      return frontendRedirect(res, { status: "error", reason: "provider_not_active" });
    }

    console.log("[Yandex] OAuth callback: state OK, userId=", userId);
    await yandexService.exchangeCodeAndSave(code, userId);
    console.log("[Yandex] OAuth callback: tokens saved for userId=", userId);

    return frontendRedirect(res, { status: "connected" });
  } catch (err) {
    console.error("[Yandex] OAuth callback error:", err.message, err.stack);
    if (err.code === "MAILBOX_ALREADY_CONNECTED") {
      return frontendRedirect(res, { status: "error", reason: "email_already_connected" });
    }
    return frontendRedirect(res, { status: "error", reason: "callback_failed" });
  }
});

async function statusHandler(req, res) {
  try {
    const status = await yandexService.getStatus(req.user.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
}
router.get("/status", requireAuth, crmAuth, statusHandler);

async function disconnectHandler(req, res) {
  try {
    await yandexService.disconnect(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
}
router.delete("/oauth/disconnect", requireAuth, crmAuth, disconnectHandler);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIL — demo only until stage 2
// ═══════════════════════════════════════════════════════════════════════════════
//
// With a real Yandex app these answer 501 (yandexService.NotImplementedError)
// instead of the 500 the unified /api/crm/email dispatcher used to produce for
// an unknown provider. With client_id = "demo" they simulate the mailbox — see
// services/yandexDemo.js.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolvePartner(rawId, tenantId) {
  if (UUID_RE.test(String(rawId))) {
    const { rows } = await pool.query(
      "SELECT id, company FROM crm_partners WHERE id = $1 AND tenant_id = $2", [rawId, tenantId],
    );
    return rows[0] ?? null;
  }
  const num = parseInt(rawId);
  if (isNaN(num)) return null;
  const { rows } = await pool.query(
    "SELECT id, company FROM crm_partners WHERE dwh_partner_id = $1 AND tenant_id = $2", [num, tenantId],
  );
  return rows[0] ?? null;
}

function sendMailError(res, err, label) {
  console.error(`[Yandex] ${label} error:`, err.message);
  if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  res.status(500).json({ error: `Błąd: ${err.message}` });
}

// Shared by lead/partner sends — the two differ only in table and record id.
async function sendDemo(req, res, { table, idCol, recordId, autoSave }) {
  const { to, subject, body, threadId } = req.body;

  if (threadId) {
    const ownerQ = await pool.query(
      `SELECT mailbox_user_id FROM ${table} WHERE ${idCol} = $1 AND gmail_thread_id = $2 AND tenant_id = $3 LIMIT 1`,
      [recordId, threadId, req.tenantId],
    );
    const ownerId = ownerQ.rows[0]?.mailbox_user_id;
    if (ownerId && ownerId !== req.user.id) {
      return res.status(403).json({
        error: "Ten wątek należy do innego użytkownika — nie możesz w nim odpowiadać. Wyślij nowego maila ze swojego konta.",
        code:  "THREAD_NOT_OWNED",
      });
    }
  }

  const messageId    = yandexDemo.newMessageId();
  const sentThreadId = threadId || yandexDemo.newThreadId();

  const actR = await pool.query(
    `INSERT INTO ${table}
       (${idCol}, type, title, body, activity_at, gmail_thread_id, gmail_message_id,
        email_provider, created_by, mailbox_user_id, is_read, tenant_id)
     VALUES ($1, 'email', $2, $3, NOW(), $4, $5, 'yandex', $6, $6, true, $7)
     RETURNING id`,
    [recordId, subject, body || null, sentThreadId, messageId, req.user.id, req.tenantId],
  );

  const toRecipients = String(to).split(",").map((s) => s.trim()).filter(Boolean);
  await autoSave(recordId, toRecipients, req.tenantId);

  yandexDemo.scheduleDemoReply({
    table, idCol, recordId, subject, threadId: sentThreadId, userId: req.user.id, tenantId: req.tenantId,
  });

  res.json({ messageId, threadId: sentThreadId, activityId: actR.rows[0].id });
}

async function sendLeadHandler(req, res) {
  try {
    const { to, subject } = req.body;
    if (!to || !subject) return res.status(400).json({ error: "Pola 'to' i 'subject' są wymagane" });

    const leadId = parseInt(req.params.leadId);
    const leadQ  = await pool.query(
      "SELECT id FROM crm_leads WHERE id = $1 AND tenant_id = $2", [leadId, req.tenantId],
    );
    if (!leadQ.rows.length) return res.status(404).json({ error: "Lead nie znaleziony" });

    if (!(await yandexService.isDemoUser(req.user.id))) await yandexService.sendEmail();
    return await sendDemo(req, res, {
      table: "crm_lead_activities", idCol: "lead_id", recordId: leadId, autoSave: autoSaveLeadContacts,
    });
  } catch (err) { sendMailError(res, err, "send/lead"); }
}

async function sendPartnerHandler(req, res) {
  try {
    const { to, subject } = req.body;
    if (!to || !subject) return res.status(400).json({ error: "Pola 'to' i 'subject' są wymagane" });

    const partner = await resolvePartner(req.params.partnerId, req.tenantId);
    if (!partner) return res.status(404).json({ error: "Partner nie znaleziony" });

    if (!(await yandexService.isDemoUser(req.user.id))) await yandexService.sendEmail();
    return await sendDemo(req, res, {
      table: "crm_partner_activities", idCol: "partner_id", recordId: partner.id, autoSave: autoSavePartnerContacts,
    });
  } catch (err) { sendMailError(res, err, "send/partner"); }
}

if (upload) {
  router.post("/send/lead/:leadId",       requireAuth, crmAuth, yandexGate, upload.array("attachments", 10), sendLeadHandler);
  router.post("/send/partner/:partnerId", requireAuth, crmAuth, yandexGate, upload.array("attachments", 10), sendPartnerHandler);
} else {
  router.post("/send/lead/:leadId",       requireAuth, crmAuth, yandexGate, sendLeadHandler);
  router.post("/send/partner/:partnerId", requireAuth, crmAuth, yandexGate, sendPartnerHandler);
}

// Demo threads carry the training_thread_ prefix, so they are rebuilt from our
// own DB exactly like crm_training_mode threads. Anything else would need IMAP.
async function threadResponse(req, res, { table, idCol, idVal }) {
  if (!isTrainingThreadId(req.params.threadId)) await yandexService.getThread();
  const result = await buildTrainingThreadResponse({
    table, idCol, idVal,
    threadId: req.params.threadId, tenantId: req.tenantId, currentUserId: req.user.id,
    counterpartyLabel: yandexDemo.DEMO_COUNTERPARTY,
  });
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json(result);
}

async function threadLeadHandler(req, res) {
  try {
    const leadId = parseInt(req.params.leadId);
    await threadResponse(req, res, { table: "crm_lead_activities", idCol: "lead_id", idVal: leadId });
    // Opening the thread reads it — same as the real providers' thread handlers.
    await pool.query(
      `UPDATE crm_lead_activities SET is_read = true, updated_at = NOW()
       WHERE lead_id = $1 AND gmail_thread_id = $2 AND type = 'email' AND is_read = false AND tenant_id = $3`,
      [leadId, req.params.threadId, req.tenantId],
    );
    await pool.query(
      `UPDATE crm_email_message_reads SET is_read = true, updated_at = NOW()
       WHERE gmail_thread_id = $1 AND tenant_id = $2`,
      [req.params.threadId, req.tenantId],
    );
  } catch (err) { if (!res.headersSent) sendMailError(res, err, "thread/lead"); }
}
router.get("/thread/lead/:leadId/:threadId", requireAuth, crmAuth, threadLeadHandler);

async function threadPartnerHandler(req, res) {
  try {
    const resolved  = await resolvePartner(req.params.partnerId, req.tenantId);
    const partnerId = resolved?.id ?? req.params.partnerId;
    await threadResponse(req, res, { table: "crm_partner_activities", idCol: "partner_id", idVal: partnerId });
    await pool.query(
      `UPDATE crm_partner_activities SET is_read = true, updated_at = NOW()
       WHERE partner_id = $1 AND gmail_thread_id = $2 AND type = 'email' AND is_read = false AND tenant_id = $3`,
      [partnerId, req.params.threadId, req.tenantId],
    );
  } catch (err) { if (!res.headersSent) sendMailError(res, err, "thread/partner"); }
}
router.get("/thread/partner/:partnerId/:threadId", requireAuth, crmAuth, threadPartnerHandler);

// "Check for new mail" — in demo mode delivers one sample email.
async function debugProcessHandler(req, res) {
  try {
    const status = await yandexService.getStatus(req.user.id);
    if (!status.connected) return res.status(404).json({ error: "Brak podłączonego konta Yandex" });
    if (!(await yandexService.isDemoUser(req.user.id))) await yandexService.getNewMessages();

    const found = await yandexDemo.deliverDemoEmail(req.user.id, req.tenantId);
    res.json({ ok: true, email: status.email, note: null, newMessages_found: found });
  } catch (err) { sendMailError(res, err, "debug/process"); }
}
router.post("/debug/process", requireAuth, crmAuth, yandexGate, debugProcessHandler);

// Handlers reused by the unified /api/crm/email dispatcher (crm-email.js).
router.handlers = {
  oauthUrl:      oauthUrlHandler,
  status:        statusHandler,
  disconnect:    disconnectHandler,
  sendLead:      sendLeadHandler,
  sendPartner:   sendPartnerHandler,
  threadLead:    threadLeadHandler,
  threadPartner: threadPartnerHandler,
  debugProcess:  debugProcessHandler,
};

module.exports = router;
