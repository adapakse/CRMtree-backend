-- 0246_audit_action_subscription_cancelled.sql
-- Billing module: new audit_action value for subscription cancel/reactivate.
--
-- WAZNE: ALTER TYPE ADD VALUE nie moze byc w tej samej transakcji co uzycie
-- nowej wartosci — musi zostac w osobnym pliku migracji (patrz
-- 0195_audit_action_consent.sql / 0236_audit_action_billing.sql).

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'tenant_subscription_cancelled';
