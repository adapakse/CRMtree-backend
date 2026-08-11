"use strict";
// src/services/emailContactSync.js
//
// Provider-agnostic helpers shared by gmailProcessor.js and outlookProcessor.js:
// parsing a "Name <email>" header, auto-saving newly-seen sender addresses as
// lead/partner contacts, and storing a downloaded attachment buffer. None of
// this touches Gmail or Outlook APIs directly — callers pass in an already
// downloaded Buffer.

const { v4: uuidv4 }  = require("uuid");
const { pool }        = require("../config/database");
const storageService  = require("./storageService");

function parseEmailHeader(header) {
  const str = String(header || "").trim();
  const m   = str.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim().replace(/^["']|["']$/g, ""), email: m[2].trim().toLowerCase() };
  return { name: "", email: str.toLowerCase() };
}

async function autoSaveLeadContacts(leadId, emailHeaders, tenantId) {
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
        "INSERT INTO crm_lead_contacts (lead_id, contact_name, email, tenant_id) VALUES ($1, $2, $3, $4)",
        [leadId, name || email, email, tenantId],
      );
    } catch (e) {
      console.warn("[EmailContactSync] autoSaveLeadContacts error:", e.message);
    }
  }
}

async function autoSavePartnerContacts(partnerId, emailHeaders, tenantId) {
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
        `INSERT INTO crm_partner_contacts (partner_id, contact_name, email, tenant_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [partnerId, name || email, email, tenantId],
      );
    } catch (e) {
      console.warn("[EmailContactSync] autoSavePartnerContacts error:", e.message);
    }
  }
}

async function storeAttachment({ leadId, partnerId, messageId, attachmentId, filename, mimeType, buffer, direction, mailboxUserId }) {
  const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobPath     = `crm-attachments/${new Date().toISOString().slice(0, 10)}-${uuidv4().slice(0, 8)}-${safeFilename}`;
  await storageService.uploadBuffer(blobPath, buffer, mimeType || "application/octet-stream");
  const idCol = leadId ? "lead_id" : "partner_id";
  const idVal = leadId || partnerId;
  await pool.query(
    `INSERT INTO crm_email_attachments
       (${idCol}, gmail_message_id, gmail_attachment_id, filename, mime_type, blob_path, file_size, direction, mailbox_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING`,
    [idVal, messageId, attachmentId || null, filename, mimeType || "application/octet-stream", blobPath, buffer.length, direction || "received", mailboxUserId || null],
  );
  return blobPath;
}

module.exports = { parseEmailHeader, autoSaveLeadContacts, autoSavePartnerContacts, storeAttachment };
