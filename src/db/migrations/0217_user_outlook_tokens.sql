-- 0217_user_outlook_tokens.sql
-- Per-user Microsoft Graph OAuth2 tokens for Outlook integration.
-- delta_link stores the @odata.deltaLink token for incremental message fetch
-- (equivalent to history_id in user_gmail_tokens).

CREATE TABLE IF NOT EXISTS user_outlook_tokens (
  user_id       UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     UUID        REFERENCES tenants(id) ON DELETE CASCADE,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  email         TEXT,
  delta_link    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_outlook_tokens_tenant
  ON user_outlook_tokens(tenant_id);
