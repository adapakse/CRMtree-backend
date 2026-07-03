"use strict";
// src/services/gmailProcessor.js
//
// Shared Gmail notification processing logic.
// Used by pubsubPoller (pull) and the debug/process route.

const { v4: uuidv4 }  = require("uuid");
const { pool }        = require("../config/database");
const gmailService    = require("./gmailService");
const storageService  = require("./storageService");

// Domains too generic to use for CRM sender-based matching
const GENERIC_DOMAINS = new Set([
  'gmail.com','googlemail.com','outlook.com','hotmail.com','hotmail.pl',
  'yahoo.com','yahoo.pl','wp.pl','onet.pl','interia.pl','o2.pl','tlen.pl',
  'live.com','live.pl','me.com','icloud.com','protonmail.com','protonmail.ch',
  'zoho.com','mail.com','yandex.com','yandex.ru',
]);

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
    if (email.toLowerCase().endsWith("@crmtree.com")) continue;
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
    if (email.toLowerCase().endsWith("@crmtree.com")) continue;
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

// ── Process a single Gmail message ─────────────────────────────────────────────
//
// Matches msg to a CRM lead or partner (by thread → sender), deduplicates,
// and records the activity / reads record.
// Returns true when the message was new and recorded; false when skipped.
//
async function processOneMessage(msg, userId, tenantId, emailAddress) {
  console.log(`[GmailProcessor] Przetwarzanie msg=${msg.id} threadId=${msg.threadId} from="${msg.from}" subject="${msg.subject}"`);

  // ── 1. Thread-based match ──────────────────────────────────────────────────
  const [leadQ, partnerQ] = await Promise.all([
    pool.query("SELECT lead_id FROM crm_lead_activities WHERE gmail_thread_id = $1 AND tenant_id = $2 LIMIT 1", [msg.threadId, tenantId]),
    pool.query("SELECT partner_id FROM crm_partner_activities WHERE gmail_thread_id = $1 AND tenant_id = $2 LIMIT 1", [msg.threadId, tenantId]),
  ]);

  let leadId    = leadQ.rows[0]?.lead_id    || null;
  let partnerId = partnerQ.rows[0]?.partner_id || null;
  console.log(`[GmailProcessor] Dopasowanie wątku: leadId=${leadId} partnerId=${partnerId} tenant=${tenantId}`);

  // ── 2. Sender-based fallback when thread is not in CRM ────────────────────
  if (!leadId && !partnerId) {
    const senderEmail  = parseEmailHeader(msg.from || '').email.toLowerCase();
    const senderDomain = senderEmail.split('@')[1] || null;
    const userDomain   = emailAddress.split('@')[1]?.toLowerCase();

    if (!senderDomain || senderDomain === userDomain) {
      console.log(`[GmailProcessor] Wewnętrzny email / brak domeny — pominięto`);
      return false;
    }

    const [elMain, elCon, epMain, epCon] = await Promise.all([
      pool.query('SELECT id FROM crm_leads WHERE LOWER(email) = $1 AND tenant_id = $2 LIMIT 1', [senderEmail, tenantId]),
      pool.query(
        `SELECT c.lead_id AS id FROM crm_lead_contacts c
         JOIN crm_leads l ON l.id = c.lead_id AND l.tenant_id = $2
         WHERE LOWER(c.email) = $1 LIMIT 1`,
        [senderEmail, tenantId],
      ),
      pool.query('SELECT id FROM crm_partners WHERE LOWER(email) = $1 AND tenant_id = $2 LIMIT 1', [senderEmail, tenantId]),
      pool.query(
        `SELECT c.partner_id AS id FROM crm_partner_contacts c
         JOIN crm_partners p ON p.id = c.partner_id AND p.tenant_id = $2
         WHERE LOWER(c.email) = $1 LIMIT 1`,
        [senderEmail, tenantId],
      ),
    ]);
    leadId    = elMain.rows[0]?.id || elCon.rows[0]?.id || null;
    partnerId = epMain.rows[0]?.id || epCon.rows[0]?.id || null;

    if (!leadId && !partnerId) {
      console.log(`[GmailProcessor] Nieznany nadawca ${senderEmail} — pominięto`);
      return false;
    }

    const actTable2 = leadId ? 'crm_lead_activities'   : 'crm_partner_activities';
    const idCol2    = leadId ? 'lead_id'               : 'partner_id';
    const recordId2 = leadId || partnerId;

    const insRes = await pool.query(
      `INSERT INTO ${actTable2}
         (${idCol2}, type, title, body, activity_at, gmail_thread_id, gmail_message_id, is_read, status, created_by, tenant_id)
       SELECT $1, 'email', $2, $3, $4, $5, $6, false, 'new', $7, $8
       WHERE NOT EXISTS (SELECT 1 FROM ${actTable2} WHERE gmail_message_id = $6)
       RETURNING id`,
      [recordId2, msg.subject || '(bez tematu)', msg.body || msg.snippet || null,
       msg.date ? new Date(msg.date) : new Date(), msg.threadId, msg.id, userId, tenantId],
    );
    console.log(`[GmailProcessor] Fallback match: ${actTable2} recordId=${recordId2} email="${senderEmail}" inserted=${insRes.rowCount} tenant=${tenantId}`);

    if (insRes.rowCount > 0) {
      try {
        await pool.query(
          `INSERT INTO crm_email_message_reads (gmail_message_id, gmail_thread_id, is_read, tenant_id)
           VALUES ($1, $2, false, $3)
           ON CONFLICT (gmail_message_id) DO NOTHING`,
          [msg.id, msg.threadId, tenantId],
        );
      } catch (e) { /* migration may not exist yet */ }

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
            direction:    'received',
          });
        } catch (attErr) {
          console.warn('[GmailProcessor] Fallback attachment failed:', attErr.message);
        }
      }
    }

    return insRes.rowCount > 0;
  }

  // ── 3. Known thread: dedup, mark unread, record reads ─────────────────────
  const actTable = leadId ? "crm_lead_activities"   : "crm_partner_activities";
  const idCol    = leadId ? "lead_id"               : "partner_id";
  const recordId = leadId || partnerId;

  let alreadyProcessed = false;
  try {
    const existing = await pool.query(
      `SELECT 1 FROM crm_email_message_reads WHERE gmail_message_id = $1`,
      [msg.id],
    );
    alreadyProcessed = existing.rows.length > 0;
  } catch (dupCheckErr) {
    console.warn(`[GmailProcessor] crm_email_message_reads niedostępna (brak migracji?): ${dupCheckErr.message}`);
  }
  if (alreadyProcessed) {
    console.log(`[GmailProcessor] Wiadomość ${msg.id} już przetworzona — pominięto`);
    return false;
  }

  const updateRes = await pool.query(
    `UPDATE ${actTable} SET is_read = false, updated_at = NOW()
     WHERE ${idCol} = $1 AND gmail_thread_id = $2 AND tenant_id = $3
     RETURNING id`,
    [recordId, msg.threadId, tenantId],
  );
  console.log(`[GmailProcessor] UPDATE aktywności wątku: ${updateRes.rowCount} wierszy (recordId=${recordId} tenant=${tenantId})`);

  try {
    await pool.query(
      `INSERT INTO crm_email_message_reads (gmail_message_id, gmail_thread_id, is_read, tenant_id)
       VALUES ($1, $2, false, $3)
       ON CONFLICT (gmail_message_id) DO UPDATE
         SET is_read = false, gmail_thread_id = EXCLUDED.gmail_thread_id
         WHERE crm_email_message_reads.is_read = true`,
      [msg.id, msg.threadId, tenantId],
    );
    console.log(`[GmailProcessor] INSERT crm_email_message_reads: msgId=${msg.id} threadId=${msg.threadId}`);
  } catch (insertErr) {
    console.error(`[GmailProcessor] INSERT crm_email_message_reads FAILED (msgId=${msg.id}): ${insertErr.message}`);
  }

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

  return true;
}

