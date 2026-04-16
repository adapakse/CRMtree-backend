-- 0136_crm_lead_contacts.sql
-- Tabela dodatkowych kontaktów dla leadów (relacja 1:N)
-- Główny kontakt pozostaje w crm_leads (contact_name, contact_title, email, phone)

CREATE TABLE IF NOT EXISTS crm_lead_contacts (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  contact_name VARCHAR(200),
  contact_title VARCHAR(100),
  email        VARCHAR(200),
  phone        VARCHAR(50),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crm_lead_contacts_lead_id ON crm_lead_contacts(lead_id);

COMMENT ON TABLE crm_lead_contacts IS
  'Dodatkowe kontakty powiązane z leadem. Główny kontakt pozostaje w tabeli crm_leads.';
