-- 0202_tenant_active_email_provider.sql
-- Single source of truth for which email provider a tenant currently uses.
-- NULL = no active provider (tenant sees "not configured", cannot connect/send).
-- Value must reference a provider with an enabled row in tenant_email_providers —
-- enforced at the application layer (PUT /api/admin/tenants/:id/active-provider),
-- not by a DB foreign key, since a provider row and the "active" flag are set
-- in separate steps by the admin UI.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS active_email_provider VARCHAR(20)
    CHECK (active_email_provider IN ('gmail', 'outlook', 'zoho'));

COMMENT ON COLUMN tenants.active_email_provider IS
  'The single email provider this tenant currently uses for CRM email (gmail|outlook|zoho|NULL=none). Users cannot choose or switch this — only a super admin, via PUT /api/admin/tenants/:id/active-provider.';
