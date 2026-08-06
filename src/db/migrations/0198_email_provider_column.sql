-- 0198_email_provider_column.sql
-- Adds email_provider column to activity tables to distinguish Gmail from Outlook
-- threads stored in the same gmail_thread_id / gmail_message_id columns.

ALTER TABLE crm_lead_activities
  ADD COLUMN IF NOT EXISTS email_provider VARCHAR(16)
    NOT NULL DEFAULT 'gmail'
    CHECK (email_provider IN ('gmail', 'outlook'));

ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS email_provider VARCHAR(16)
    NOT NULL DEFAULT 'gmail'
    CHECK (email_provider IN ('gmail', 'outlook'));
