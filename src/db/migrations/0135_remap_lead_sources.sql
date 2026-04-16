-- 0135_remap_lead_sources.sql
-- Mapowanie starych wartości source na nowe:
--   strona_www  → Formularz_online
--   polecenie   → Własne
--   linkedin    → LinkedIn_Lead_Form
--   targi       → Własne
--   kampania    → Alias_Hello
--   inbound     → Własne
--   cold_call   → Cold_Call  (bez zmian — nowy klucz)
--   partner     → Partner    (bez zmian)
--   agent       → Ajent      (nowy klucz)
--   inne        → (usuwamy — brak mapowania, zostawiamy lub mapujemy na Własne)

UPDATE crm_leads SET source = 'Formularz_online'    WHERE source = 'strona_www';
UPDATE crm_leads SET source = 'Własne'              WHERE source IN ('polecenie','targi','inbound');
UPDATE crm_leads SET source = 'LinkedIn_Lead_Form'  WHERE source = 'linkedin';
UPDATE crm_leads SET source = 'Alias_Hello'         WHERE source = 'kampania';
UPDATE crm_leads SET source = 'Cold_Call'           WHERE source = 'cold_call';
UPDATE crm_leads SET source = 'Ajent'               WHERE source = 'agent';
UPDATE crm_leads SET source = 'Własne'              WHERE source = 'inne';
-- Partner pozostaje bez zmian

-- Zaktualizuj słownik w AppSettings — nowy format z grupowaniem
UPDATE app_settings
SET value = '[
  {"value":"Własne",              "label":"Własne",               "group":null},
  {"value":"Cold_Call",           "label":"Cold Call",            "group":null},
  {"value":"Partner",             "label":"Partner",              "group":null},
  {"value":"Ajent",               "label":"Agent",                "group":null},
  {"value":"LinkedIn_Lead_Form",  "label":"LinkedIn Lead Form",   "group":"Marketing"},
  {"value":"LinkedIn_in_mail",    "label":"LinkedIn InMail",      "group":"Marketing"},
  {"value":"Alias_Hello",         "label":"Alias Hello",          "group":"Marketing"},
  {"value":"Formularz_online",    "label":"Formularz online",     "group":"Marketing"},
  {"value":"GoogleAds_AISearch",  "label":"Google Ads AI Search", "group":"Marketing"},
  {"value":"GoogleAds_PMax",      "label":"Google Ads PMax",      "group":"Marketing"},
  {"value":"GoogleAds_SEA_Brand", "label":"Google Ads SEA Brand", "group":"Marketing"}
]',
  updated_at = now()
WHERE key = 'crm_lead_sources';
