-- 0211_drop_tenant_owned_mailbox_tables.sql
-- Removes the "shared company mailbox per tenant" tables introduced in
-- 0203_tenant_email_tokens.sql. That model was abandoned in favor of
-- per-user mailboxes (0208/0209/0210_*_per_user_mailbox.sql) and no code
-- path has read or written these tables since. Confirmed dead before this
-- migration was written: no route, service export, or scheduled job
-- references tenant_gmail_tokens / tenant_outlook_tokens / tenant_zoho_tokens
-- or the tenant-owned-mailbox functions that used them.
--
-- 0203 itself is left untouched (historical migrations are never edited),
-- this migration just undoes what it created.

DROP TABLE IF EXISTS tenant_gmail_tokens;
DROP TABLE IF EXISTS tenant_outlook_tokens;
DROP TABLE IF EXISTS tenant_zoho_tokens;
