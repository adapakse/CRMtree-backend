-- Migration 0264: prospect_companies i pbx_call_log w worktrips-doc nie mają
-- tenant_id (aplikacja jednotenantowa) — w CRMtree jest to wymagane, inaczej
-- prospekty/połączenia jednego klienta CRMtree byłyby widoczne dla wszystkich
-- tenantów. Tabele są jeszcze puste (moduł dopiero powstaje) — bezpieczna
-- poprawka bez backfillu.

ALTER TABLE prospect_companies
  ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE prospect_companies SET tenant_id = (SELECT id FROM tenants LIMIT 1) WHERE tenant_id IS NULL;
ALTER TABLE prospect_companies
  ALTER COLUMN tenant_id SET NOT NULL;

-- NIP jest unikalny per-tenant, nie globalnie — dwaj różni klienci CRMtree
-- mogą prospektować tę samą firmę.
ALTER TABLE prospect_companies DROP CONSTRAINT prospect_companies_nip_unique;
ALTER TABLE prospect_companies ADD CONSTRAINT prospect_companies_tenant_nip_unique UNIQUE (tenant_id, nip);

CREATE INDEX IF NOT EXISTS idx_prospect_companies_tenant ON prospect_companies(tenant_id);

ALTER TABLE pbx_call_log
  ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE pbx_call_log SET tenant_id = (SELECT id FROM tenants LIMIT 1) WHERE tenant_id IS NULL;
ALTER TABLE pbx_call_log
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pbx_call_log_tenant ON pbx_call_log(tenant_id);
