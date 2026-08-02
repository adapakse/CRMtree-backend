-- 0221_tenant_email_tokens.sql
-- One shared company mailbox per tenant, per provider — OAuth tokens now
-- belong to the tenant, not to an individual CRM user.
--
-- This is intentionally a NEW, parallel set of tables. The existing
-- user_gmail_tokens / user_outlook_tokens / user_zoho_tokens tables (and
-- their rows) are NOT touched, NOT migrated, NOT dropped — they stay in
-- place for rollback until the new tenant-scoped flow has been verified.
--
-- Shape mirrors the corresponding user_*_tokens table (same provider-specific
-- columns), with tenant_id as the primary key instead of user_id.
-- connected_by_user_id records which CRM user performed the OAuth flow
-- (audit only — never used to resolve auth).

CREATE TABLE IF NOT EXISTS tenant_gmail_tokens (
  tenant_id            UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  access_token         TEXT        NOT NULL,
  refresh_token        TEXT,
  token_type           TEXT        NOT NULL DEFAULT 'Bearer',
  expires_at           TIMESTAMPTZ,
  email                TEXT,
  history_id           TEXT,
  connected_by_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_outlook_tokens (
  tenant_id            UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  access_token         TEXT        NOT NULL,
  refresh_token        TEXT,
  expires_at           TIMESTAMPTZ,
  email                TEXT,
  delta_link           TEXT,
  connected_by_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_zoho_tokens (
  tenant_id            UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  access_token         TEXT        NOT NULL,
  refresh_token        TEXT,
  expires_at           TIMESTAMPTZ,
  email                TEXT,
  api_domain           TEXT        NOT NULL,
  accounts_server      TEXT        NOT NULL,
  zoho_account_id      TEXT        NOT NULL,
  last_fetched_at      TIMESTAMPTZ,
  connected_by_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenant_gmail_tokens   IS 'Shared company Gmail mailbox OAuth tokens — one per tenant. Replaces per-user connect for CRM sending; user_gmail_tokens is kept, untouched, for rollback.';
COMMENT ON TABLE tenant_outlook_tokens IS 'Shared company Outlook mailbox OAuth tokens — one per tenant. Replaces per-user connect for CRM sending; user_outlook_tokens is kept, untouched, for rollback.';
COMMENT ON TABLE tenant_zoho_tokens    IS 'Shared company Zoho Mail mailbox OAuth tokens — one per tenant. Replaces per-user connect for CRM sending; user_zoho_tokens is kept, untouched, for rollback.';
