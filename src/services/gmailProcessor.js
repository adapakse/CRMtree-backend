"use strict";
// src/services/gmailProcessor.js
//
// Wspólna logika przetwarzania powiadomień Gmail (Pub/Sub).
// Używana zarówno przez pubsubPoller (pull) jak i opcjonalny webhook (push).

const { v4: uuidv4 }  = require("uuid");
const { pool }        = require("../config/database");
const gmailService    = require("./gmailService");
const storageService  = require("./storageService");

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseEmailHeader(header) {
  const str = String(header || "").trim();
  const m   = str.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim().replace(/^["']|["']$/g, ""), email: m[2].trim().toLowerCase() };
  return { name: "", email: str.toLowerCase() };
}

async function autoSaveLeadContacts(leadId, emailHeaders) {
  for (const header of emailHeaders) {
    const { name, email } = parseEmailHeader(header);
    if (!email || !email.includes("@")) continue;
    if (email.toLowerCase().endsWith("@worktrips.com")) continue;
    try {
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
      console.warn("[GmailProcessor] autoSaveLeadContacts error:", e.message);
    }
  }
}

async function autoSavePartnerContacts(partnerId, emailHeaders) {
  for (const header of emailHeaders) {
    const { name, email } = parseEmailHeader(header);
    if (!email || !email.includes("@")) continue;
    if (email.toLowerCase().endsWith("@worktrips.com")) continue;
    try {
      const [mainQ, extraQ] = await Promise.all([
        pool.query("SELECT id FROM crm_partners WHERE id = $1 AND LOWER(email) = $2", [partnerId, email]),
        pool.query("SELECT id FROM crm_partner_contacts WHERE partner_id = $1 AND LOWER(email) = $2", [partnerId, email]),
      ]);
      if (mainQ.rows.length || extraQ.rows.length) continue;
      await pool.query(
        `INSERT INTO crm_partner_contacts (partner_id, contact_name, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [partnerId, name || email, email],
      );
    } catch (e) {
      console.warn("[GmailProcessor] autoSavePartnerContacts error:", e.message);
    }
  }
}

async function storeAttachment({ leadId, partnerId, messageId, attachmentId, filename, mimeType, buffer, direction }) {
  const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobPath     = `crm-attachments/${new Date().toISOString().slice(0, 10)}-${uuidv4().slice(0, 8)}-${safeFilename}`;
  await storageService.uploadBuffer(blobPath, buffer, mimeType || "application/octet-stream");
  const idCol = leadId ? "lead_id" : "partner_id";
  const idVal = leadId || partnerId;
  await pool.query(
    `INSERT INTO crm_email_attachments
       (${idCol}, gmail_message_id, gmail_attachment_id, filename, mime_type, blob_path, file_size, direction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [idVal, messageId, attachmentId || null, filename, mimeType || "application/octet-stream", blobPath, buffer.length, direction || "received"],
  );
  return blobPath;
}

// ── Główna funkcja przetwarzania jednego powiadomienia Pub/Sub ─────────────────

/**
 * Przetwarza powiadomienie Gmail: pobiera nowe wiadomości przez History API,
 * dopasowuje do leadów/partnerów i zapisuje aktywności.
 *
 * @param {string} emailAddress  - adres Gmail z powiadomienia
 * @param {string|number} historyId - nowy historyId z powiadomienia
 */
async function processNotification(emailAddress, historyId) {
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
      [String(historyId), userId],
    );
    return;
  }

  // Pobierz nowe wiadomości od ostatniego historyId
  const { messageIds, historyId: fetchedHistoryId } = await gmailService.getNewMessages(userId, lastHistoryId);

  // Zaktualizuj historyId
  await pool.query(
    "UPDATE user_gmail_tokens SET history_id = $1 WHERE user_id = $2",
    [String(fetchedHistoryId || historyId), userId],
  );

  for (const msgId of messageIds) {
    try {
      const msg = await gmailService.getMessage(userId, msgId);

      // Dopasuj wątek do leada lub partnera
      const [leadQ, partnerQ] = await Promise.all([
        pool.query("SELECT lead_id FROM crm_lead_activities WHERE gmail_thread_id = $1 LIMIT 1", [msg.threadId]),
        pool.query("SELECT partner_id FROM crm_partner_activities WHERE gmail_thread_id = $1 LIMIT 1", [msg.threadId]),
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

      // Utwórz aktywność dla przychodzącego emaila (created_by = NULL = przychodzący)
      await pool.query(
        `INSERT INTO ${actTable}
           (${idCol}, type, title, body, activity_at, gmail_thread_id, gmail_message_id, created_by)
         VALUES ($1, 'email', $2, $3, $4, $5, $6, NULL)`,
        [recordId, `↩ ${msg.subject || "(bez tematu)"}`, msg.body || msg.snippet || null, msg.date, msg.threadId, msg.id],
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
          console.warn("[GmailProcessor] Attachment download failed:", attErr.message);
        }
      }

      // Auto-zapis nadawcy + CC do kontaktów leada/partnera
      const inboundAddresses = [
        ...(msg.from ? [msg.from] : []),
        ...(msg.cc   ? String(msg.cc).split(",").map((s) => s.trim()).filter(Boolean) : []),
      ];
      if (leadId    && inboundAddresses.length) await autoSaveLeadContacts(leadId, inboundAddresses);
      if (partnerId && inboundAddresses.length) await autoSavePartnerContacts(partnerId, inboundAddresses);

    } catch (msgErr) {
      console.error("[GmailProcessor] Message processing error:", msgErr.message);
    }
  }
}

module.exports = { processNotification, autoSaveLeadContacts, autoSavePartnerContacts, storeAttachment };
