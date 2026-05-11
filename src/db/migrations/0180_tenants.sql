-- ============================================================
-- Sprint 1 / M1 — Tenant infrastructure tables
-- Tworzy fundamenty multi-tenant: tenants, feature-flagi,
-- konfiguracje auth i email oraz rozszerza tabelę users.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── ENUMY ───────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE auth_provider_type AS ENUM (
    'password',
    'google_workspace',
    'entra_id',
    'saml'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_feature_type AS ENUM (
    'documents',
    'leads',
    'sales_reports',
    'onboarding',
    'partner_registry',
    'dwh_integration',
    'performance'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── TENANTS ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   VARCHAR(255) NOT NULL UNIQUE,
  -- slug używany w subdomain (acme.crmtree.pl) i jako prefix DWH
  slug                   VARCHAR(64)  NOT NULL UNIQUE
                         CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  email_domain           VARCHAR(255),                         -- auto-identyfikacja po emailu
  dwh_schema_prefix      VARCHAR(32)                           -- np. "acme" → acme_partner
                         CHECK (
                           dwh_schema_prefix IS NULL
                           OR dwh_schema_prefix ~ '^[a-z][a-z0-9_]*$'
                         ),
  created_from_tenant_id UUID         REFERENCES tenants(id) ON DELETE SET NULL,
  is_active              BOOLEAN      NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_email_domain
  ON tenants(email_domain) WHERE email_domain IS NOT NULL;

COMMENT ON TABLE  tenants IS 'Jeden wiersz = jeden klient SaaS (tenant).';
COMMENT ON COLUMN tenants.slug IS 'Krótka nazwa używana w URL i jako prefix tabel DWH. Tylko [a-z0-9-].';
COMMENT ON COLUMN tenants.dwh_schema_prefix IS 'Prefix tabel DWH w schemacie dwh, np. "acme" → dwh.acme_partner.';

-- ── TENANT AUTH CONFIGS ──────────────────────────────────────
-- Jeden wiersz per tenant per provider.
-- Sekrety OAuth trzymane w Azure Key Vault — tu tylko nazwa sekretu.

CREATE TABLE IF NOT EXISTS tenant_auth_configs (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider                  auth_provider_type NOT NULL,
  is_enabled                BOOLEAN NOT NULL DEFAULT false,

  -- Google Workspace OAuth2
  google_client_id          TEXT,
  google_client_secret_ref  TEXT,    -- nazwa sekretu w Azure Key Vault
  google_hd                 TEXT,    -- ograniczenie do domeny, np. "acmecorp.com"

  -- Microsoft Entra ID (Azure AD)
  entra_directory_tenant_id TEXT,    -- GUID tenanta Azure AD
  entra_client_id           TEXT,
  entra_client_secret_ref   TEXT,    -- nazwa sekretu w Azure Key Vault

  -- SAML (enterprise legacy)
  saml_idp_cert             TEXT,
  saml_idp_sso_url          TEXT,
  saml_sp_entity_id         TEXT,

  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

-- ── TENANT FEATURES ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_features (
  tenant_id  UUID             NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature    crm_feature_type NOT NULL,
  is_enabled BOOLEAN          NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature)
);

COMMENT ON TABLE tenant_features IS 'Feature-flagi per tenant. Kontrolują widoczność modułów w UI.';

-- ── TENANT EMAIL PROVIDERS ────────────────────────────────────
-- Opcjonalne nadpisanie globalnej konfiguracji OAuth dla Gmail/Outlook per tenant.

CREATE TABLE IF NOT EXISTS tenant_email_providers (
  tenant_id               UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider                VARCHAR(16) NOT NULL DEFAULT 'gmail'
                          CHECK (provider IN ('gmail', 'outlook')),
  oauth_client_id         TEXT,
  oauth_client_secret_ref TEXT,    -- nazwa sekretu w Azure Key Vault
  oauth_redirect_uri      TEXT,
  is_active               BOOLEAN     NOT NULL DEFAULT true,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── ROZSZERZENIE TABELI USERS ────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin        BOOLEAN            NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS must_change_password  BOOLEAN            NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sso_provider          auth_provider_type,
  ADD COLUMN IF NOT EXISTS sso_subject           TEXT,
  ADD COLUMN IF NOT EXISTS password_hash         TEXT;

-- Unikalność SSO subject per provider (globalna — subject jest globalnie unikalny per provider)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_global
  ON users(sso_provider, sso_subject)
  WHERE sso_provider IS NOT NULL AND sso_subject IS NOT NULL;

COMMENT ON COLUMN users.is_super_admin       IS 'Super admin zarządza tenantami, nie widzi danych biznesowych.';
COMMENT ON COLUMN users.sso_subject          IS 'Google "sub" / Entra "oid" / SAML NameID.';
COMMENT ON COLUMN users.password_hash        IS 'bcrypt hash. NULL dla użytkowników SSO-only.';
COMMENT ON COLUMN users.must_change_password IS 'Wymagana zmiana hasła przy następnym logowaniu.';
