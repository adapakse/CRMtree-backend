-- 0143_crm_partners_drop_partner_number.sql
-- Usuwa kolumnę partner_number z crm_partners.
--
-- Uzasadnienie:
--   partner_number (TEXT) był kluczem łączącym z crm_sales_transactions,
--   która została usunięta w migracji 0142. W nowej architekturze integracja
--   z systemem transakcyjnym Worktrips odbywa się przez dwh_partner_id (INTEGER)
--   → dwh.dm_partner. Pole partner_number jest zatem nadmiarowe.
--
-- BEZPIECZEŃSTWO:
--   IF EXISTS — bezpieczny przy wielokrotnym uruchomieniu.

ALTER TABLE crm_partners DROP COLUMN IF EXISTS partner_number;
