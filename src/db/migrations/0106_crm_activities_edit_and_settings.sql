-- Upewnij się że kolumny value_type i category istnieją w app_settings
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS value_type TEXT    NOT NULL DEFAULT 'string',
  ADD COLUMN IF NOT EXISTS category   TEXT    NOT NULL DEFAULT 'general';

-- Migration: 0106_crm_activities_edit_and_settings
-- 1. Dodaje kolumnę updated_at do tabel aktywności (potrzebna do edycji)
-- 2. Dodaje parametry słownikowe CRM do app_settings (kategoria: crm)

-- 1. updated_at na tabelach aktywności
ALTER TABLE crm_lead_activities
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- 2. Parametry słownikowe CRM
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES

  -- Typy produktów sprzedażowych (lista JSON)
  ('crm_product_types',
   '["hotel","transport_flight","transport_train","transport_bus","transport_ferry","car_rental","transfer","travel_insurance","visa","other"]',
   'Typy produktów sprzedażowych',
   'Lista typów produktów widocznych w imporcie danych sprzedażowych i raportach. Format: tablica JSON.',
   'json', 'crm'),

  -- Podstawy prowizji WT/TM
  ('crm_commission_basis_options',
   '["nie_dotyczy","segmenty","rezerwacje","progi_obrotowe"]',
   'Podstawy prowizji WT/TM',
   'Dostępne podstawy naliczania prowizji WT/TM w kartotece partnera. Format: tablica JSON.',
   'json', 'crm'),

  -- Waluty
  ('crm_currencies',
   '["PLN","EUR","USD","GBP","CHF"]',
   'Obsługiwane waluty',
   'Lista walut dostępnych w polach: limit kredytowy, kwota depozytu, dane sprzedażowe. Format: tablica JSON.',
   'json', 'crm'),

  -- Etapy leada (business parameter używany w dashboardzie)
  ('crm_dashboard_win_stages',
   '["closed_won"]',
   'Etapy leada uznawane za "wygrany"',
   'Etapy leada traktowane jako wygrana (wpływają na Win Rate i licznik "Wygranych" w dashboardzie). Format: tablica JSON.',
   'json', 'crm'),

  -- Próg wartości leada dla dashboardu
  ('crm_dashboard_hot_value_threshold',
   '50000',
   'Próg wartości "gorącego" leada (PLN)',
   'Leady powyżej tej wartości są wyróżniane w dashboardzie jako wysokowartościowe.',
   'number', 'crm'),

  -- Próg cyklu sprzedażowego
  ('crm_dashboard_long_cycle_days',
   '90',
   'Długi cykl sprzedażowy (dni)',
   'Leady otwarte dłużej niż ta liczba dni są oznaczane w dashboardzie jako "długi cykl".',
   'number', 'crm')

ON CONFLICT (key) DO NOTHING;
