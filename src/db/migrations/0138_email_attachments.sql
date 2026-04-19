-- 0138_email_attachments.sql
-- Tabela załączników emailowych z referencją do Azure Blob Storage.
-- Umożliwia pobieranie załączników nawet po rozłączeniu konta Gmail (np. po odejściu handlowca).

CREATE TABLE IF NOT EXISTS crm_email_attachments (
  id                  SERIAL        PRIMARY KEY,
  lead_id             INT           REFERENCES crm_leads(id)    ON DELETE CASCADE,
  partner_id          INT           REFERENCES crm_partners(id) ON DELETE CASCADE,
  gmail_message_id    TEXT          NOT NULL,
  gmail_attachment_id TEXT,                      -- Gmail attachmentId (do re-fetch gdy blob niedostępny)
  filename            TEXT          NOT NULL,
  mime_type           TEXT          NOT NULL DEFAULT 'application/octet-stream',
  blob_path           TEXT,                      -- ścieżka w Azure Blob (NULL = jeszcze nie pobrano)
  file_size           INT,
  direction           TEXT          NOT NULL DEFAULT 'received', -- 'sent' | 'received'
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_email_att_owner CHECK (
    (lead_id IS NOT NULL AND partner_id IS NULL) OR
    (lead_id IS NULL AND partner_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_email_att_message
  ON crm_email_attachments (gmail_message_id);

CREATE INDEX IF NOT EXISTS idx_email_att_lead
  ON crm_email_attachments (lead_id)
  WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_att_partner
  ON crm_email_attachments (partner_id)
  WHERE partner_id IS NOT NULL;
