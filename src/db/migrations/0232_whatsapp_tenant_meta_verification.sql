-- 0232_whatsapp_tenant_meta_verification.sql
-- Adds verified_name/code_verification_status to tenant_whatsapp_config.
-- From this point on, display_phone_number is fetched from Meta Graph API
-- (GET /{phone-number-id}) on every save — never accepted as free-text
-- input from the super admin. See whatsappService.upsertTenantConfig,
-- which now rejects the whole save if Meta can't resolve the
-- phone_number_id/access_token pair.
--
-- Business reason: a live test on 2026-08-03 caught exactly the failure
-- mode this prevents — a phone_number_id that actually pointed at Meta's
-- free Test Number resource (+1 555-172-2323, code_verification_status
-- NOT_VERIFIED), while the admin had manually typed the real business
-- number as display_phone_number. The two silently disagreed with no
-- validation catching it.

ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS verified_name TEXT;
ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS code_verification_status TEXT;

COMMENT ON COLUMN tenant_whatsapp_config.display_phone_number     IS 'Fetched from Meta Graph API on every save (GET /{phone-number-id}) — never accepted as free-text input from the admin.';
COMMENT ON COLUMN tenant_whatsapp_config.verified_name             IS 'Meta''s verified_name for this phone number, fetched alongside display_phone_number.';
COMMENT ON COLUMN tenant_whatsapp_config.code_verification_status IS 'Meta''s code_verification_status (e.g. VERIFIED, NOT_VERIFIED) — surfaced in the UI as a warning when not VERIFIED.';
