"use strict";
// src/routes/crm-gmail.js

const express         = require("express");
const router          = express.Router();
const { pool }        = require("../config/database");
const { requireAuth }  = require("../middleware/auth");
const { crmAuth }     = require("../middleware/crm-rbac");
const gmailService    = require("../services/gmailService");
const storageService  = require("../services/storageService");
const config          = require("../config");
const { v4: uuidv4 }  = require("uuid");
const {
  autoSaveLeadContacts,
  autoSavePartnerContacts,
  storeAttachment,
} = require("../services/gmailProcessor");
const { isTrainingMode } = require("../utils/trainingMode");
const { requireActiveEmailProvider, resolveProviderGate } = require("../middleware/email-provider");

// Guards connect/send/sync actions — blocks them unless this tenant's active
// provider is 'gmail' (bypassed automatically for crm_training_mode tenants).
const gmailGate = requireActiveEmailProvider("gmail");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves partner by UUID (crm_partners.id) or integer (dwh_partner_id).
// Returns { id: uuid, company } or null.
async function resolvePartner(rawId, tenantId, dwhPrefix = 'crmtree_gold') {
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
  if (rows.length) return rows[0];
  // Not in crm_partners yet — lazy-create from DWH
  const dm = await pool.query(
    `SELECT COALESCE(NULLIF(trim(company_name),''), NULLIF(trim(name),''), partner_id::text) AS company
     FROM dwh.${dwhPrefix}_partner WHERE partner_id = $1`, [num]
  );
  if (!dm.rows.length) return null;
  const ins = await pool.query(
    `INSERT INTO crm_partners (company, dwh_partner_id, status, onboarding_step, created_at, updated_at, tenant_id)
     VALUES ($1, $2, 'active', 3, now(), now(), $3)
     ON CONFLICT (dwh_partner_id) DO UPDATE SET updated_at = now()
     RETURNING id, company`,
    [dm.rows[0].company, num, tenantId]
  );
  return ins.rows[0] ?? null;
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
  console.warn("[Gmail] multer niedostępny — wysyłka bez załączników. Uruchom: npm install multer");
}

// ── Helpers (lokalnie — rejestracja ref. załączników bez pobierania treści) ────

/**
 * Zapisuje metadane załączników do crm_email_attachments bez pobierania treści (blob_path = NULL).
 * Wywołana przy pobieraniu wątku — umożliwia późniejsze pobranie.
 */
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

// Each CRM user connects their own Gmail account — triggered inline from
// "Nowy e-mail" (see crm-email.js dispatcher), not from a superadmin panel.
// The tenant only chooses/configures WHICH provider is active; the mailbox
// itself always belongs to req.user, never to the tenant as a whole.
async function oauthUrlHandler(req, res, next) {
  try {
    const gate = await resolveProviderGate(req.tenantId, "gmail");
    if (!gate.ok) {
      return res.status(gate.active ? 403 : 400).json({
        error: gate.active
          ? `Ta organizacja korzysta z innego dostawcy poczty (${gate.active}).`
          : "Gmail nie jest aktywnym providerem dla tego tenanta.",
        code: "PROVIDER_NOT_ACTIVE",
      });
    }
    const url = await gmailService.getAuthUrl(req.user.id, req.tenantId);
    res.json({ url });
  } catch (err) { next(err); }
}
router.get("/oauth/url", requireAuth, crmAuth, oauthUrlHandler);

