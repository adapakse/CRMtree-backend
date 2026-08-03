-- 0231_whatsapp_tenant_level.sql
-- Reverts WhatsApp from the per-user model (0230) back to per-tenant: one
-- shared company WhatsApp Business number per tenant, configured by a super
-- admin in Tenant management — business decision 2026-08-03 (WhatsApp
-- Business blocks simultaneous personal/business use of the same phone
-- number, so per-user numbers weren't viable in the field). See CLAUDE.md.
--
-- Data handling (explicit choices, not defaults):
--   * whatsapp_configs (per-user numbers/tokens) is left untouched — becomes
--     unused/orphaned data, not read by any route after this migration, not
--     migrated into the new tenant_whatsapp_config. The tenant's number is
--     configured fresh by a super admin.
--   * whatsapp_messages keeps its rows (lead_id/partner_id conversation
--     history is real data) but drops owner_user_id — meaningless once a
--     tenant has exactly one shared number — restoring the exact shape from
--     the original tenant-level migration (historically
--     0207_whatsapp_messages.sql). Message bodies/status/timestamps survive;
--     only the "which user's number" attribute is gone.
--
-- Idempotent: every statement below is IF (NOT) EXISTS / no-op-safe, so a
-- re-run against a DB that already has this migration applied (under any
-- filename) changes nothing further. Follows the lesson from 0230's incident
-- writeup — never unconditionally DROP a table/column that could hold real
-- current data.

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

COMMENT ON TABLE  tenant_whatsapp_config                      IS 'Per-tenant WhatsApp Business Cloud API config — one shared company channel per tenant, set by a super admin (Tenant management), never per-user.';
COMMENT ON COLUMN tenant_whatsapp_config.access_token         IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt';
COMMENT ON COLUMN tenant_whatsapp_config.app_secret            IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt. Optional at setup, needed later to verify webhook signatures.';
COMMENT ON COLUMN tenant_whatsapp_config.webhook_verify_token  IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt. Value the tenant admin also enters in the Meta App webhook config.';

-- whatsapp_messages: drop owner_user_id and its indexes, replace the
-- owner-scoped dedup index with the tenant-scoped one. Column/index drops
-- are IF EXISTS so a second run against an already-migrated DB is a no-op,
-- and DROP INDEX runs before DROP COLUMN so there's no ambiguity about which
-- object goes first.
DROP INDEX IF EXISTS idx_whatsapp_messages_owner;
DROP INDEX IF EXISTS idx_whatsapp_messages_meta_id;

ALTER TABLE whatsapp_messages DROP COLUMN IF EXISTS owner_user_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_meta_id
  ON whatsapp_messages(tenant_id, meta_message_id) WHERE meta_message_id IS NOT NULL;

COMMENT ON TABLE whatsapp_messages IS 'Per-tenant WhatsApp conversation log. tenant_id identifies the shared company number the message went through; lead_id/partner_id identify who it is with.';
