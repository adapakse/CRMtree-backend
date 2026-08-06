-- 0205_audit_action_tenant_deleted.sql
-- Adds the audit_action value used when a super admin soft-deletes a tenant.
--
-- WAŻNE: ALTER TYPE ADD VALUE nie może być wewnątrz bloku transakcji razem
-- z innymi poleceniami DDL — musi zostać w osobnym pliku migracji (patrz
-- 0195_audit_action_consent.sql dla tego samego wzorca).

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'tenant_deleted';
