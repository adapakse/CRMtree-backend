-- 0119_crm_leads_nip.sql
-- Dodaje pole NIP do tabeli crm_leads

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS nip TEXT;

COMMENT ON COLUMN crm_leads.nip IS 'Numer Identyfikacji Podatkowej — wypełniany ręcznie lub przez enrich';
