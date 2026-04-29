-- Dodaje do crm_partners pola zbierane na etapie Lead, które nie mają odpowiednika
-- w dwh.partner — jedynym źródłem tych danych jest crm_leads (ręczne wypełnienie przez handlowca).
-- Pola są transferowane automatycznie przy konwersji Lead → Partner (POST /leads/:id/migrate).

ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS website            TEXT,
  ADD COLUMN IF NOT EXISTS source             VARCHAR(80),
  ADD COLUMN IF NOT EXISTS first_contact_date DATE;
