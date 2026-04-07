-- 0122_partner_extended_fields.sql
-- Zadanie A: Dane dodatkowe (subdomain, language, currency, country)
-- Zadanie B: Billing Address rozdzielony na pola
-- Zadanie C: Partner Admin (admin_first_name, admin_last_name, admin_email)

ALTER TABLE crm_partners
  -- Zadanie A: Dane dodatkowe
  ADD COLUMN IF NOT EXISTS subdomain       VARCHAR(30),
  ADD COLUMN IF NOT EXISTS language        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS partner_currency VARCHAR(10),
  ADD COLUMN IF NOT EXISTS country         VARCHAR(100),

  -- Zadanie B: Billing Address rozdzielony
  ADD COLUMN IF NOT EXISTS billing_address VARCHAR(50),
  ADD COLUMN IF NOT EXISTS billing_zip     VARCHAR(10),
  ADD COLUMN IF NOT EXISTS billing_city    VARCHAR(30),
  ADD COLUMN IF NOT EXISTS billing_country VARCHAR(100),
  ADD COLUMN IF NOT EXISTS billing_email_address VARCHAR(255),

  -- Zadanie C: Partner Admin
  ADD COLUMN IF NOT EXISTS admin_first_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS admin_last_name  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS admin_email      VARCHAR(255);

-- Walidacja subdomeny na poziomie bazy (tylko [a-z0-9], 3-30 znaków)
ALTER TABLE crm_partners
  DROP CONSTRAINT IF EXISTS crm_partners_subdomain_check;

ALTER TABLE crm_partners
  ADD CONSTRAINT crm_partners_subdomain_check
  CHECK (
    subdomain IS NULL OR (
      subdomain ~ '^[a-z0-9]{3,30}$'
    )
  );

-- Walidacja email
ALTER TABLE crm_partners
  DROP CONSTRAINT IF EXISTS crm_partners_billing_email_address_check;

ALTER TABLE crm_partners
  ADD CONSTRAINT crm_partners_billing_email_address_check
  CHECK (
    billing_email_address IS NULL OR
    billing_email_address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  );

ALTER TABLE crm_partners
  DROP CONSTRAINT IF EXISTS crm_partners_admin_email_check;

ALTER TABLE crm_partners
  ADD CONSTRAINT crm_partners_admin_email_check
  CHECK (
    admin_email IS NULL OR
    admin_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  );