// Brak requireAuth — Google redirectuje przeglądarkę bez headera Authorization.
// userId jest bezpiecznie zakodowany w parametrze `state` wygenerowanym przez /oauth/url.
router.get("/oauth/callback", async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=error&reason=${encodeURIComponent(error)}`);
    if (!code)  return res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=error&reason=no_code`);
    if (!state) return res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=error&reason=missing_state`);

    const userId = gmailService.parseOAuthState(state);
    if (!userId) {
      console.error("[Gmail] OAuth callback: invalid_state, raw state=", state);
      return res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=error&reason=invalid_state`);
    }

    const { rows: uRows } = await pool.query("SELECT tenant_id FROM users WHERE id = $1", [userId]);
    const tenantId = uRows[0]?.tenant_id ?? null;
    const gate = await resolveProviderGate(tenantId, "gmail");
    if (!gate.ok) {
      return res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=error&reason=provider_not_active`);
    }

    console.log("[Gmail] OAuth callback: state OK, userId=", userId);
    await gmailService.exchangeCodeAndSave(code, userId);
    console.log("[Gmail] OAuth callback: tokens saved for userId=", userId);

    // Zarejestruj Pub/Sub watch — połączenie skrzynki ma się udać nawet jeśli
    // to się nie powiedzie (np. niekompletna konfiguracja pubsub_topic dla
    // tenanta), ale błąd musi być widoczny w logach, nie połykany po cichu.
    try {
      await gmailService.registerWatch(userId);
    } catch (err) {
      console.warn("[Gmail] registerWatch po OAuth callback nie powiódł się:", err.message);
    }

    res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=connected`);
  } catch (err) {
    console.error("[Gmail] OAuth callback error:", err.message, err.stack);
    if (err.code === "MAILBOX_ALREADY_CONNECTED") {
      return res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=error&reason=email_already_connected`);
    }
    res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=error&reason=callback_failed`);
  }
});

