-- 0219_user_zoho_tokens.sql
-- Per-user Zoho Mail OAuth2 tokens.
-- accounts_server: DC-specific token endpoint from OAuth callback (e.g. https://accounts.zoho.eu).
--   Used for refresh and revoke — stored directly from callback param, not derived.
-- api_domain: base service URL from token response (e.g. https://www.zohoapis.eu).
--   Kept for reference; Mail API host is looked up via static map keyed by accounts_server.
-- zoho_account_id: required in every Zoho Mail API URL — fetched from GET /api/accounts after OAuth.
-- last_fetched_at: set to NOW() at OAuth time to avoid importing historical email on first sync.

CREATE TABLE IF NOT EXISTS user_zoho_tokens (
  user_id         UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID        REFERENCES tenants(id) ON DELETE CASCADE,
  access_token    TEXT        NOT NULL,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ,
  email           TEXT,
  api_domain      TEXT        NOT NULL,
  accounts_server TEXT        NOT NULL,
  zoho_account_id TEXT        NOT NULL,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_zoho_tokens_tenant
  ON user_zoho_tokens(tenant_id);