// ── Recovery sync when historyId has expired ───────────────────────────────────
//
// Fetches the 50 most recent INBOX messages and processes each through
// processOneMessage (same matching + deduplication as the normal path).
// Saves a fresh historyId from the Gmail profile after processing.
// Called only on 404 from history.list — never saves the stale cursor.
//
async function recoverFromExpiredHistory(userId, tenantId, emailAddress) {
  const messageIds = await gmailService.listRecentInboxMessages(userId, 50);
  console.log(`[GmailProcessor] Recovery: sprawdzam ${messageIds.length} ostatnich wiadomości INBOX (tenant=${tenantId})`);

  let count = 0;
  for (const msgId of messageIds) {
    try {
      const msg = await gmailService.getMessage(userId, msgId);
      const ok  = await processOneMessage(msg, userId, tenantId, emailAddress);
      if (ok) count++;
    } catch (msgErr) {
      console.warn('[GmailProcessor] Recovery — błąd wiadomości:', msgErr.message);
    }
  }

  const freshHistoryId = await gmailService.getCurrentHistoryId(userId);
  await pool.query(
    "UPDATE user_gmail_tokens SET history_id = $1, updated_at = NOW() WHERE user_id = $2",
    [freshHistoryId, userId],
  );
  console.log(`[GmailProcessor] Recovery zakończony: odzyskano ${count} nowych, nowy historyId=${freshHistoryId}`);

  return { count, freshHistoryId };
}

