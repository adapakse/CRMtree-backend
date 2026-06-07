-- 0195_audit_action_consent.sql
-- Dodaje wartości audit_action dla zmian zgód marketingowych.
--
-- WAŻNE: ALTER TYPE ADD VALUE nie może być wewnątrz bloku transakcji.
-- Uruchom bezpośrednio przez psql lub runner z wyłączonymi transakcjami per-migracja.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_consent_update';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_partner_consent_update';
