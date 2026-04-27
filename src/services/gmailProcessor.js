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

  // Zaktualizuj historyId — zawsze bierz MAX(fetchedHistoryId, historyId z powiadomienia)
  // Gdy history.list zwróci 404 (zbyt stary historyId), fetchedHistoryId === lastHistoryId;
  // wtedy resetujemy do historyId z powiadomienia żeby nie utknąć w pętli.
  const newHistoryId = String(Math.max(Number(fetchedHistoryId || 0), Number(historyId || 0)));
  await pool.query(
    "UPDATE user_gmail_tokens SET history_id = $1 WHERE user_id = $2",
    [newHistoryId, userId],
  );
  console.log(`[GmailProcessor] historyId: lastDB=${lastHistoryId} fetched=${fetchedHistoryId} notification=${historyId} → saved=${newHistoryId} messages=${messageIds.length}`);

  for (const msgId of messageIds) {
    try {
      const msg = await gmailService.getMessage(userId, msgId);
      console.log(`[GmailProcessor] Przetwarzanie msg=${msg.id} threadId=${msg.threadId} from="${msg.from}" subject="${msg.subject}"`);

      // Dopasuj wątek do leada lub partnera
      const [leadQ, partnerQ] = await Promise.all([
        pool.query("SELECT lead_id FROM crm_lead_activities WHERE gmail_thread_id = $1 LIMIT 1", [msg.threadId]),
        pool.query("SELECT partner_id FROM crm_partner_activities WHERE gmail_thread_id = $1 LIMIT 1", [msg.threadId]),
      ]);

      const leadId    = leadQ.rows[0]?.lead_id    || null;
      const partnerId = partnerQ.rows[0]?.partner_id || null;
      console.log(`[GmailProcessor] Dopasowanie: leadId=${leadId} partnerId=${partnerId}`);

      if (!leadId && !partnerId) {
        console.log(`[GmailProcessor] Nieznany wątek ${msg.threadId} — pominięto`);
        continue;
      }

      const actTable = leadId ? "crm_lead_activities"   : "crm_partner_activities";
      const idCol    = leadId ? "lead_id"               : "partner_id";
      const recordId = leadId || partnerId;

      // Sprawdź czy wiadomość już przetworzona (w tabeli message_reads)
      // Pominięcie tylko gdy wiersz istnieje i is_read=false (badge już ustawiony)
      // Wiersz z is_read=true (stary błąd) traktujemy jak nieistniejący — przetwarzamy ponownie
      let alreadyProcessed = false;
      try {
        const existing = await pool.query(
          `SELECT is_read FROM crm_email_message_reads WHERE gmail_message_id = $1`,
          [msg.id],
        );
        alreadyProcessed = existing.rows.length > 0 && existing.rows[0].is_read === false;
      } catch (dupCheckErr) {
        console.warn(`[GmailProcessor] crm_email_message_reads niedostępna (brak migracji?): ${dupCheckErr.message}`);
      }
      if (alreadyProcessed) {
        console.log(`[GmailProcessor] Wiadomość ${msg.id} już przetworzona (is_read=false) — pominięto`);
        continue;
      }

      // Oznacz wątek (aktywność) jako nieprzeczytany — jest nowa odpowiedź
      const updateRes = await pool.query(
        `UPDATE ${actTable} SET is_read = false, updated_at = NOW()
         WHERE ${idCol} = $1 AND gmail_thread_id = $2
         RETURNING id`,
        [recordId, msg.threadId],
      );
      console.log(`[GmailProcessor] UPDATE aktywności wątku: ${updateRes.rowCount} wierszy (recordId=${recordId})`);

      // Zarejestruj wiadomość jako nieprzeczytaną (z gmail_thread_id dla zliczania na poziomie wiadomości)
      try {
        await pool.query(
          `INSERT INTO crm_email_message_reads (gmail_message_id, gmail_thread_id, is_read)
           VALUES ($1, $2, false)
           ON CONFLICT (gmail_message_id) DO UPDATE
             SET is_read = false, gmail_thread_id = EXCLUDED.gmail_thread_id
             WHERE crm_email_message_reads.is_read = true`,
          [msg.id, msg.threadId],
        );
        console.log(`[GmailProcessor] INSERT crm_email_message_reads: msgId=${msg.id} threadId=${msg.threadId}`);
      } catch (insertErr) {
        console.error(`[GmailProcessor] INSERT crm_email_message_reads FAILED (msgId=${msg.id}): ${insertErr.message}`);
      }

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