async function statusHandler(req, res) {
  try {
    const status = await gmailService.getStatus(req.user.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
}
router.get("/status", requireAuth, crmAuth, statusHandler);

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE PICKER
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/crm/gmail/drive-config — zwraca API key + clientId dla Pickera (browser-side)
router.get("/drive-config", requireAuth, (req, res) => {
  const { clientId, apiKey } = config.google;
  if (!apiKey || !clientId) {
    return res.status(503).json({ error: "Drive Picker nie jest skonfigurowany (brak GOOGLE_API_KEY)" });
  }
  // appId = numeryczny prefix clientId (przed myślnikiem)
  const appId = clientId.split("-")[0];
  res.json({ apiKey, clientId, appId });
});

// GET /api/crm/gmail/drive-token — zwraca świeży access_token; wykrywa brak scope drive.readonly
router.get("/drive-token", requireAuth, async (req, res) => {
  try {
    const oauth2 = await gmailService.getAuthForUser(req.user.id);
    const { token } = await oauth2.getAccessToken();

    // Sprawdź scope przez tokeninfo — nie wymaga włączonego Drive API
    const infoRes  = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
    const infoJson = await infoRes.json();
    const scopes   = (infoJson.scope || '').split(' ');
    const hasDrive = scopes.some(s => s.includes('drive'));

    if (!hasDrive) return res.json({ needsReauth: true });

    res.json({ access_token: token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Mapowanie Google Workspace → format eksportu (PDF jako domyślny dla maili)
const GAPPS_EXPORT = {
  "application/vnd.google-apps.document":     { mime: "application/pdf", ext: ".pdf" },
  "application/vnd.google-apps.spreadsheet":  { mime: "application/pdf", ext: ".pdf" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: ".pdf" },
  "application/vnd.google-apps.drawing":      { mime: "application/pdf", ext: ".pdf" },
};

// GET /api/crm/gmail/drive/file/:fileId — proxy pobierania pliku z Drive
router.get("/drive/file/:fileId", requireAuth, async (req, res) => {
  try {
    const { google: googleapis } = require("googleapis");
    const oauth2 = await gmailService.getAuthForUser(req.user.id);
    const drive  = googleapis.drive({ version: "v3", auth: oauth2 });

    // Pobierz metadane
    const meta = await drive.files.get({
      fileId: req.params.fileId,
      fields: "name,mimeType",
      supportsAllDrives: true,
    });

    const srcMime  = meta.data.mimeType || "application/octet-stream";
    const baseName = meta.data.name     || "plik";
    const exportCfg = GAPPS_EXPORT[srcMime];

    let fileStream, outMime, filename;

    if (exportCfg) {
      // Plik Google Workspace — eksportuj do PDF
      const expRes = await drive.files.export(
        { fileId: req.params.fileId, mimeType: exportCfg.mime },
        { responseType: "stream" }
      );
      fileStream = expRes.data;
      outMime    = exportCfg.mime;
      filename   = baseName.endsWith(exportCfg.ext) ? baseName : baseName + exportCfg.ext;
    } else {
      // Zwykły plik — pobierz binarnie
      const dlRes = await drive.files.get(
        { fileId: req.params.fileId, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
      );
      fileStream = dlRes.data;
      outMime    = srcMime;
      filename   = baseName;
    }

    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Type", outMime);
    fileStream.pipe(res);
  } catch (err) {
    const status = err.code || err.status;
    const msg    = err.errors?.[0]?.message || err.message || "Nieznany błąd";
    console.error(`[Drive] download error (${status}):`, msg);
    res.status(500).json({ error: `Nie udało się pobrać pliku z Google Drive: ${msg}` });
  }
});

async function disconnectHandler(req, res) {
  try {
    await gmailService.disconnect(req.user.id);
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
    // owns it — Gmail threads are scoped to one Google account and cannot be
    // continued from another user's connected mailbox.
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

      const sent = await gmailService.sendEmail({
        userId:      req.user.id,
        to, cc: cc || null, subject,
        body:        body || "",
        threadId:    threadId   || null,
        inReplyTo:   inReplyTo  || null,
        references:  references || null,
        attachments: attachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
      });
      messageId    = sent.messageId;
      sentThreadId = sent.threadId;

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
        }).catch((e) => console.warn("[Gmail] Sent attachment blob save failed:", e.message));
      }
    }

    // Zapisz aktywność (mailbox_user_id = created_by: nadawca jest zawsze
    // właścicielem skrzynki dla wiadomości wychodzącej)
    const actR = await pool.query(
      `INSERT INTO crm_lead_activities
         (lead_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id, created_by, mailbox_user_id, is_read, tenant_id)
       VALUES ($1, 'email', $2, $3, NOW(), $4, $5, $6, $6, true, $7)
       RETURNING id`,
      [leadId, subject, body || null, sentThreadId, messageId, req.user.id, req.tenantId],
    );

    // Auto-zapis TYLKO odbiorców To (nie CC) do kontaktów leada
    // CC celowo pomijane — może zawierać wewnętrznych pracowników lub osoby trzecie
    const toRecipients = String(to).split(",").map((s) => s.trim()).filter(Boolean);
    await autoSaveLeadContacts(leadId, toRecipients, req.tenantId);

    if (training) {
      scheduleTrainingReplyLead(leadId, subject, sentThreadId, req.user.id, req.tenantId);
    }

    res.json({ messageId, threadId: sentThreadId, activityId: actR.rows[0].id });
  } catch (err) {
    console.error("[Gmail] send/lead error:", err.message);
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
  router.post("/send/lead/:leadId", requireAuth, crmAuth, gmailGate, upload.array("attachments", 10), sendLeadHandler);
} else {
  router.post("/send/lead/:leadId", requireAuth, crmAuth, gmailGate, sendLeadHandler);
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

    const partner = await resolvePartner(req.params.partnerId, req.tenantId, req.dwhPrefix);
    if (!partner) return res.status(404).json({ error: "Partner nie znaleziony" });
    const crmPartnerId = partner.id;

    // A reply within an existing thread must go out from the mailbox that
    // owns it — Gmail threads are scoped to one Google account and cannot be
    // continued from another user's connected mailbox.
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

      const sent = await gmailService.sendEmail({
        userId:      req.user.id,
        to, cc: cc || null, subject,
        body:        body || "",
        threadId:    threadId   || null,
        inReplyTo:   inReplyTo  || null,
        references:  references || null,
        attachments: attachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
      });
      messageId    = sent.messageId;
      sentThreadId = sent.threadId;

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
        }).catch((e) => console.warn("[Gmail] Sent attachment blob save failed:", e.message));
      }
    }

    const actR = await pool.query(
      `INSERT INTO crm_partner_activities
         (partner_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id, created_by, mailbox_user_id, is_read, tenant_id)
       VALUES ($1, 'email', $2, $3, NOW(), $4, $5, $6, $6, true, $7)
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
    console.error("[Gmail] send/partner error:", err.message);
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
  router.post("/send/partner/:partnerId", requireAuth, crmAuth, gmailGate, upload.array("attachments", 10), sendPartnerHandler);
} else {
  router.post("/send/partner/:partnerId", requireAuth, crmAuth, gmailGate, sendPartnerHandler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POBIERANIE WĄTKÓW (z rejestracją załączników w DB)
// ═══════════════════════════════════════════════════════════════════════════════

async function threadLeadHandler(req, res) {
  try {
    const leadId = parseInt(req.params.leadId);

    // Gmail threads live in one Google account — read with the token of
    // whichever user's mailbox owns this thread, not the current viewer's.
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

    const messages = await gmailService.getThread(ownerId, req.params.threadId);

    for (const msg of messages) {
      if (msg.attachments?.length) {
        registerAttachmentRefs({ leadId, messageId: msg.id, attachments: msg.attachments, tenantId: req.tenantId, mailboxUserId: ownerId }).catch(() => {});
      }
    }

    const msgIds = messages.map(m => m.id);
    if (msgIds.length) {
      // Wiadomości wychodzące — mają wiersz w crm_lead_activities (created_by != NULL)
      const { rows: outRows } = await pool.query(
        `SELECT id AS activity_id, gmail_message_id FROM crm_lead_activities
         WHERE lead_id = $1 AND gmail_message_id = ANY($2) AND tenant_id = $3`,
        [leadId, msgIds, req.tenantId],
      );
      const outIds = new Set(outRows.map(r => r.gmail_message_id));

      // Wiadomości przychodzące — oznacz istniejące rekordy jako przeczytane.
      // Tylko UPDATE, nie INSERT — INSERT jest wyłącznie odpowiedzialnością processNotification.
      // Gdybyśmy tu insertowali, processNotification uznałby wiadomość za "już przetworzoną" i nie
      // ustawiłby is_read=false → badge nigdy by nie pokazał.
      const incomingIds = msgIds.filter(id => !outIds.has(id));
      if (incomingIds.length) {
        pool.query(
          `UPDATE crm_email_message_reads SET is_read = true, updated_at = NOW()
           WHERE gmail_message_id = ANY($1) AND tenant_id = $2`,
          [incomingIds, req.tenantId],
        ).catch(e => console.warn("[Gmail] auto-mark read failed:", e.message));
        // Oznacz aktywność wątku jako przeczytaną (jeśli była nieprzeczytana)
        pool.query(
          `UPDATE crm_lead_activities SET is_read = true, updated_at = NOW()
           WHERE lead_id = $1 AND gmail_thread_id = $2 AND type = 'email' AND is_read = false AND tenant_id = $3`,
          [leadId, req.params.threadId, req.tenantId],
        ).catch(e => console.warn("[Gmail] mark thread activity read failed:", e.message));
      }

      // Pobierz aktualny stan is_read z bazy (po UPDATE powyżej)
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
          // Jeśli nie ma wiersza w crm_email_message_reads — wiadomość nie była jeszcze
          // przetworzona przez processNotification, traktujemy jako nieprzeczytaną wizualnie.
          msg.is_read    = readMap[msg.id] ?? false;
          msg.created_by = null;
          msg.activity_id = null;
        }
      }

      // Dołącz wysłane załączniki z bazy (direction='sent')
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
    console.error("[Gmail] getThread/lead error:", err.message);
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
    const resolved  = await resolvePartner(req.params.partnerId, req.tenantId, req.dwhPrefix);
    const partnerId = resolved?.id ?? req.params.partnerId;

    // Gmail threads live in one Google account — read with the token of
    // whichever user's mailbox owns this thread, not the current viewer's.
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

    const messages = await gmailService.getThread(ownerId, req.params.threadId);

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

      // Wiadomości przychodzące — tylko UPDATE istniejących rekordów (nie INSERT).
      const incomingIds = msgIds.filter(id => !outIds.has(id));
      if (incomingIds.length) {
        pool.query(
          `UPDATE crm_email_message_reads SET is_read = true, updated_at = NOW()
           WHERE gmail_message_id = ANY($1) AND tenant_id = $2`,
          [incomingIds, req.tenantId],
        ).catch(e => console.warn("[Gmail] auto-mark read failed:", e.message));
        pool.query(
          `UPDATE crm_partner_activities SET is_read = true, updated_at = NOW()
           WHERE partner_id = $1 AND gmail_thread_id = $2 AND type = 'email' AND is_read = false AND tenant_id = $3`,
          [partnerId, req.params.threadId, req.tenantId],
        ).catch(e => console.warn("[Gmail] mark partner thread activity read failed:", e.message));
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
    console.error("[Gmail] getThread/partner error:", err.message);
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
// STAN PRZECZYTANIA — poziom pojedynczej wiadomości Gmail
// ═══════════════════════════════════════════════════════════════════════════════

router.patch('/messages/:msgId/read', requireAuth, crmAuth, async (req, res) => {
  try {
    const { msgId } = req.params;
    const isRead = req.body.is_read !== undefined ? !!req.body.is_read : true;
    await pool.query(
      `INSERT INTO crm_email_message_reads (gmail_message_id, is_read, updated_at, tenant_id)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (gmail_message_id) DO UPDATE SET is_read = $2, updated_at = NOW()`,
      [msgId, isRead, req.tenantId],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[Gmail] patch message read error:', err.message);
    res.status(500).json({ error: 'Błąd aktualizacji stanu przeczytania' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POBIERANIE ZAŁĄCZNIKA
// Serwuje z Azure Blob (trwałe), lub pobiera z Gmail API i zapisuje do Blob.
// Działa nawet po rozłączeniu konta Gmail — o ile blob_path jest wypełniony.
// ═══════════════════════════════════════════════════════════════════════════════

// Serwuje wysłany załącznik z Azure Blob (direction='sent', identified by messageId + filename)
router.get("/sent-attachment/:messageId", requireAuth, crmAuth, async (req, res) => {
  const { messageId } = req.params;
  const filename = String(req.query.filename || "attachment").replace(/[^a-zA-Z0-9._\- ]/g, "_");
  const mimeType = String(req.query.mime    || "application/octet-stream");
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
    // 1. Sprawdź czy mamy blobPath w DB
    const { rows } = await pool.query(
      `SELECT blob_path, filename, mime_type, mailbox_user_id
       FROM crm_email_attachments
       WHERE gmail_message_id = $1 AND gmail_attachment_id = $2 AND tenant_id = $3
       LIMIT 1`,
      [messageId, attachmentId, req.tenantId],
    );

    if (rows.length && rows[0].blob_path) {
      // Serwuj przez SAS URL (redirect) — przeglądarka pobiera bezpośrednio z Azure
      const sasUrl = await storageService.generateSasUrl(rows[0].blob_path, 10);
      return res.redirect(302, sasUrl);
    }

    // 2. Nie ma w Blob — pobierz z Gmail API tokenem właściciela skrzynki,
    // do której należy ta wiadomość (nie bieżącego widza).
    if (!rows.length || !rows[0].mailbox_user_id) {
      return res.status(404).json({ error: "Załącznik niedostępny — nieznany właściciel skrzynki." });
    }
    const buffer = await gmailService.getAttachmentBuffer(rows[0].mailbox_user_id, messageId, attachmentId);

    // 3. Zapisz do Blob asynchronicznie, żeby następne pobranie było z Blob
    const safeFilename = filename.replace(/\s+/g, "_");
    const blobPath     = `crm-attachments/${new Date().toISOString().slice(0, 10)}-${uuidv4().slice(0, 8)}-${safeFilename}`;
    storageService.uploadBuffer(blobPath, buffer, mimeType)
      .then(() => pool.query(
        `UPDATE crm_email_attachments
         SET blob_path = $1
         WHERE gmail_message_id = $2 AND gmail_attachment_id = $3 AND tenant_id = $4`,
        [blobPath, messageId, attachmentId, req.tenantId],
      ))
      .catch((e) => console.warn("[Gmail] Attachment blob cache failed:", e.message));

    // 4. Wyślij do klienta
    res.set("Content-Type",        mimeType);
    res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.set("Content-Length",      buffer.length);
    return res.send(buffer);

  } catch (err) {
    console.error("[Gmail] getAttachment error:", err.message);
    if (err.message?.includes("Brak połączonego konta")) {
      return res.status(404).json({
        error: "Załącznik niedostępny — konto właściciela skrzynki zostało rozłączone.",
      });
    }
    res.status(500).json({ error: "Błąd pobierania załącznika: " + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WATCH — rejestracja/odświeżenie powiadomień Gmail (topic Pub/Sub)
// Auto-import emaili obsługuje pubsubPoller (pull), nie webhook.
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/webhook/register", requireAuth, gmailGate, async (req, res) => {
  try {
    const result = await gmailService.registerWatch(req.user.id);
    if (!result) return res.status(503).json({ error: "GOOGLE_PUBSUB_TOPIC nie jest skonfigurowany" });
    res.json({ ok: true, historyId: result.historyId, expiration: result.expiration });
  } catch (err) {
    console.error("[Gmail] registerWatch error:", err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG — ręczne wyzwolenie przetwarzania historii Gmail (tylko admin/dev)
// POST /api/crm/gmail/debug/process
// Pozwala przetestować processNotification bez Pub/Sub.
// ═══════════════════════════════════════════════════════════════════════════════

async function debugProcessHandler(req, res) {
  try {
    const { processNotification } = require("../services/gmailProcessor");

    // Pobierz token skrzynki bieżącego usera
    const { rows } = await pool.query(
      "SELECT email, history_id FROM user_gmail_tokens WHERE user_id = $1",
      [req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: "Brak podłączonego konta Gmail" });

    let { email, history_id } = rows[0];

    // Jeśli history_id nie ustawiony — pobierz bieżący historyId z Gmail API i zapisz
    if (!history_id) {
      history_id = await gmailService.getCurrentHistoryId(req.user.id);
      await pool.query(
        "UPDATE user_gmail_tokens SET history_id = $1 WHERE user_id = $2",
        [history_id, req.user.id],
      );
      const { rows: readRows } = await pool.query("SELECT * FROM crm_email_message_reads ORDER BY updated_at DESC LIMIT 10");
      return res.json({
        ok: true,
        email,
        note: "history_id był pusty — ustawiono bieżący historyId. Wyślij odpowiedź na email i kliknij ponownie.",
        historyId_after:   history_id,
        newMessages_found: 0,
        messageIds_found:  [],
        recent_message_reads: readRows,
      });
    }

    // processNotification handles getNewMessages, historyId update, recovery and dedup internally
    const result = await processNotification(email, history_id);

    // Stan po przetworzeniu
    const { rows: after } = await pool.query(
      "SELECT history_id FROM user_gmail_tokens WHERE user_id = $1",
      [req.user.id],
    );
    const { rows: readRows } = await pool.query(
      "SELECT * FROM crm_email_message_reads ORDER BY updated_at DESC LIMIT 10",
    );

    res.json({
      ok:                true,
      email,
      recovered:         result?.recovered      || false,
      historyId_before:  history_id,
      historyId_after:   after[0]?.history_id,
      newMessages_found: result?.recovered ? (result.recoveredCount ?? 0) : (result.processed ?? 0),
      messageIds_found:  [],
      recent_message_reads: readRows,
    });
  } catch (err) {
    console.error("[Gmail] debug/process error:", err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
}
router.post("/debug/process", requireAuth, crmAuth, gmailGate, debugProcessHandler);

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
