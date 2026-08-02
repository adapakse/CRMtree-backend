"use strict";
// src/routes/crm-outlook.js

const express         = require("express");
const router          = express.Router();
const { pool }        = require("../config/database");
const { requireAuth }  = require("../middleware/auth");
const { crmAuth }     = require("../middleware/crm-rbac");
const outlookService  = require("../services/outlookService");
const outlookProcessor = require("../services/outlookProcessor");
const storageService  = require("../services/storageService");
const config          = require("../config");
const { v4: uuidv4 }  = require("uuid");
const {
  autoSaveLeadContacts,
  autoSavePartnerContacts,
  storeAttachment,
} = require("../services/emailContactSync");
const { isTrainingMode } = require("../utils/trainingMode");
const { isTrainingThreadId, buildTrainingThreadResponse } = require("../utils/trainingThread");
const { requireActiveEmailProvider, resolveProviderGate } = require("../middleware/email-provider");

// Guards connect/send/sync actions — blocks them unless this tenant's active
// provider is 'outlook' (bypassed automatically for crm_training_mode tenants).
const outlookGate = requireActiveEmailProvider("outlook");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolvePartner(rawId, tenantId) {
  if (UUID_RE.test(String(rawId))) {
    const { rows } = await pool.query(
      "SELECT id, company FROM crm_partners WHERE id = $1 AND tenant_id = $2", [rawId, tenantId]
    );
    return rows[0] ?? null;
  }
  const num = parseInt(rawId);
  if (isNaN(num)) return null;
  const { rows } = await pool.query(
    "SELECT id, company FROM crm_partners WHERE dwh_partner_id = $1 AND tenant_id = $2", [num, tenantId]
  );
  return rows[0] ?? null;
}

// Treść symulowanej odpowiedzi e-mail w trybie szkoleniowym
const TRAINING_REPLY_BODY = `Dzień dobry,

Dziękuję za wiadomość. Zapoznałem się z przesłaną ofertą i jestem zainteresowany dalszą rozmową.
Proszę o kontakt w celu umówienia spotkania w przyszłym tygodniu.

Z poważaniem,
Jan Kowalski
Dyrektor ds. Operacyjnych`;

async function scheduleTrainingReplyLead(leadId, subject, threadId, userId, tenantId) {
  setTimeout(async () => {
    try {
      const fakeReplyId = `training_reply_${uuidv4().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO crm_lead_activities
           (lead_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id, is_read, tenant_id)
         VALUES ($1, 'email', $2, $3, NOW(), $4, $5, false, $6)`,
        [leadId, `Re: ${subject}`, TRAINING_REPLY_BODY, threadId, fakeReplyId, tenantId],
      );
    } catch (e) {
      console.warn('[Training] scheduleTrainingReplyLead failed:', e.message);
    }
  }, 45_000);
}

async function scheduleTrainingReplyPartner(partnerId, subject, threadId, tenantId) {
  setTimeout(async () => {
    try {
      const fakeReplyId = `training_reply_${uuidv4().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO crm_partner_activities
           (partner_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id, is_read, tenant_id)
         VALUES ($1, 'email', $2, $3, NOW(), $4, $5, false, $6)`,
        [partnerId, `Re: ${subject}`, TRAINING_REPLY_BODY, threadId, fakeReplyId, tenantId],
      );
    } catch (e) {
      console.warn('[Training] scheduleTrainingReplyPartner failed:', e.message);
    }
  }, 45_000);
}

// multer — do załączników w wysyłce
let upload = null;
try {
  const multer = require("multer");
  upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
} catch (_) {
  console.warn("[Outlook] multer niedostępny — wysyłka bez załączników. Uruchom: npm install multer");
}

// ── Helpers (lokalnie — rejestracja ref. załączników bez pobierania treści) ────

