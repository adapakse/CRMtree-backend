-- 0126_document_extended_fields.sql
-- Nowe pola na tabeli documents:
--   1. NIP kontrahenta
--   2. Country (kraj) kontrahenta — słownik crm_partner_countries
--   3. contract_subject — przedmiot umowy (słownik)
--   4. contact_name / contact_email / contact_phone — dane kontaktowe ds. umowy

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS nip              VARCHAR(15),
  ADD COLUMN IF NOT EXISTS country          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS contract_subject VARCHAR(100),
  ADD COLUMN IF NOT EXISTS contact_name     VARCHAR(200),
  ADD COLUMN IF NOT EXISTS contact_email    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_phone    VARCHAR(50);

-- Słownik przedmiotów umowy
INSERT INTO app_settings (key, value, label, description, value_type, category)
VALUES (
  'doc_contract_subjects',
  '["Podróże służbowe","Konferencje/Spotkania","Zakwaterowanie","System","Inne"]',
  'Przedmioty umowy',
  'Lista wartości pola Przedmiot umowy w dokumentach.',
  'json',
  'documents'
)
ON CONFLICT (key) DO NOTHING;
