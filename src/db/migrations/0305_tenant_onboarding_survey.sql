-- 0305_tenant_onboarding_survey.sql
-- Onboarding survey a new tenant's admin fills in (Ustawienia aplikacji →
-- "Ankieta wdrożeniowa") so super admins know how to configure the tenant:
-- modules, email provider, WhatsApp, PBX, AI licences. Deliberately not
-- emailed anywhere — super admins read it in Panel admina → Tenants.

CREATE TABLE IF NOT EXISTS tenant_onboarding_surveys (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  status             VARCHAR(20) NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'submitted')),
  answers            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  encrypted_secrets  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  submitted_at       TIMESTAMPTZ,
  submitted_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  tenant_onboarding_surveys                   IS 'Per-tenant onboarding survey filled in by the tenant admin; read by super admins in Tenant management.';
COMMENT ON COLUMN tenant_onboarding_surveys.answers           IS 'Flat field key → string | string[] map. The form definition (labels, sections) lives in the frontend.';
COMMENT ON COLUMN tenant_onboarding_surveys.encrypted_secrets IS 'Flat field key → AES-256-GCM encrypted value — use src/utils/encrypt.js to decrypt. Only super admins ever get the plaintext back.';