// Zapisuje metadane załączników do crm_email_attachments bez pobierania treści
// (blob_path = NULL). Wywołana przy pobieraniu wątku — umożliwia późniejsze pobranie.
async function registerAttachmentRefs({ leadId, partnerId, messageId, attachments, tenantId, mailboxUserId }) {
  const idCol = leadId ? "lead_id" : "partner_id";
  const idVal = leadId || partnerId;
  for (const att of attachments || []) {
    try {
      await pool.query(
        `INSERT INTO crm_email_attachments
           (${idCol}, gmail_message_id, gmail_attachment_id, filename, mime_type, direction, tenant_id, mailbox_user_id)
         VALUES ($1, $2, $3, $4, $5, 'received', $6, $7)
         ON CONFLICT DO NOTHING`,
        [idVal, messageId, att.attachmentId, att.filename, att.mimeType || "application/octet-stream", tenantId, mailboxUserId || null],
      );
    } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OAUTH2
// ═══════════════════════════════════════════════════════════════════════════════

// Each CRM user connects their own Microsoft 365 account — triggered inline
// from "Nowy e-mail" (see crm-email.js dispatcher), not from a superadmin
// panel. The tenant only chooses/configures WHICH provider is active; the
// mailbox itself always belongs to req.user, never to the tenant as a whole.
async function oauthUrlHandler(req, res, next) {
  try {
    const gate = await resolveProviderGate(req.tenantId, "outlook");
    if (!gate.ok) {
      return res.status(gate.active ? 403 : 400).json({
        error: gate.active
          ? `Ta organizacja korzysta z innego dostawcy poczty (${gate.active}).`
          : "Outlook nie jest aktywnym providerem dla tego tenanta.",
        code: "PROVIDER_NOT_ACTIVE",
      });
    }
    const url = await outlookService.getAuthUrl(req.user.id, req.tenantId);
    res.json({ url });
  } catch (err) { next(err); }
}
router.get("/oauth/url", requireAuth, crmAuth, oauthUrlHandler);

// Brak requireAuth — Microsoft redirectuje przeglądarkę bez headera Authorization.
// userId jest bezpiecznie zakodowany w parametrze `state` wygenerowanym przez /oauth/url.
router.get("/oauth/callback", async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.redirect(`${config.frontendUrl}/crm/outlook/callback?status=error&reason=${encodeURIComponent(error)}`);
    if (!code)  return res.redirect(`${config.frontendUrl}/crm/outlook/callback?status=error&reason=no_code`);
    if (!state) return res.redirect(`${config.frontendUrl}/crm/outlook/callback?status=error&reason=missing_state`);

    const userId = outlookService.parseOAuthState(state);
    if (!userId) {
      console.error("[Outlook] OAuth callback: invalid_state, raw state=", state);
      return res.redirect(`${config.frontendUrl}/crm/outlook/callback?status=error&reason=invalid_state`);
    }

    const { rows: uRows } = await pool.query("SELECT tenant_id FROM users WHERE id = $1", [userId]);
    const tenantId = uRows[0]?.tenant_id ?? null;
    const gate = await resolveProviderGate(tenantId, "outlook");
    if (!gate.ok) {
      return res.redirect(`${config.frontendUrl}/crm/outlook/callback?status=error&reason=provider_not_active`);
    }

    console.log("[Outlook] OAuth callback: state OK, userId=", userId);
    await outlookService.exchangeCodeAndSave(code, userId);
    console.log("[Outlook] OAuth callback: tokens saved for userId=", userId);

    // Ustaw punkt startowy delta query (ignoruj błąd — pierwszy poll zrobi to sam)
    try { await outlookService.initDeltaLink(userId); } catch (_) {}

    res.redirect(`${config.frontendUrl}/crm/outlook/callback?status=connected`);
  } catch (err) {
    console.error("[Outlook] OAuth callback error:", err.message, err.stack);
    if (err.code === "MAILBOX_ALREADY_CONNECTED") {
      return res.redirect(`${config.frontendUrl}/crm/outlook/callback?status=error&reason=email_already_connected`);
    }
    res.redirect(`${config.frontendUrl}/crm/outlook/callback?status=error&reason=callback_failed`);
  }
});

