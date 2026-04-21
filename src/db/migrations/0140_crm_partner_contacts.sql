-- 0140_crm_partner_contacts.sql
-- Tabela dodatkowych kontaktów dla partnerów (relacja 1:N)
-- Główny kontakt pozostaje w crm_partners (contact_name, contact_title, email, phone)

CREATE TABLE IF NOT EXISTS crm_partner_contacts (
  id            SERIAL PRIMARY KEY,
  partner_id    INTEGER NOT NULL REFERENCES crm_partners(id) ON DELETE CASCADE,
  contact_name  VARCHAR(200),
  contact_title VARCHAR(100),
  email         VARCHAR(200),
  phone         VARCHAR(50),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crm_partner_contacts_partner_id ON crm_partner_contacts(partner_id);

COMMENT ON TABLE crm_partner_contacts IS
  'Dodatkowe kontakty powiązane z partnerem. Główny kontakt pozostaje w tabeli crm_partners.';