// ── Main notification handler ──────────────────────────────────────────────────
//
// Returns { recovered, recoveredCount?, processed? } so callers can surface
// the recovery outcome to the user.
//
async function processNotification(emailAddress, historyId) {
  const { rows: userRows } = await pool.query(`
    SELECT t.user_id, t.history_id, u.tenant_id
    FROM user_gmail_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE LOWER(t.email) = LOWER($1)
  `, [emailAddress]);
  if (!userRows.length) return { recovered: false, processed: 0 };

  const { user_id: userId, history_id: lastHistoryId, tenant_id: tenantId } = userRows[0];

  if (!lastHistoryId) {
    await pool.query(
      "UPDATE user_gmail_tokens SET history_id = $1 WHERE user_id = $2",
      [String(historyId), userId],
    );
    return { recovered: false, processed: 0 };
  }

  const { messageIds, historyId: fetchedHistoryId, needsRecovery } = await gmailService.getNewMessages(userId, lastHistoryId);

  // historyId expired — do NOT persist the stale cursor; run bounded recovery instead
  if (needsRecovery) {
    console.warn(`[GmailProcessor] historyId ${lastHistoryId} wygasł — uruchamiam recovery sync`);
    const { count, freshHistoryId } = await recoverFromExpiredHistory(userId, tenantId, emailAddress);
    return { recovered: true, recoveredCount: count, historyId: freshHistoryId };
  }

  const newHistoryId = String(Math.max(Number(fetchedHistoryId || 0), Number(historyId || 0)));
  await pool.query(
    "UPDATE user_gmail_tokens SET history_id = $1 WHERE user_id = $2",
    [newHistoryId, userId],
  );
  console.log(`[GmailProcessor] historyId: lastDB=${lastHistoryId} fetched=${fetchedHistoryId} notification=${historyId} → saved=${newHistoryId} messages=${messageIds.length} tenant=${tenantId}`);

  let processed = 0;
  for (const msgId of messageIds) {
    try {
      const msg = await gmailService.getMessage(userId, msgId);
      const ok  = await processOneMessage(msg, userId, tenantId, emailAddress);
      if (ok) processed++;
    } catch (msgErr) {
      console.error("[GmailProcessor] Message processing error:", msgErr.message);
    }
  }

  return { recovered: false, processed };
}

module.exports = { processNotification, autoSaveLeadContacts, autoSavePartnerContacts, storeAttachment };