async function statusHandler(req, res) {
  try {
    const status = await outlookService.getStatus(req.user.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
}
router.get("/status", requireAuth, crmAuth, statusHandler);

async function disconnectHandler(req, res) {
  try {
    await outlookService.disconnect(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
}
router.delete("/oauth/disconnect", requireAuth, crmAuth, disconnectHandler);

// ═══════════════════════════════════════════════════════════════════════════════
// WYSYŁKA — LEAD
// ═══════════════════════════════════════════════════════════════════════════════

async function sendLeadHandler(req, res) {
  try {
    const leadId = parseInt(req.params.leadId);
    const { to, cc, subject, body, threadId, inReplyTo, references } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: "Pola 'to' i 'subject' są wymagane" });
    }

    const leadQ = await pool.query(
      "SELECT id, company FROM crm_leads WHERE id = $1 AND tenant_id = $2",
      [leadId, req.tenantId]
    );
    if (!leadQ.rows.length) return res.status(404).json({ error: "Lead nie znaleziony" });

    // A reply within an existing thread must go out from the mailbox that
    // owns it — Outlook conversations are scoped to one Microsoft account
    // and cannot be continued from another user's connected mailbox.
    if (threadId) {
      const ownerQ = await pool.query(
        "SELECT mailbox_user_id FROM crm_lead_activities WHERE lead_id = $1 AND gmail_thread_id = $2 AND tenant_id = $3 LIMIT 1",
        [leadId, threadId, req.tenantId],
      );
      const ownerId = ownerQ.rows[0]?.mailbox_user_id;
      if (ownerId && ownerId !== req.user.id) {
        return res.status(403).json({
          error: "Ten wątek należy do innego użytkownika — nie możesz w nim odpowiadać. Wyślij nowego maila ze swojego konta.",
          code:  "THREAD_NOT_OWNED",
        });
      }
    }

    const training = await isTrainingMode(req.tenantId);

    let messageId, sentThreadId;

    if (training) {
      messageId    = `training_sent_${uuidv4().replace(/-/g, '')}`;
      sentThreadId = threadId || `training_thread_${uuidv4().replace(/-/g, '')}`;
    } else {
      const attachments = (req.files || []).map((f) => ({
        filename: f.originalname,
        mimeType: f.mimetype,
        data:     f.buffer.toString("base64"),
        _buffer:  f.buffer,
      }));

      const sent = await outlookService.sendEmail({
        userId:      req.user.id,
        to, cc: cc || null, subject,
        body:        body || "",
        inReplyTo:   inReplyTo  || null,
        references:  references || null,
        attachments: attachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
      });
      messageId    = sent.messageId;
      // A reply to an existing CRM thread always stays in that thread — the
      // provider's own returned threadId (conversationId) is only the anchor
      // for a genuinely NEW message (no incoming threadId). Graph can assign
      // a different conversationId to a reply once the subject changes, but
      // that must never split the CRM's own view of the conversation —
      // threadLeadHandler/threadPartnerHandler already backfill any message
      // Graph's conversationId filter doesn't return, by fetching it
      // directly by its known message id.
      sentThreadId = threadId || sent.threadId;

      for (const att of attachments) {
        storeAttachment({
          leadId,
          messageId,
          attachmentId: null,
          filename:     att.filename,
          mimeType:     att.mimeType,
          buffer:       att._buffer,
          direction:    "sent",
          mailboxUserId: req.user.id,
        }).catch((e) => console.warn("[Outlook] Sent attachment blob save failed:", e.message));
      }
    }

    // Zapisz aktywność (mailbox_user_id = created_by: nadawca jest zawsze
    // właścicielem skrzynki dla wiadomości wychodzącej)
    const actR = await pool.query(
      `INSERT INTO crm_lead_activities
         (lead_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id,
          email_provider, created_by, mailbox_user_id, is_read, tenant_id)
       VALUES ($1, 'email', $2, $3, NOW(), $4, $5, 'outlook', $6, $6, true, $7)
       RETURNING id`,
      [leadId, subject, body || null, sentThreadId, messageId, req.user.id, req.tenantId],
    );

    // Auto-zapis TYLKO odbiorców To (nie CC) do kontaktów leada
    const toRecipients = String(to).split(",").map((s) => s.trim()).filter(Boolean);
    await autoSaveLeadContacts(leadId, toRecipients, req.tenantId);

    if (training) {
      scheduleTrainingReplyLead(leadId, subject, sentThreadId, req.user.id, req.tenantId);
    }

    res.json({ messageId, threadId: sentThreadId, activityId: actR.rows[0].id });
  } catch (err) {
    console.error("[Outlook] send/lead error:", err.message);
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err.message?.includes("Brak połączonego konta")) {
      return res.status(401).json({ error: err.message });
    }
    res.status(500).json({ error: "Błąd wysyłki emaila: " + err.message });
  }
}

