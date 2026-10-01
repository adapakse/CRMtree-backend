-- 0306_audit_action_visibility_grant.sql
-- Wartości enuma audit_action dla nadania/odebrania grantu widoczności CRM.
-- Osobna migracja od 0305 — nowej wartości enuma nie można użyć w tej samej
-- transakcji, w której została dodana.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_visibility_grant_create';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_visibility_grant_revoke';
