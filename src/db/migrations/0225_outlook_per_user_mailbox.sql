-- 0225_outlook_per_user_mailbox.sql
-- Mirrors 0224_gmail_per_user_mailbox.sql for Outlook: reverts sending from
-- the shared tenant mailbox back to per-user mailboxes. Provider configuration
-- (OAuth Client, azure_tenant_id) stays on the tenant (tenant_email_providers);
-- each CRM user connects their own Microsoft 365 account and sends/receives
-- from their own address.
--
-- tenant_outlook_tokens is NOT touched, NOT migrated, NOT dropped — same
-- rollback-safety pattern as 0203/0208.
--
-- crm_lead_activities.mailbox_user_id / crm_partner_activities.mailbox_user_id /
-- crm_email_attachments.mailbox_user_id already exist (added in 0208) — those
-- columns are provider-agnostic, Outlook reuses them as-is, no new columns needed.

-- Pre-existing stale duplicates from before this table had any writers again
-- would block the unique index below. Keep only the most recently updated
-- row per email (same pattern as 0208).
DELETE FROM user_outlook_tokens a
  USING user_outlook_tokens b
  WHERE a.email IS NOT NULL
    AND LOWER(a.email) = LOWER(b.email)
    AND (a.updated_at, a.user_id) < (b.updated_at, b.user_id);

-- One Microsoft account can only ever belong to one CRM user — mirrors the
-- Gmail unique index and keeps future notification-matching-by-email
-- unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS user_outlook_tokens_email_unique
  ON user_outlook_tokens (LOWER(email))
  WHERE email IS NOT NULL;

-- tenant_id is nullable in the original 0199 migration; every connected
-- mailbox must belong to a tenant for the same reasons Gmail's does
-- (resolving OAuth Client config, tenant-scoped activity matching).
UPDATE user_outlook_tokens t
   SET tenant_id = u.tenant_id
  FROM users u
 WHERE t.user_id = u.id
   AND t.tenant_id IS NULL;

ALTER TABLE user_outlook_tokens ALTER COLUMN tenant_id SET NOT NULL;

COMMENT ON COLUMN user_outlook_tokens.tenant_id IS 'Resolves this mailbox''s OAuth Client config (tenant_email_providers) and scopes activity matching — NOT NULL like user_gmail_tokens.';