if (upload) {
  router.post("/send/lead/:leadId", requireAuth, crmAuth, outlookGate, upload.array("attachments", 10), sendLeadHandler);
} else {
  router.post("/send/lead/:leadId", requireAuth, crmAuth, outlookGate, sendLeadHandler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WYSYŁKA — PARTNER
// ═══════════════════════════════════════════════════════════════════════════════

async function sendPartnerHandler(req, res) {
  try {
    const { to, cc, subject, body, threadId, inReplyTo, references } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: "Pola 'to' i 'subject' są wymagane" });
    }

    const partner = await resolvePartner(req.params.partnerId, req.tenantId);
    if (!partner) return res.status(404).json({ error: "Partner nie znaleziony" });
    const crmPartnerId = partner.id;

    // A reply within an existing thread must go out from the mailbox that
    // owns it — Outlook conversations are scoped to one Microsoft account
    // and cannot be continued from another user's connected mailbox.
    if (threadId) {
      const ownerQ = await pool.query(
        "SELECT mailbox_user_id FROM crm_partner_activities WHERE partner_id = $1 AND gmail_thread_id = $2 AND tenant_id = $3 LIMIT 1",
        [crmPartnerId, threadId, req.tenantId],
      );
      const ownerId = ownerQ.rows[0]?.mailbox_user_id;
      if (ownerId && ownerId !== req.user.id) {
        return res.status(403).json({
          error: "Ten wątek należy do innego użytkownika — nie możesz w nim odpowiadać. Wyślij nowego maila ze swojego konta.",
          code:  "THREAD_NOT_OWNED",
        });
      }
    }

    const training = await isTrainingMode(req.tenantId);

    let messageId, sentThreadId;

    if (training) {
      messageId    = `training_sent_${uuidv4().replace(/-/g, '')}`;
      sentThreadId = threadId || `training_thread_${uuidv4().replace(/-/g, '')}`;
    } else {
      const attachments = (req.files || []).map((f) => ({
        filename: f.originalname,
        mimeType: f.mimetype,
        data:     f.buffer.toString("base64"),
        _buffer:  f.buffer,
      }));

      const sent = await outlookService.sendEmail({
        userId:      req.user.id,
        to, cc: cc || null, subject,
        body:        body || "",
        inReplyTo:   inReplyTo  || null,
        references:  references || null,
        attachments: attachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
      });
      messageId    = sent.messageId;
      // A reply to an existing CRM thread always stays in that thread — the
      // provider's own returned threadId (conversationId) is only the anchor
      // for a genuinely NEW message (no incoming threadId). Graph can assign
      // a different conversationId to a reply once the subject changes, but
      // that must never split the CRM's own view of the conversation —
      // threadLeadHandler/threadPartnerHandler already backfill any message
      // Graph's conversationId filter doesn't return, by fetching it
      // directly by its known message id.
      sentThreadId = threadId || sent.threadId;

      for (const att of attachments) {
        storeAttachment({
          partnerId: crmPartnerId,
          messageId,
          attachmentId: null,
          filename:     att.filename,
          mimeType:     att.mimeType,
          buffer:       att._buffer,
          direction:    "sent",
          mailboxUserId: req.user.id,
        }).catch((e) => console.warn("[Outlook] Sent attachment blob save failed:", e.message));
      }
    }

    const actR = await pool.query(
      `INSERT INTO crm_partner_activities
         (partner_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id,
          email_provider, created_by, mailbox_user_id, is_read, tenant_id)
       VALUES ($1, 'email', $2, $3, NOW(), $4, $5, 'outlook', $6, $6, true, $7)
       RETURNING id`,
      [crmPartnerId, subject, body || null, sentThreadId, messageId, req.user.id, req.tenantId],
    );

    // Auto-zapis TYLKO odbiorców To (nie CC) do kontaktów partnera
    const toRecipients = String(to).split(",").map((s) => s.trim()).filter(Boolean);
    await autoSavePartnerContacts(crmPartnerId, toRecipients, req.tenantId);

    if (training) {
      scheduleTrainingReplyPartner(crmPartnerId, subject, sentThreadId, req.tenantId);
    }

    res.json({ messageId, threadId: sentThreadId, activityId: actR.rows[0].id });
  } catch (err) {
    console.error("[Outlook] send/partner error:", err.message);
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err.message?.includes("Brak połączonego konta")) {
      return res.status(401).json({ error: err.message });
    }
    res.status(500).json({ error: "Błąd wysyłki emaila: " + err.message });
  }
}

