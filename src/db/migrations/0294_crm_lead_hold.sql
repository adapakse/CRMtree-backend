-- Funkcja "Hold" dla leadów (crm_leads) — pauza działań sprzedażowych na czas
-- określony, dostępna wyłącznie w aktywnych etapach pipeline (qualification/
-- presentation/offer/negotiation). Powód wybierany z listy zarządzanej przez
-- admina w AppSettings (analogicznie do crm_lost_reasons), nie wolny tekst.
-- Port z worktrips (migracja 0252 tam), tu per-tenant.

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS hold_active BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS hold_reason VARCHAR(200);
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS hold_until  DATE;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS hold_set_by UUID REFERENCES users(id);
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS hold_set_at TIMESTAMPTZ;
-- Zadanie-przypomnienie ("wznów działania sprzedażowe") auto-tworzone przy
-- ustawieniu Holda — wiersz w crm_lead_activities (type='task'). Śledzone tu,
-- żeby edycja/zdjęcie Holda mogło zaktualizować/zamknąć właściwe zadanie.
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS hold_task_id INTEGER REFERENCES crm_lead_activities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_leads_hold_active
  ON crm_leads (tenant_id, hold_active) WHERE hold_active = true;

-- Słownik powodów Holda (zarządzany przez admina w AppSettings — jak crm_lost_reasons).
-- Per-tenant, wzorzec jak 0280_prospect_icp_blacklist_settings.
INSERT INTO app_settings (tenant_id, key, value, value_type, label, description, category)
SELECT t.id, 'crm_hold_reasons',
       '["Sytuacja wewnątrz firmy","Brak osób decyzyjnych","Przerwa w działalności"]',
       'json',
       'Powody Holda leada',
       'Lista powodów Holda. Wyświetlana jako lista wyboru w polu "Powód" przy ustawianiu statusu Hold na leadzie.',
       'crm'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;
