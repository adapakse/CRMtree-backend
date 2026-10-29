-- 0332_restore_tenant_whatsapp_config.sql
-- Recreates tenant_whatsapp_config where it is missing. PROD has 0231 and
-- 0232 recorded as applied, yet the table does not exist there
-- (GET /api/crm/whatsapp/status → 500 "relation tenant_whatsapp_config does
-- not exist", 2026-10-23). Most likely the early version of 0215 — which still
-- dropped it unconditionally — ran after 0231. Neither 0231 nor 0232 will run
-- again, so the table comes back here, in its full current shape (0231 plus
-- the 0232 columns).
--
-- Idempotent: on a DB that has the table (INT, local) nothing changes.

CREATE TABLE IF NOT EXISTS tenant_whatsapp_config (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID        NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  waba_id                   TEXT        NOT NULL,
  phone_number_id           TEXT        NOT NULL,
  display_phone_number      TEXT,
  verified_name             TEXT,
  code_verification_status  TEXT,
  access_token              TEXT        NOT NULL,
  app_secret                TEXT,
  webhook_verify_token      TEXT        NOT NULL,
  is_enabled                BOOLEAN     NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS verified_name TEXT;
ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS code_verification_status TEXT;

COMMENT ON TABLE  tenant_whatsapp_config                          IS 'Per-tenant WhatsApp Business Cloud API config — one shared company channel per tenant, set by a super admin (Tenant management), never per-user.';
COMMENT ON COLUMN tenant_whatsapp_config.access_token             IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt';
COMMENT ON COLUMN tenant_whatsapp_config.app_secret               IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt. Optional at setup, needed later to verify webhook signatures.';
COMMENT ON COLUMN tenant_whatsapp_config.webhook_verify_token     IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt. Value the tenant admin also enters in the Meta App webhook config.';
COMMENT ON COLUMN tenant_whatsapp_config.display_phone_number     IS 'Fetched from Meta Graph API on every save (GET /{phone-number-id}) — never accepted as free-text input from the admin.';
COMMENT ON COLUMN tenant_whatsapp_config.verified_name            IS 'Meta''s verified_name for this phone number, fetched alongside display_phone_number.';
COMMENT ON COLUMN tenant_whatsapp_config.code_verification_status IS 'Meta''s code_verification_status (e.g. VERIFIED, NOT_VERIFIED) — surfaced in the UI as a warning when not VERIFIED.';