if (upload) {
  router.post("/send/partner/:partnerId", requireAuth, crmAuth, outlookGate, upload.array("attachments", 10), sendPartnerHandler);
} else {
  router.post("/send/partner/:partnerId", requireAuth, crmAuth, outlookGate, sendPartnerHandler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POBIERANIE WĄTKÓW (z rejestracją załączników w DB)
// ═══════════════════════════════════════════════════════════════════════════════

async function threadLeadHandler(req, res) {
  try {
    const leadId = parseInt(req.params.leadId);

    if (isTrainingThreadId(req.params.threadId)) {
      const result = await buildTrainingThreadResponse({
        table: 'crm_lead_activities', idCol: 'lead_id', idVal: leadId,
        threadId: req.params.threadId, tenantId: req.tenantId, currentUserId: req.user.id,
      });
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.json(result);
    }

    // Outlook conversations live in one Microsoft account — read with the
    // token of whichever user's mailbox owns this thread, not the current
    // viewer's.
    const ownerQ = await pool.query(
      `SELECT a.mailbox_user_id, u.email AS owner_email
       FROM crm_lead_activities a
       LEFT JOIN users u ON u.id = a.mailbox_user_id
       WHERE a.lead_id = $1 AND a.gmail_thread_id = $2 AND a.tenant_id = $3
       LIMIT 1`,
      [leadId, req.params.threadId, req.tenantId],
    );
    const ownerId    = ownerQ.rows[0]?.mailbox_user_id || null;
    const ownerEmail = ownerQ.rows[0]?.owner_email || null;
    if (!ownerId) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.json({
        messages: [], canReply: false, ownerEmail: null, unavailable: true,
        reason: "Ten wątek nie ma przypisanego właściciela skrzynki — treść niedostępna.",
      });
    }

    const messages = await outlookService.getThread(ownerId, req.params.threadId);

    // Microsoft Graph's conversationId filter (used by outlookService.getThread)
    // silently omits messages whose subject was changed relative to the
    // conversation's original topic, even though they carry the identical
    // conversationId — confirmed directly against Graph, not a threadId/
    // conversationId assignment bug. We already know every message we ever
    // recorded for this thread from our own DB, so backfill anything Graph's
    // filter dropped by fetching it directly by id.
    const foundIds = new Set(messages.map(m => m.id));
    const { rows: knownRows } = await pool.query(
      `SELECT DISTINCT gmail_message_id FROM crm_lead_activities
       WHERE lead_id = $1 AND gmail_thread_id = $2 AND tenant_id = $3 AND gmail_message_id IS NOT NULL`,
      [leadId, req.params.threadId, req.tenantId],
    );
    const missingIds = knownRows.map(r => r.gmail_message_id).filter(id => !foundIds.has(id));
    if (missingIds.length) {
      const backfilled = await Promise.all(missingIds.map(id => outlookService.getMessage(ownerId, id).catch(() => null)));
      for (const msg of backfilled) if (msg) messages.push(msg);
      messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }

    for (const msg of messages) {
      if (msg.attachments?.length) {
        registerAttachmentRefs({ leadId, messageId: msg.id, attachments: msg.attachments, tenantId: req.tenantId, mailboxUserId: ownerId }).catch(() => {});
      }
    }

    const msgIds = messages.map(m => m.id);
    if (msgIds.length) {
      const { rows: outRows } = await pool.query(
        `SELECT id AS activity_id, gmail_message_id FROM crm_lead_activities
         WHERE lead_id = $1 AND gmail_message_id = ANY($2) AND tenant_id = $3`,
        [leadId, msgIds, req.tenantId],
      );
      const outIds = new Set(outRows.map(r => r.gmail_message_id));

      const incomingIds = msgIds.filter(id => !outIds.has(id));
      if (incomingIds.length) {
        pool.query(
          `UPDATE crm_email_message_reads SET is_read = true, updated_at = NOW()
           WHERE gmail_message_id = ANY($1) AND tenant_id = $2`,
          [incomingIds, req.tenantId],
        ).catch(e => console.warn("[Outlook] auto-mark read failed:", e.message));
        pool.query(
          `UPDATE crm_lead_activities SET is_read = true, updated_at = NOW()
           WHERE lead_id = $1 AND gmail_thread_id = $2 AND type = 'email' AND is_read = false AND tenant_id = $3`,
          [leadId, req.params.threadId, req.tenantId],
        ).catch(e => console.warn("[Outlook] mark thread activity read failed:", e.message));
      }

      const { rows: readRows } = await pool.query(
        `SELECT gmail_message_id, is_read FROM crm_email_message_reads WHERE gmail_message_id = ANY($1) AND tenant_id = $2`,
        [msgIds, req.tenantId],
      );
      const readMap = Object.fromEntries(readRows.map(r => [r.gmail_message_id, r.is_read]));

      for (const msg of messages) {
        if (outIds.has(msg.id)) {
          msg.is_read    = true;
          msg.created_by = 'outgoing';
          msg.activity_id = outRows.find(r => r.gmail_message_id === msg.id)?.activity_id ?? null;
        } else {
          msg.is_read    = readMap[msg.id] ?? false;
          msg.created_by = null;
          msg.activity_id = null;
        }
      }

      const { rows: sentAtts } = await pool.query(
        `SELECT gmail_message_id, filename, mime_type, blob_path, gmail_attachment_id
         FROM crm_email_attachments
         WHERE lead_id = $1 AND gmail_message_id = ANY($2) AND direction = 'sent' AND tenant_id = $3`,
        [leadId, msgIds, req.tenantId],
      );
      for (const msg of messages) {
        msg.sentAttachments = sentAtts
          .filter(a => a.gmail_message_id === msg.id)
          .map(a => ({ filename: a.filename, mimeType: a.mime_type, blobPath: a.blob_path }));
      }
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ messages, canReply: ownerId === req.user.id, ownerEmail });
  } catch (err) {
    console.error("[Outlook] getThread/lead error:", err.message);
    if (err.message?.includes("Brak połączonego konta")) {
      return res.status(404).json({
        error: "Ten wątek należy do konta, które zostało rozłączone — pełna treść jest niedostępna.",
        code:  "MAILBOX_DISCONNECTED",
      });
    }
    res.status(500).json({ error: "Błąd pobierania wątku: " + err.message });
  }
}
router.get("/thread/lead/:leadId/:threadId", requireAuth, crmAuth, threadLeadHandler);

