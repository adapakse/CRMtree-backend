-- 0187_tenant_email_providers.sql
-- Per-tenant OAuth2 credentials for Gmail and Outlook integrations.
-- client_secret stored encrypted (AES-256-GCM via src/utils/encrypt.js).

DROP TABLE IF EXISTS tenant_email_providers;
CREATE TABLE tenant_email_providers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      VARCHAR(20) NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  client_id     TEXT        NOT NULL,
  client_secret TEXT        NOT NULL,
  redirect_uri  TEXT,
  extra_config  JSONB       NOT NULL DEFAULT '{}',
  is_enabled    BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_tenant_email_providers_tenant
  ON tenant_email_providers(tenant_id);

COMMENT ON TABLE  tenant_email_providers                IS 'Per-tenant OAuth2 app credentials for email integrations';
COMMENT ON COLUMN tenant_email_providers.client_secret  IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt';
COMMENT ON COLUMN tenant_email_providers.extra_config   IS 'Provider-specific extras: gmail={pubsub_topic,pubsub_subscription}, outlook={azure_tenant_id}';
