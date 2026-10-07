-- 0324_user_yandex_tokens.sql
-- Per-user Yandex Mail OAuth2 tokens.
--
-- Unlike Zoho there is no accounts_server/api_domain column: Yandex has a single
-- set of endpoints (oauth.yandex.com, imap.yandex.com, smtp.yandex.com) serving
-- every regional mailbox, including @yandex.by and @yandex.ru, so there is
-- nothing per-account to resolve or store.
--
-- Yandex Mail has no public REST API — reading goes over IMAP with XOAUTH2 — so
-- the sync cursor is an IMAP one rather than Gmail's historyId or Outlook's
-- deltaLink:
--   uid_validity: UIDVALIDITY of the mailbox the UIDs below belong to. When the
--     server changes it, every stored UID is meaningless and the cursor must be
--     rebuilt from scratch (RFC 3501) — the same role Gmail's "historyId too
--     old" 404 plays in gmailService.
--   last_uid: highest IMAP UID already imported, valid only for the uid_validity
--     recorded alongside it.
-- Both are nullable: the row is created at OAuth time, before any IMAP session.
--
-- last_fetched_at: set to NOW() at OAuth time so the first sync does not import
-- the mailbox's entire history (same reason as user_zoho_tokens).

CREATE TABLE IF NOT EXISTS user_yandex_tokens (
  user_id         UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID        REFERENCES tenants(id) ON DELETE CASCADE,
  access_token    TEXT        NOT NULL,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ,
  email           TEXT,
  uid_validity    BIGINT,
  last_uid        BIGINT,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_yandex_tokens_tenant
  ON user_yandex_tokens(tenant_id);

-- One Yandex account can only ever belong to one CRM user — mirrors the
-- Gmail/Outlook/Zoho unique index and keeps matching incoming mail to a user
-- unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS user_yandex_tokens_email_unique
  ON user_yandex_tokens (LOWER(email))
  WHERE email IS NOT NULL;
