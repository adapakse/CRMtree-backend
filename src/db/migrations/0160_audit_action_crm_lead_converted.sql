-- 0160_audit_action_crm_lead_converted.sql
-- Dodaje brakującą wartość crm_lead_converted do enumeracji audit_action.
-- UWAGA: ALTER TYPE ADD VALUE nie może być wewnątrz bloku transakcji
-- (BEGIN/COMMIT). Runner musi uruchamiać ten plik bez transakcji.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_converted';
