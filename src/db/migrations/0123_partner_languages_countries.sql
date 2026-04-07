-- 0123_partner_languages_countries.sql
-- Dodaje słowniki języków i krajów do app_settings

INSERT INTO app_settings (key, value, label, description, value_type, category)
VALUES
  (
    'crm_partner_languages',
    '["Polski","Angielski","Rosyjski","Rumuński","Niemiecki"]',
    'Języki partnerów',
    'Lista języków dostępnych w profilu partnera.',
    'json',
    'crm'
  ),
  (
    'crm_partner_countries',
    '["Polska","Niemcy","Francja","Wielka Brytania","Czechy","Słowacja","Węgry","Rumunia","Ukraina","Rosja","Austria","Szwajcaria","Włochy","Hiszpania","Holandia","Belgia","Szwecja","Norwegia","Dania","Finlandia"]',
    'Kraje partnerów',
    'Lista krajów dostępnych w profilu partnera (Dane dodatkowe i Billing Address).',
    'json',
    'crm'
  )
ON CONFLICT (key) DO NOTHING;
