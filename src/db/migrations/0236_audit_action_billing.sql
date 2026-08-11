-- 0236_audit_action_billing.sql
-- Billing module (M1): new audit_action values.
--
-- WAZNE: ALTER TYPE ADD VALUE nie moze byc w tej samej transakcji co uzycie
-- nowej wartosci — musi zostac w osobnym pliku migracji (patrz
-- 0195_audit_action_consent.sql / 0223_audit_action_tenant_deleted.sql).

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'tenant_subscription_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'invoice_generated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'invoice_voided';