async function threadPartnerHandler(req, res) {
  try {
    const resolved  = await resolvePartner(req.params.partnerId, req.tenantId);
    const partnerId = resolved?.id ?? req.params.partnerId;

    if (isTrainingThreadId(req.params.threadId)) {
      const result = await buildTrainingThreadResponse({
        table: 'crm_partner_activities', idCol: 'partner_id', idVal: partnerId,
        threadId: req.params.threadId, tenantId: req.tenantId, currentUserId: req.user.id,
      });
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.json(result);
    }

    const ownerQ = await pool.query(
      `SELECT a.mailbox_user_id, u.email AS owner_email
       FROM crm_partner_activities a
       LEFT JOIN users u ON u.id = a.mailbox_user_id
       WHERE a.partner_id = $1 AND a.gmail_thread_id = $2 AND a.tenant_id = $3
       LIMIT 1`,
      [partnerId, req.params.threadId, req.tenantId],
    );
    const ownerId    = ownerQ.rows[0]?.mailbox_user_id || null;
    const ownerEmail = ownerQ.rows[0]?.owner_email || null;
    if (!ownerId) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.json({
        messages: [], canReply: false, ownerEmail: null, unavailable: true,
        reason: "Ten wątek nie ma przypisanego właściciela skrzynki — treść niedostępna.",
      });
    }

    const messages = await outlookService.getThread(ownerId, req.params.threadId);

    // See threadLeadHandler — Graph's conversationId filter silently drops
    // messages whose subject changed, so backfill anything missing from our
    // own DB record of this thread's known message ids.
    const foundIds = new Set(messages.map(m => m.id));
    const { rows: knownRows } = await pool.query(
      `SELECT DISTINCT gmail_message_id FROM crm_partner_activities
       WHERE partner_id = $1 AND gmail_thread_id = $2 AND tenant_id = $3 AND gmail_message_id IS NOT NULL`,
      [partnerId, req.params.threadId, req.tenantId],
    );
    const missingIds = knownRows.map(r => r.gmail_message_id).filter(id => !foundIds.has(id));
    if (missingIds.length) {
      const backfilled = await Promise.all(missingIds.map(id => outlookService.getMessage(ownerId, id).catch(() => null)));
      for (const msg of backfilled) if (msg) messages.push(msg);
      messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }

    for (const msg of messages) {
      if (msg.attachments?.length) {
        registerAttachmentRefs({ partnerId, messageId: msg.id, attachments: msg.attachments, tenantId: req.tenantId, mailboxUserId: ownerId }).catch(() => {});
      }
    }

    const msgIds = messages.map(m => m.id);
    if (msgIds.length) {
      const { rows: outRows } = await pool.query(
        `SELECT id AS activity_id, gmail_message_id FROM crm_partner_activities
         WHERE partner_id = $1 AND gmail_message_id = ANY($2) AND tenant_id = $3`,
        [partnerId, msgIds, req.tenantId],
      );
      const outIds = new Set(outRows.map(r => r.gmail_message_id));

      const incomingIds = msgIds.filter(id => !outIds.has(id));
      if (incomingIds.length) {
        pool.query(
          `UPDATE crm_email_message_reads SET is_read = true, updated_at = NOW()
           WHERE gmail_message_id = ANY($1) AND tenant_id = $2`,
          [incomingIds, req.tenantId],
        ).catch(e => console.warn("[Outlook] auto-mark read failed:", e.message));
        pool.query(
          `UPDATE crm_partner_activities SET is_read = true, updated_at = NOW()
           WHERE partner_id = $1 AND gmail_thread_id = $2 AND type = 'email' AND is_read = false AND tenant_id = $3`,
          [partnerId, req.params.threadId, req.tenantId],
        ).catch(e => console.warn("[Outlook] mark partner thread activity read failed:", e.message));
      }

      const { rows: readRows } = await pool.query(
        `SELECT gmail_message_id, is_read FROM crm_email_message_reads WHERE gmail_message_id = ANY($1) AND tenant_id = $2`,
        [msgIds, req.tenantId],
      );
      const readMap = Object.fromEntries(readRows.map(r => [r.gmail_message_id, r.is_read]));

      for (const msg of messages) {
        if (outIds.has(msg.id)) {
          msg.is_read    = true;
          msg.created_by = 'outgoing';
          msg.activity_id = outRows.find(r => r.gmail_message_id === msg.id)?.activity_id ?? null;
        } else {
          msg.is_read    = readMap[msg.id] ?? false;
          msg.created_by = null;
          msg.activity_id = null;
        }
      }

      const { rows: sentAtts } = await pool.query(
        `SELECT gmail_message_id, filename, mime_type, blob_path
         FROM crm_email_attachments
         WHERE partner_id = $1 AND gmail_message_id = ANY($2) AND direction = 'sent' AND tenant_id = $3`,
        [partnerId, msgIds, req.tenantId],
      );
      for (const msg of messages) {
        msg.sentAttachments = sentAtts
          .filter(a => a.gmail_message_id === msg.id)
          .map(a => ({ filename: a.filename, mimeType: a.mime_type, blobPath: a.blob_path }));
      }
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ messages, canReply: ownerId === req.user.id, ownerEmail });
  } catch (err) {
    console.error("[Outlook] getThread/partner error:", err.message);
    if (err.message?.includes("Brak połączonego konta")) {
      return res.status(404).json({
        error: "Ten wątek należy do konta, które zostało rozłączone — pełna treść jest niedostępna.",
        code:  "MAILBOX_DISCONNECTED",
      });
    }
    res.status(500).json({ error: "Błąd pobierania wątku: " + err.message });
  }
}
router.get("/thread/partner/:partnerId/:threadId", requireAuth, crmAuth, threadPartnerHandler);

