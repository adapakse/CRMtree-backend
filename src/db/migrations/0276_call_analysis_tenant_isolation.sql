-- Real bug caught during testing: call_analysis_companies had no tenant_id at
-- all (worktrips is single-tenant, NIP alone was a safe primary key there).
-- In CRMtree the same NIP can legitimately appear in different tenants'
-- pipelines, and — more importantly — without tenant_id every query leaked
-- data across tenants (a user from tenant B could read tenant A's call
-- analysis rows, since the group-based access check only restricts
-- visibility WITHIN a tenant, not ACROSS tenants).
--
-- Table is brand new (this session) with only test data, so a clean rebuild
-- of the primary key is safe — no production data to migrate.

DELETE FROM call_analysis_companies; -- local test rows only, not production data

ALTER TABLE call_analysis_companies
  DROP CONSTRAINT call_analysis_companies_pkey;

ALTER TABLE call_analysis_companies
  ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE call_analysis_companies
  ADD PRIMARY KEY (tenant_id, nip);

CREATE INDEX IF NOT EXISTS idx_call_analysis_tenant ON call_analysis_companies(tenant_id);
