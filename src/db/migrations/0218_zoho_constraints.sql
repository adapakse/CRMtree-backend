-- 0218_zoho_constraints.sql
-- Extend email_provider and provider CHECK constraints to include 'zoho'.
-- PostgreSQL auto-names inline CHECK constraints as {table}_{column}_check.

ALTER TABLE crm_lead_activities
  DROP CONSTRAINT IF EXISTS crm_lead_activities_email_provider_check,
  ADD CONSTRAINT crm_lead_activities_email_provider_check
    CHECK (email_provider IN ('gmail', 'outlook', 'zoho'));

ALTER TABLE crm_partner_activities
  DROP CONSTRAINT IF EXISTS crm_partner_activities_email_provider_check,
  ADD CONSTRAINT crm_partner_activities_email_provider_check
    CHECK (email_provider IN ('gmail', 'outlook', 'zoho'));

ALTER TABLE tenant_email_providers
  DROP CONSTRAINT IF EXISTS tenant_email_providers_provider_check,
  ADD CONSTRAINT tenant_email_providers_provider_check
    CHECK (provider IN ('gmail', 'outlook', 'zoho'));
