-- 0224_gmail_per_user_mailbox.sql
-- Reverts Gmail sending from the shared tenant mailbox back to per-user
-- mailboxes: provider configuration (OAuth Client, Pub/Sub) stays on the
-- tenant (tenant_email_providers), but each CRM user connects their own
-- Google account and sends/receives from their own address.
--
-- tenant_gmail_tokens is NOT touched, NOT migrated, NOT dropped — same
-- rollback-safety pattern as 0203 used for user_gmail_tokens.

-- Pre-existing stale duplicates from before the tenant-owned-mailbox era
-- (this table has had no writers since 0203) would block the unique index
-- below. Keep only the most recently updated row per email.
DELETE FROM user_gmail_tokens a
  USING user_gmail_tokens b
  WHERE a.email IS NOT NULL
    AND LOWER(a.email) = LOWER(b.email)
    AND (a.updated_at, a.user_id) < (b.updated_at, b.user_id);

-- One Google account can only ever belong to one CRM user. This also makes
-- gmailProcessor.processNotification's mailbox lookup by email unambiguous
-- (previously only defensively LIMIT-1'd).
CREATE UNIQUE INDEX IF NOT EXISTS user_gmail_tokens_email_unique
  ON user_gmail_tokens (LOWER(email))
  WHERE email IS NOT NULL;

-- Identifies which connected mailbox owns a given email thread: the sender
-- for outbound activity, the receiving mailbox for inbound activity. Kept
-- separate from created_by, which means "authored by this CRM user" and
-- must stay NULL for messages written by an external sender.
ALTER TABLE crm_lead_activities
  ADD COLUMN IF NOT EXISTS mailbox_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS mailbox_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Same ownership marker on attachments so the download endpoint can resolve
-- whose Gmail token to fetch with, without joining back to the activity row.
ALTER TABLE crm_email_attachments
  ADD COLUMN IF NOT EXISTS mailbox_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN crm_lead_activities.mailbox_user_id    IS 'User whose connected Gmail/Outlook/Zoho mailbox this thread belongs to (sender for outbound, recipient for inbound). Not the same as created_by.';
COMMENT ON COLUMN crm_partner_activities.mailbox_user_id IS 'User whose connected Gmail/Outlook/Zoho mailbox this thread belongs to (sender for outbound, recipient for inbound). Not the same as created_by.';
COMMENT ON COLUMN crm_email_attachments.mailbox_user_id  IS 'User whose connected mailbox this attachment was sent/received through.';
