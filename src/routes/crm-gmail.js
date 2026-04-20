"use strict";
// src/routes/crm-gmail.js

const express         = require("express");
const router          = express.Router();
const { pool }        = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const { crmAuth }     = require("../middleware/crm-rbac");
const gmailService    = require("../services/gmailService");
const storageService  = require("../services/storageService");
const config          = require("../config");
const { v4: uuidv4 }  = require("uuid");

// multer — do załączników w wysyłce
let upload = null;
try {
  const multer = require("multer");
  upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
} catch (_) {
  console.warn("[Gmail] multer niedostępny — wysyłka bez załączników. Uruchom: npm install multer");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parsuje nagłówek "Name <email>" lub "email" i zwraca { name, email }.
 */
function parseEmailHeader(header) {
  const str = String(header || "").trim();
  const m   = str.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) {
    return { name: m[1].trim().replace(/^["']|["']$/g, ""), email: m[2].trim().toLowerCase() };
  }
  return { name: "", email: str.toLowerCase() };
}

/**
 * Zapisuje adresy email z nagłówków do crm_lead_contacts (jeśli jeszcze nie istnieją).
 * Nie rzuca — błędy są logowane i ignorowane.
 */
async function autoSaveLeadContacts(leadId, emailHeaders) {
  for (const header of emailHeaders) {
    const { name, email } = parseEmailHeader(header);
    if (!email || !email.includes("@")) continue;
    // Nie zapisuj adresów @worktrips.com (wewnętrznych)
    if (email.toLowerCase().endsWith("@worktrips.com")) continue;
    try {
      // Sprawdź czy już istnieje (email główny leada lub w extra_contacts)
      const [mainQ, extraQ] = await Promise.all([
        pool.query("SELECT id FROM crm_leads WHERE id = $1 AND LOWER(email) = $2", [leadId, email]),
        pool.query("SELECT id FROM crm_lead_contacts WHERE lead_id = $1 AND LOWER(email) = $2", [leadId, email]),
      ]);
      if (mainQ.rows.length || extraQ.rows.length) continue;

      await pool.query(
        "INSERT INTO crm_lead_contacts (lead_id, contact_name, email) VALUES ($1, $2, $3)",
        [leadId, name || email, email],
      );
    } catch (e) {
      console.warn("[Gmail] autoSaveLeadContacts error:", e.message);
    }
  }
}

async function autoSavePartnerContacts(partnerId, emailHeaders) {
  for (const header of emailHeaders) {
    const { name, email } = parseEmailHeader(header);
    if (!email || !email.includes("@")) continue;
    // Nie zapisuj adresów @worktrips.com (wewnętrznych)
    if (email.toLowerCase().endsWith("@worktrips.com")) continue;
    try {
      const [mainQ, extraQ] = await Promise.all([
        pool.query("SELECT id FROM crm_partners WHERE id = $1 AND LOWER(email) = $2", [partnerId, email]),
        pool.query("SELECT id FROM crm_partner_contacts WHERE partner_id = $1 AND LOWER(email) = $2", [partnerId, email]),
      ]);
      if (mainQ.rows.length || extraQ.rows.length) continue;
      await pool.query(
        `INSERT INTO crm_partner_contacts (partner_id, contact_name, email) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [partnerId, name || email, email],
      );
    } catch (e) {
      console.warn("[Gmail] autoSavePartnerContacts error:", e.message);
    }
  }
}

/**
 * Zapisuje załącznik do Azure Blob i aktualizuje/wstawia rekord w crm_email_attachments.
 */
async function storeAttachment({ leadId, partnerId, messageId, attachmentId, filename, mimeType, buffer, direction }) {
  const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobPath     = `crm-attachments/${new Date().toISOString().slice(0, 10)}-${uuidv4().slice(0, 8)}-${safeFilename}`;

  await storageService.uploadBuffer(blobPath, buffer, mimeType || "application/octet-stream");

  const idCol = leadId ? "lead_id" : "partner_id";
  const idVal = leadId || partnerId;

  // Upsert — jeśli rekord z tym message_id + attachment_id już istnieje, zaktualizuj blob_path
  await pool.query(
    `INSERT INTO crm_email_attachments
       (${idCol}, gmail_message_id, gmail_attachment_id, filename, mime_type, blob_path, file_size, direction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [idVal, messageId, attachmentId || null, filename, mimeType || "application/octet-stream", blobPath, buffer.length, direction || "received"],
  );
  return blobPath;
}

/**
 * Zapisuje metadane załączników do crm_email_attachments bez pobierania treści (blob_path = NULL).
 * Wywołana przy pobieraniu wątku — umożliwia późniejsze pobranie.
 */
async function registerAttachmentRefs({ leadId, partnerId, messageId, attachments }) {
  const idCol = leadId ? "lead_id" : "partner_id";
  const idVal = leadId || partnerId;
  for (const att of attachments || []) {
    try {
      await pool.query(
        `INSERT INTO crm_email_attachments
           (${idCol}, gmail_message_id, gmail_attachment_id, filename, mime_type, direction)
         VALUES ($1, $2, $3, $4, $5, 'received')
         ON CONFLICT DO NOTHING`,
        [idVal, messageId, att.attachmentId, att.filename, att.mimeType || "application/octet-stream"],
      );
    } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OAUTH2
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/oauth/url", requireAuth, (req, res) => {
  if (!config.google.clientId || !config.google.clientSecret) {
    return res.status(503).json({ error: "Gmail OAuth nie jest skonfigurowany (brak GOOGLE_CLIENT_ID/SECRET)" });
  }
  // userId zakodowany w state — callback nie potrzebuje JWT
  const url = gmailService.getAuthUrl(req.user.id);
  res.json({ url });
});

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

    console.log("[Gmail] OAuth callback: state OK, userId=", userId);
    await gmailService.exchangeCodeAndSave(code, userId);
    console.log("[Gmail] OAuth callback: tokens saved for userId=", userId);

    // Zarejestruj Pub/Sub watch (ignoruj błąd jeśli brak konfiguracji)
    try { await gmailService.registerWatch(userId); } catch (_) {}

    res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=connected`);
  } catch (err) {
    console.error("[Gmail] OAuth callback error:", err.message, err.stack);
    res.redirect(`${config.frontendUrl}/crm/gmail/callback?status=error&reason=callback_failed`);
  }
});

router.get("/status", requireAuth, async (req, res) => {
  try {
    const status = await gmailService.getStatus(req.user.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.delete("/oauth/disconnect", requireAuth, async (req, res) => {
  try {
    await gmailService.disconnect(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

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

    const leadQ = await pool.query("SELECT id, company FROM crm_leads WHERE id = $1", [leadId]);
    if (!leadQ.rows.length) return res.status(404).json({ error: "Lead nie znaleziony" });

    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname,
      mimeType: f.mimetype,
      data:     f.buffer.toString("base64"),
      _buffer:  f.buffer,  // zachowaj Buffer do zapisu w blob
    }));

    const { messageId, threadId: sentThreadId } = await gmailService.sendEmail({
      userId:      req.user.id,
      to, cc: cc || null, subject,
      body:        body || "",
      threadId:    threadId   || null,
      inReplyTo:   inReplyTo  || null,
      references:  references || null,
      attachments: attachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
    });

    // Zapisz aktywność
    const actR = await pool.query(
      `INSERT INTO crm_lead_activities
         (lead_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id, created_by)
       VALUES ($1, 'email', $2, $3, NOW(), $4, $5, $6)
       RETURNING id`,
      [leadId, subject, body || null, sentThreadId, messageId, req.user.id],
    );

    // Zapisz wysłane załączniki do Blob (asynchronicznie — nie blokuj odpowiedzi)
    for (const att of attachments) {
      storeAttachment({
        leadId,
        messageId,
        attachmentId: null,   // wysłane attachmenty nie mają Gmail attachmentId
        filename:     att.filename,
        mimeType:     att.mimeType,
        buffer:       att._buffer,
        direction:    "sent",
      }).catch((e) => console.warn("[Gmail] Sent attachment blob save failed:", e.message));
    }

    // Auto-zapis odbiorców (To + CC) do extra_contacts leada
    const allRecipients = [
      ...String(to).split(",").map((s) => s.trim()).filter(Boolean),
      ...(cc ? String(cc).split(",").map((s) => s.trim()).filter(Boolean) : []),
    ];
    autoSaveLeadContacts(leadId, allRecipients).catch(() => {});

    res.json({ messageId, threadId: sentThreadId, activityId: actR.rows[0].id });
  } catch (err) {
    console.error("[Gmail] send/lead error:", err.message);
    if (err.message?.includes("Brak połączonego konta")) {
      return res.status(401).json({ error: err.message });
    }
    res.status(500).json({ error: "Błąd wysyłki emaila: " + err.message });
  }
}

if (upload) {
  router.post("/send/lead/:leadId", requireAuth, crmAuth, upload.array("attachments", 10), sendLeadHandler);
} else {
  router.post("/send/lead/:leadId", requireAuth, crmAuth, sendLeadHandler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WYSYŁKA — PARTNER
// ═══════════════════════════════════════════════════════════════════════════════

async function sendPartnerHandler(req, res) {
  try {
    const partnerId = parseInt(req.params.partnerId);
    const { to, cc, subject, body, threadId, inReplyTo, references } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: "Pola 'to' i 'subject' są wymagane" });
    }

    const partnerQ = await pool.query("SELECT id, company FROM crm_partners WHERE id = $1", [partnerId]);
    if (!partnerQ.rows.length) return res.status(404).json({ error: "Partner nie znaleziony" });

    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname,
      mimeType: f.mimetype,
      data:     f.buffer.toString("base64"),
      _buffer:  f.buffer,
    }));

    const { messageId, threadId: sentThreadId } = await gmailService.sendEmail({
      userId:      req.user.id,
      to, cc: cc || null, subject,
      body:        body || "",
      threadId:    threadId   || null,
      inReplyTo:   inReplyTo  || null,
      references:  references || null,
      attachments: attachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
    });

    const actR = await pool.query(
      `INSERT INTO crm_partner_activities
         (partner_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id, created_by)
       VALUES ($1, 'email', $2, $3, NOW(), $4, $5, $6)
       RETURNING id`,
      [partnerId, subject, body || null, sentThreadId, messageId, req.user.id],
    );

    for (const att of attachments) {
      storeAttachment({
        partnerId,
        messageId,
        attachmentId: null,
        filename:     att.filename,
        mimeType:     att.mimeType,
        buffer:       att._buffer,
        direction:    "sent",
      }).catch((e) => console.warn("[Gmail] Sent attachment blob save failed:", e.message));
    }

    // Auto-zapis odbiorców (To + CC) do kontaktów partnera
    const allRecipients = [
      ...String(to).split(",").map((s) => s.trim()).filter(Boolean),
      ...(cc ? String(cc).split(",").map((s) => s.trim()).filter(Boolean) : []),
    ];
    autoSavePartnerContacts(partnerId, allRecipients).catch(() => {});

    res.json({ messageId, threadId: sentThreadId, activityId: actR.rows[0].id });
  } catch (err) {
    console.error("[Gmail] send/partner error:", err.message);
    if (err.message?.includes("Brak połączonego konta")) {
      return res.status(401).json({ error: err.message });
    }
    res.status(500).json({ error: "Błąd wysyłki emaila: " + err.message });
  }
}

if (upload) {
  router.post("/send/partner/:partnerId", requireAuth, crmAuth, upload.array("attachments", 10), sendPartnerHandler);
} else {
  router.post("/send/partner/:partnerId", requireAuth, crmAuth, sendPartnerHandler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POBIERANIE WĄTKÓW (z rejestracją załączników w DB)
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/thread/lead/:leadId/:threadId", requireAuth, crmAuth, async (req, res) => {
  try {
    const leadId  = parseInt(req.params.leadId);
    const messages = await gmailService.getThread(req.user.id, req.params.threadId);

    for (const msg of messages) {
      if (msg.attachments?.length) {
        registerAttachmentRefs({ leadId, messageId: msg.id, attachments: msg.attachments }).catch(() => {});
      }
    }

    // Dołącz wysłane załączniki z bazy (direction='sent')
    const msgIds = messages.map(m => m.id);
    if (msgIds.length) {
      const { rows: sentAtts } = await pool.query(
        `SELECT gmail_message_id, filename, mime_type, blob_path, gmail_attachment_id
         FROM crm_email_attachments
         WHERE lead_id = $1 AND gmail_message_id = ANY($2) AND direction = 'sent'`,
        [leadId, msgIds],
      );
      for (const msg of messages) {
        msg.sentAttachments = sentAtts
          .filter(a => a.gmail_message_id === msg.id)
          .map(a => ({ filename: a.filename, mimeType: a.mime_type, blobPath: a.blob_path }));
      }
    }

    res.json(messages);
  } catch (err) {
    console.error("[Gmail] getThread/lead error:", err.message);
    res.status(500).json({ error: "Błąd pobierania wątku: " + err.message });
  }
});

router.get("/thread/partner/:partnerId/:threadId", requireAuth, crmAuth, async (req, res) => {
  try {
    const partnerId = parseInt(req.params.partnerId);
    const messages  = await gmailService.getThread(req.user.id, req.params.threadId);

    for (const msg of messages) {
      if (msg.attachments?.length) {
        registerAttachmentRefs({ partnerId, messageId: msg.id, attachments: msg.attachments }).catch(() => {});
      }
    }

    // Dołącz wysłane załączniki z bazy (direction='sent')
    const msgIds = messages.map(m => m.id);
    if (msgIds.length) {
      const { rows: sentAtts } = await pool.query(
        `SELECT gmail_message_id, filename, mime_type, blob_path
         FROM crm_email_attachments
         WHERE partner_id = $1 AND gmail_message_id = ANY($2) AND direction = 'sent'`,
        [partnerId, msgIds],
      );
      for (const msg of messages) {
        msg.sentAttachments = sentAtts
          .filter(a => a.gmail_message_id === msg.id)
          .map(a => ({ filename: a.filename, mimeType: a.mime_type, blobPath: a.blob_path }));
      }
    }

    res.json(messages);
  } catch (err) {
    console.error("[Gmail] getThread/partner error:", err.message);
    res.status(500).json({ error: "Błąd pobierania wątku: " + err.message });
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
       WHERE gmail_message_id = $1 AND direction = 'sent' AND filename = $2
       LIMIT 1`,
      [messageId, filename],
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
      `SELECT blob_path, filename, mime_type
       FROM crm_email_attachments
       WHERE gmail_message_id = $1 AND gmail_attachment_id = $2
       LIMIT 1`,
      [messageId, attachmentId],
    );

    if (rows.length && rows[0].blob_path) {
      // Serwuj przez SAS URL (redirect) — przeglądarka pobiera bezpośrednio z Azure
      const sasUrl = await storageService.generateSasUrl(rows[0].blob_path, 10);
      return res.redirect(302, sasUrl);
    }

    // 2. Nie ma w Blob — pobierz z Gmail API używając tokenu bieżącego usera
    const buffer = await gmailService.getAttachmentBuffer(req.user.id, messageId, attachmentId);

    // 3. Zapisz do Blob asynchronicznie, żeby następne pobranie było z Blob
    const safeFilename = filename.replace(/\s+/g, "_");
    const blobPath     = `crm-attachments/${new Date().toISOString().slice(0, 10)}-${uuidv4().slice(0, 8)}-${safeFilename}`;
    storageService.uploadBuffer(blobPath, buffer, mimeType)
      .then(() => pool.query(
        `UPDATE crm_email_attachments
         SET blob_path = $1
         WHERE gmail_message_id = $2 AND gmail_attachment_id = $3`,
        [blobPath, messageId, attachmentId],
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
        error: "Załącznik niedostępny — konto Gmail niepołączone. Skontaktuj się z administratorem.",
      });
    }
    res.status(500).json({ error: "Błąd pobierania załącznika: " + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUB/SUB WEBHOOK — auto-import przychodzących emaili
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/webhook/pubsub", async (req, res) => {
  // Zawsze odpowiadaj 200 natychmiast — inaczej Pub/Sub będzie ponawiał
  res.sendStatus(200);

  try {
    const message = req.body?.message;
    if (!message?.data) return;

    const decoded = JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
    const { emailAddress, historyId: newHistoryId } = decoded;
    if (!emailAddress || !newHistoryId) return;

    // Znajdź usera po adresie Gmail
    const { rows: userRows } = await pool.query(
      "SELECT user_id, history_id FROM user_gmail_tokens WHERE LOWER(email) = LOWER($1)",
      [emailAddress],
    );
    if (!userRows.length) return;

    const { user_id: userId, history_id: lastHistoryId } = userRows[0];
    if (!lastHistoryId) {
      // Brak punktu odniesienia — zapisz nowy historyId i zakończ
      await pool.query(
        "UPDATE user_gmail_tokens SET history_id = $1 WHERE user_id = $2",
        [String(newHistoryId), userId],
      );
      return;
    }

    // Pobierz nowe wiadomości od ostatniego historyId
    const { messageIds, historyId: fetchedHistoryId } = await gmailService.getNewMessages(userId, lastHistoryId);

    // Zaktualizuj historyId
    await pool.query(
      "UPDATE user_gmail_tokens SET history_id = $1 WHERE user_id = $2",
      [String(fetchedHistoryId || newHistoryId), userId],
    );

    for (const msgId of messageIds) {
      try {
        const msg = await gmailService.getMessage(userId, msgId);

        // Dopasuj wątek do leada lub partnera
        const [leadQ, partnerQ] = await Promise.all([
          pool.query(
            "SELECT lead_id FROM crm_lead_activities WHERE gmail_thread_id = $1 LIMIT 1",
            [msg.threadId],
          ),
          pool.query(
            "SELECT partner_id FROM crm_partner_activities WHERE gmail_thread_id = $1 LIMIT 1",
            [msg.threadId],
          ),
        ]);

        const leadId    = leadQ.rows[0]?.lead_id    || null;
        const partnerId = partnerQ.rows[0]?.partner_id || null;
        if (!leadId && !partnerId) continue; // Nieznany wątek — pomiń

        const actTable = leadId ? "crm_lead_activities"   : "crm_partner_activities";
        const idCol    = leadId ? "lead_id"               : "partner_id";
        const recordId = leadId || partnerId;

        // Sprawdź czy wiadomość już zaimportowana
        const existing = await pool.query(
          `SELECT id FROM ${actTable} WHERE gmail_message_id = $1 LIMIT 1`,
          [msg.id],
        );
        if (existing.rows.length) continue;

        // Utwórz aktywność dla przychodzącego emaila
        const actR = await pool.query(
          `INSERT INTO ${actTable}
             (${idCol}, type, title, body, activity_at, gmail_thread_id, gmail_message_id, created_by)
           VALUES ($1, 'email', $2, $3, $4, $5, $6, NULL)
           RETURNING id`,
          [
            recordId,
            `↩ ${msg.subject || "(bez tematu)"}`,
            msg.body || msg.snippet || null,
            msg.date,
            msg.threadId,
            msg.id,
          ],
        );

        // Pobierz i zapisz załączniki do Blob
        for (const att of msg.attachments || []) {
          try {
            const buffer = await gmailService.getAttachmentBuffer(userId, msg.id, att.attachmentId);
            await storeAttachment({
              leadId:       leadId    || undefined,
              partnerId:    partnerId || undefined,
              messageId:    msg.id,
              attachmentId: att.attachmentId,
              filename:     att.filename,
              mimeType:     att.mimeType,
              buffer,
              direction:    "received",
            });
          } catch (attErr) {
            console.warn("[Gmail] Pub/Sub attachment download failed:", attErr.message);
          }
        }

        // Auto-zapis nadawcy do extra_contacts leada
        if (leadId && msg.from) {
          autoSaveLeadContacts(leadId, [msg.from]).catch(() => {});
        }

      } catch (msgErr) {
        console.error("[Gmail] Pub/Sub message processing error:", msgErr.message);
      }
    }
  } catch (err) {
    console.error("[Gmail] Pub/Sub processing error:", err.message);
  }
});

// Ręczna rejestracja/odświeżenie watch
router.post("/webhook/register", requireAuth, async (req, res) => {
  try {
    const result = await gmailService.registerWatch(req.user.id);
    if (!result) return res.status(503).json({ error: "GOOGLE_PUBSUB_TOPIC nie jest skonfigurowany" });
    res.json({ ok: true, historyId: result.historyId, expiration: result.expiration });
  } catch (err) {
    console.error("[Gmail] registerWatch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
