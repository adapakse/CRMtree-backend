-- 0129_audit_action_crm.sql
-- Dodaje brakujące wartości enumeracji audit_action.
--
-- WAŻNE: ALTER TYPE ADD VALUE nie może być wewnątrz bloku transakcji.
-- Uruchom ten plik bezpośrednio przez psql (poza BEGIN/COMMIT),
-- lub przez runner z wyłączonymi transakcjami per-migracja.

-- CRM — Leady
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_create';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_update';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_delete';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_migrated';

-- CRM — Import
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_import_leads';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_import_partners';

-- CRM — Grupy partnerów
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_group_create';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_group_update';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_group_delete';

-- CRM — Partnerzy
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_partner_create';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_partner_update';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_partner_delete';

-- Ustawienia aplikacji
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'settings_updated';

-- Test konta (crm_leads)
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_test_account';