// ═══════════════════════════════════════════════════════════════════════════════
// POBIERANIE ZAŁĄCZNIKA
// Serwuje z Azure Blob (trwałe), lub pobiera z Graph API i zapisuje do Blob.
// Działa nawet po rozłączeniu konta Outlook — o ile blob_path jest wypełniony.
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sent-attachment/:messageId", requireAuth, crmAuth, async (req, res) => {
  const { messageId } = req.params;
  const filename = String(req.query.filename || "attachment").replace(/[^a-zA-Z0-9._\- ]/g, "_");
  try {
    const { rows } = await pool.query(
      `SELECT blob_path FROM crm_email_attachments
       WHERE gmail_message_id = $1 AND direction = 'sent' AND filename = $2 AND tenant_id = $3
       LIMIT 1`,
      [messageId, filename, req.tenantId],
    );
    if (!rows.length || !rows[0].blob_path) {
      return res.status(404).json({ error: "Załącznik niedostępny." });
    }
    const sasUrl = await storageService.generateSasUrl(rows[0].blob_path, 10);
    return res.redirect(302, sasUrl);
  } catch (err) {
    res.status(500).json({ error: "Błąd pobierania załącznika: " + err.message });
  }
});

router.get("/attachment/:messageId/:attachmentId", requireAuth, crmAuth, async (req, res) => {
  const { messageId, attachmentId } = req.params;
  const filename = String(req.query.filename || "attachment").replace(/[^a-zA-Z0-9._\- ]/g, "_");
  const mimeType = String(req.query.mime    || "application/octet-stream");

  try {
    const { rows } = await pool.query(
      `SELECT blob_path, filename, mime_type, mailbox_user_id
       FROM crm_email_attachments
       WHERE gmail_message_id = $1 AND gmail_attachment_id = $2 AND tenant_id = $3
       LIMIT 1`,
      [messageId, attachmentId, req.tenantId],
    );

    if (rows.length && rows[0].blob_path) {
      const sasUrl = await storageService.generateSasUrl(rows[0].blob_path, 10);
      return res.redirect(302, sasUrl);
    }

    if (!rows.length || !rows[0].mailbox_user_id) {
      return res.status(404).json({ error: "Załącznik niedostępny — nieznany właściciel skrzynki." });
    }
    const buffer = await outlookService.getAttachmentBuffer(rows[0].mailbox_user_id, messageId, attachmentId);

    const safeFilename = filename.replace(/\s+/g, "_");
    const blobPath     = `crm-attachments/${new Date().toISOString().slice(0, 10)}-${uuidv4().slice(0, 8)}-${safeFilename}`;
    storageService.uploadBuffer(blobPath, buffer, mimeType)
      .then(() => pool.query(
        `UPDATE crm_email_attachments
         SET blob_path = $1
         WHERE gmail_message_id = $2 AND gmail_attachment_id = $3 AND tenant_id = $4`,
        [blobPath, messageId, attachmentId, req.tenantId],
      ))
      .catch((e) => console.warn("[Outlook] Attachment blob cache failed:", e.message));

    res.set("Content-Type",        mimeType);
    res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.set("Content-Length",      buffer.length);
    return res.send(buffer);

  } catch (err) {
    console.error("[Outlook] getAttachment error:", err.message);
    if (err.message?.includes("Brak połączonego konta")) {
      return res.status(404).json({
        error: "Załącznik niedostępny — konto właściciela skrzynki zostało rozłączone.",
      });
    }
    res.status(500).json({ error: "Błąd pobierania załącznika: " + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG — ręczne wyzwolenie sprawdzenia nowej poczty (bez czekania na poller)
// POST /api/crm/outlook/debug/process
// ═══════════════════════════════════════════════════════════════════════════════

async function debugProcessHandler(req, res) {
  try {
    const { rows } = await pool.query(
      "SELECT email, delta_link FROM user_outlook_tokens WHERE user_id = $1",
      [req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: "Brak podłączonego konta Outlook" });

    const { email, delta_link } = rows[0];
    const note = !delta_link
      ? "delta_link był pusty — ustawiono bazowy punkt. Wyślij do siebie email i kliknij ponownie."
      : null;

    const result = await outlookProcessor.processUserNotifications(req.user.id);

    res.json({
      ok: true,
      email,
      note,
      deltaLink_initialized: !delta_link,
      newMessages_found: result?.processed ?? 0,
    });
  } catch (err) {
    console.error("[Outlook] debug/process error:", err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
}
router.post("/debug/process", requireAuth, crmAuth, outlookGate, debugProcessHandler);

// Handlers reused by the unified /api/crm/email dispatcher (crm-email.js) so
// dispatching to "whichever provider is active" never duplicates this logic.
// oauthUrl/status/disconnect act on req.user's own mailbox — same auth as
// every other handler here, no superadmin requirement.
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
