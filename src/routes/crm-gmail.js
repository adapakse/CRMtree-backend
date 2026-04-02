"use strict";
// src/routes/crm-gmail.js

const express      = require("express");
const router       = express.Router();
const { pool }     = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const { crmAuth }     = require("../middleware/crm-rbac");
const gmailService = require("../services/gmailService");
const config       = require("../config");

// multer — opcjonalny (do załączników). Jeśli nie zainstalowany — działa bez załączników.
let upload = null;
try {
  const multer = require("multer");
  upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
} catch (_) {
  console.warn("[Gmail] multer niedostępny — wysyłka bez załączników. Uruchom: npm install multer");
}

// ═══════════════════════════════════════════════════════════════════════════════
// OAUTH2
// ═══════════════════════════════════════════════════════════════════════════════

// Pobierz URL do autoryzacji Google
router.get("/oauth/url", requireAuth, (req, res) => {
  if (!config.google.clientId || !config.google.clientSecret) {
    return res.status(503).json({ error: "Gmail OAuth nie jest skonfigurowany (brak GOOGLE_CLIENT_ID/SECRET)" });
  }
  const url = gmailService.getAuthUrl();
  res.json({ url });
});

// Callback po autoryzacji Google
router.get("/oauth/callback", requireAuth, async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) return res.redirect(`${config.frontendUrl}/#/settings?gmail=error&reason=${error}`);
    if (!code)  return res.redirect(`${config.frontendUrl}/#/settings?gmail=error&reason=no_code`);

    await gmailService.exchangeCodeAndSave(code, req.user.id);

    // Zarejestruj Pub/Sub watch (ignoruj błąd jeśli brak konfiguracji)
    try { await gmailService.registerWatch(req.user.id); } catch (_) {}

    res.redirect(`${config.frontendUrl}/#/settings?gmail=connected`);
  } catch (err) {
    console.error("[Gmail] OAuth callback error:", err.message);
    res.redirect(`${config.frontendUrl}/#/settings?gmail=error&reason=callback_failed`);
  }
});

// Sprawdź status połączenia
router.get("/status", requireAuth, async (req, res) => {
  try {
    const status = await gmailService.getStatus(req.user.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// Rozłącz konto Gmail
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
    const { to, subject, body, threadId } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: "Pola 'to' i 'subject' są wymagane" });
    }

    const leadQ = await pool.query("SELECT id, company FROM crm_leads WHERE id = $1", [leadId]);
    if (!leadQ.rows.length) return res.status(404).json({ error: "Lead nie znaleziony" });

    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname,
      mimeType: f.mimetype,
      data:     f.buffer.toString("base64"),
    }));

    const { messageId, threadId: sentThreadId } = await gmailService.sendEmail({
      userId:      req.user.id,
      to, subject,
      body:        body || "",
      threadId:    threadId || null,
      attachments,
    });

    const actR = await pool.query(
      `INSERT INTO crm_lead_activities
         (lead_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id, created_by)
       VALUES ($1, 'email', $2, $3, NOW(), $4, $5, $6)
       RETURNING *`,
      [leadId, subject, body || null, sentThreadId, messageId, req.user.id],
    );

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
    const { to, subject, body, threadId } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: "Pola 'to' i 'subject' są wymagane" });
    }

    const partnerQ = await pool.query("SELECT id, company FROM crm_partners WHERE id = $1", [partnerId]);
    if (!partnerQ.rows.length) return res.status(404).json({ error: "Partner nie znaleziony" });

    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname,
      mimeType: f.mimetype,
      data:     f.buffer.toString("base64"),
    }));

    const { messageId, threadId: sentThreadId } = await gmailService.sendEmail({
      userId:      req.user.id,
      to, subject,
      body:        body || "",
      threadId:    threadId || null,
      attachments,
    });

    const actR = await pool.query(
      `INSERT INTO crm_partner_activities
         (partner_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id, created_by)
       VALUES ($1, 'email', $2, $3, NOW(), $4, $5, $6)
       RETURNING *`,
      [partnerId, subject, body || null, sentThreadId, messageId, req.user.id],
    );

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
// WĄTKI
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/thread/lead/:leadId/:threadId", requireAuth, crmAuth, async (req, res) => {
  try {
    const messages = await gmailService.getThread(req.user.id, req.params.threadId);
    res.json(messages);
  } catch (err) {
    console.error("[Gmail] getThread error:", err.message);
    res.status(500).json({ error: "Błąd pobierania wątku: " + err.message });
  }
});

router.get("/thread/partner/:partnerId/:threadId", requireAuth, crmAuth, async (req, res) => {
  try {
    const messages = await gmailService.getThread(req.user.id, req.params.threadId);
    res.json(messages);
  } catch (err) {
    console.error("[Gmail] getThread error:", err.message);
    res.status(500).json({ error: "Błąd pobierania wątku: " + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUB/SUB WEBHOOK (push z Google)
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/webhook/pubsub", async (req, res) => {
  // Zawsze odpowiadaj 200 — inaczej Pub/Sub będzie ponawiał w nieskończoność
  res.sendStatus(200);

  try {
    const message = req.body?.message;
    if (!message?.data) return;

    const decoded = JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
    console.log("[Gmail] Pub/Sub push:", JSON.stringify(decoded));

    // decoded.emailAddress — adres skrzynki która dostała wiadomość
    // decoded.historyId    — nowe historyId do pobrania zmian
    // Tutaj możesz dodać logikę automatycznego importu wiadomości do CRM
  } catch (err) {
    console.error("[Gmail] Pub/Sub parse error:", err.message);
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
