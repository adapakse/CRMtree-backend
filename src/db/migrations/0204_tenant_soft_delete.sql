-- 0204_tenant_soft_delete.sql
-- Soft delete for tenants — superadmin "Usuń tenant" from Tenant management.
--
-- Deliberately NOT is_active: that flag already means something else (a
-- tenant temporarily marked inactive but still listed/manageable). Deleted
-- tenants must disappear from the standard tenant list entirely, while every
-- row that references them (users, leads, partners, tokens, settings, ...)
-- stays exactly as-is — this migration only adds the marker columns, it
-- never touches or cascades into any other table.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_deleted_at
  ON tenants(deleted_at) WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN tenants.deleted_at IS
  'Soft-delete marker. NULL = active/visible tenant. Set = hidden from the standard tenant list and inaccessible to its users (blocked at login and on every subsequent request); all related data (users, leads, partners, tokens, settings) is left untouched for rollback.';
COMMENT ON COLUMN tenants.deleted_by IS
  'Super admin user who soft-deleted this tenant (audit only — never used to resolve auth).';
