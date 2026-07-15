-- 0206_tenant_whatsapp_config.sql
-- Per-tenant WhatsApp Business Cloud API configuration — one shared company
-- WhatsApp channel per tenant, configured by a super admin in Tenant
-- management (mirrors tenant_email_providers: superadmin-only, never per-user).
-- Secrets stored encrypted (AES-256-GCM via src/utils/encrypt.js).

CREATE TABLE IF NOT EXISTS tenant_whatsapp_config (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  waba_id               TEXT        NOT NULL,
  phone_number_id       TEXT        NOT NULL,
  display_phone_number  TEXT,
  access_token          TEXT        NOT NULL,
  app_secret            TEXT,
  webhook_verify_token  TEXT        NOT NULL,
  is_enabled            BOOLEAN     NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  tenant_whatsapp_config                     IS 'Per-tenant WhatsApp Business Cloud API config — one shared company channel per tenant, set by a super admin (Tenant management), never per-user.';
COMMENT ON COLUMN tenant_whatsapp_config.access_token        IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt';
COMMENT ON COLUMN tenant_whatsapp_config.app_secret          IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt. Optional at setup, needed later to verify webhook signatures.';
COMMENT ON COLUMN tenant_whatsapp_config.webhook_verify_token IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt. Value the tenant admin also enters in the Meta App webhook config.';
