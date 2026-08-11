"use strict";
// src/services/zohoProcessor.js
//
// Mirrors outlookProcessor.js's matching/dedup logic for Zoho Mail. Zoho has
// no push mechanism either (see zohoService.getNewMessages — manual poll via
// last_fetched_at, no webhook), so there is no processNotification(emailAddress)
// entry point here — zohoPoller.js calls processUserNotifications(userId)
// directly on each poll cycle instead.

const { pool }      = require("../config/database");
const zohoService    = require("./zohoService");
const { parseEmailHeader, storeAttachment } = require("./emailContactSync");

// ── Process a single Zoho message ────────────────────────────────────────────
//
// Matches msg to a CRM lead or partner (by thread → sender), dedupes, and
// records the activity / read record. Reuses the same
// crm_lead_activities/crm_partner_activities columns as Gmail/Outlook
// (gmail_thread_id/gmail_message_id are provider-agnostic despite the name).
// Returns true when the message was new and recorded; false when skipped.
//
async function processOneMessage(msg, tenantId, userId, emailAddress) {
  console.log(`[ZohoProcessor] Przetwarzanie msg=${msg.id} threadId=${msg.threadId} from="${msg.from}" subject="${msg.subject}"`);

  // ── 1. Thread-based match ──────────────────────────────────────────────────
  const [leadQ, partnerQ] = await Promise.all([
    pool.query("SELECT lead_id FROM crm_lead_activities WHERE gmail_thread_id = $1 AND tenant_id = $2 LIMIT 1", [msg.threadId, tenantId]),
    pool.query("SELECT partner_id FROM crm_partner_activities WHERE gmail_thread_id = $1 AND tenant_id = $2 LIMIT 1", [msg.threadId, tenantId]),
  ]);

  let leadId    = leadQ.rows[0]?.lead_id    || null;
  let partnerId = partnerQ.rows[0]?.partner_id || null;
  console.log(`[ZohoProcessor] Dopasowanie wątku: leadId=${leadId} partnerId=${partnerId} tenant=${tenantId}`);

  // ── 2. Sender-based fallback when thread is not in CRM ────────────────────
  if (!leadId && !partnerId) {
    const senderEmail  = parseEmailHeader(msg.from || '').email.toLowerCase();
    const senderDomain = senderEmail.split('@')[1] || null;
    const userDomain   = emailAddress.split('@')[1]?.toLowerCase();

    if (!senderDomain || senderDomain === userDomain) {
      console.log(`[ZohoProcessor] Wewnętrzny email / brak domeny — pominięto`);
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
      console.log(`[ZohoProcessor] Nieznany nadawca ${senderEmail} — pominięto`);
      return false;
    }

    const actTable2 = leadId ? 'crm_lead_activities'   : 'crm_partner_activities';
    const idCol2    = leadId ? 'lead_id'               : 'partner_id';
    const recordId2 = leadId || partnerId;

    // created_by is NULL — this is an inbound message from an external
    // sender, not authored by any CRM user. mailbox_user_id records which
    // user's connected mailbox received it (the thread's owner going forward).
    const insRes = await pool.query(
      `INSERT INTO ${actTable2}
         (${idCol2}, type, title, body, activity_at, gmail_thread_id, gmail_message_id, is_read, status, created_by, mailbox_user_id, tenant_id)
       SELECT $1, 'email', $2, $3, $4, $5, $6, false, 'new', NULL, $7, $8
       WHERE NOT EXISTS (SELECT 1 FROM ${actTable2} WHERE gmail_message_id = $6)
       RETURNING id`,
      [recordId2, msg.subject || '(bez tematu)', msg.body || null,
       msg.date ? new Date(msg.date) : new Date(), msg.threadId, msg.id, userId, tenantId],
    );
    console.log(`[ZohoProcessor] Fallback match: ${actTable2} recordId=${recordId2} email="${senderEmail}" inserted=${insRes.rowCount} tenant=${tenantId}`);

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
          const buffer = await zohoService.getAttachmentBuffer(userId, msg.id, att.attachmentId);
          await storeAttachment({
            leadId:       leadId    || undefined,
            partnerId:    partnerId || undefined,
            messageId:    msg.id,
            attachmentId: att.attachmentId,
            filename:     att.filename,
            mimeType:     att.mimeType,
            buffer,
            direction:    'received',
            mailboxUserId: userId,
          });
        } catch (attErr) {
          console.warn('[ZohoProcessor] Fallback attachment failed:', attErr.message);
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
    console.warn(`[ZohoProcessor] crm_email_message_reads niedostępna (brak migracji?): ${dupCheckErr.message}`);
  }
  if (alreadyProcessed) {
    console.log(`[ZohoProcessor] Wiadomość ${msg.id} już przetworzona — pominięto`);
    return false;
  }

  const updateRes = await pool.query(
    `UPDATE ${actTable} SET is_read = false, updated_at = NOW()
     WHERE ${idCol} = $1 AND gmail_thread_id = $2 AND tenant_id = $3
     RETURNING id`,
    [recordId, msg.threadId, tenantId],
  );
  console.log(`[ZohoProcessor] UPDATE aktywności wątku: ${updateRes.rowCount} wierszy (recordId=${recordId} tenant=${tenantId})`);

  try {
    await pool.query(
      `INSERT INTO crm_email_message_reads (gmail_message_id, gmail_thread_id, is_read, tenant_id)
       VALUES ($1, $2, false, $3)
       ON CONFLICT (gmail_message_id) DO UPDATE
         SET is_read = false, gmail_thread_id = EXCLUDED.gmail_thread_id
         WHERE crm_email_message_reads.is_read = true`,
      [msg.id, msg.threadId, tenantId],
    );
    console.log(`[ZohoProcessor] INSERT crm_email_message_reads: msgId=${msg.id} threadId=${msg.threadId}`);
  } catch (insertErr) {
    console.error(`[ZohoProcessor] INSERT crm_email_message_reads FAILED (msgId=${msg.id}): ${insertErr.message}`);
  }

  for (const att of msg.attachments || []) {
    try {
      const buffer = await zohoService.getAttachmentBuffer(userId, msg.id, att.attachmentId);
      await storeAttachment({
        leadId:       leadId    || undefined,
        partnerId:    partnerId || undefined,
        messageId:    msg.id,
        attachmentId: att.attachmentId,
        filename:     att.filename,
        mimeType:     att.mimeType,
        buffer,
        direction:    "received",
        mailboxUserId: userId,
      });
    } catch (attErr) {
      console.warn("[ZohoProcessor] Attachment download failed:", attErr.message);
    }
  }

  return true;
}

// ── Poll one connected Zoho mailbox for new mail ─────────────────────────────
//
// Called by zohoPoller.js on each cycle for every row in user_zoho_tokens.
// zohoService.getNewMessages() only returns raw message-list summaries (no
// body/attachments) — getMessage() fetches the full parsed content per new
// message before matching, same two-step shape as Outlook's processor.
//
async function processUserNotifications(userId) {
  const { rows } = await pool.query(
    `SELECT u.tenant_id, t.email
     FROM user_zoho_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.user_id = $1`,
    [userId],
  );
  if (!rows.length || !rows[0].email) return { processed: 0 };
  const { tenant_id: tenantId, email: emailAddress } = rows[0];

  const { newMessages } = await zohoService.getNewMessages(userId);

  let processed = 0;
  for (const raw of newMessages) {
    try {
      const msg = await zohoService.getMessage(userId, raw.messageId, raw.folderId || null);
      const ok  = await processOneMessage(msg, tenantId, userId, emailAddress);
      if (ok) processed++;
    } catch (msgErr) {
      console.error("[ZohoProcessor] Message processing error:", msgErr.message);
    }
  }

  return { processed };
}

module.exports = { processOneMessage, processUserNotifications };
