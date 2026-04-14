-- 0131_lead_first_contact_date.sql
-- Dodaje pole "Pierwszy kontakt" do tabeli crm_leads.

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS first_contact_date DATE;

COMMENT ON COLUMN crm_leads.first_contact_date IS
  'Data pierwszego kontaktu z leadem — ustawiana ręcznie przez handlowca.';
