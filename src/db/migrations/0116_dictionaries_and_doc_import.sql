-- Migration: 0116_dictionaries_and_doc_import
-- 1) Rozszerz enum audit_action o crm_import_documents
-- 2) Rozszerz CHECK constraint value_type o 'json'
-- 3) Dodaj nowe słowniki CRM i Documents do app_settings
-- 4) Rozszerz enum import_type w crm_import_logs (jeśli to enum)

-- ── 1. audit_action enum ─────────────────────────────────────────
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_import_documents';

-- ── 2. Rozszerz CHECK constraint na value_type ───────────────────
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_value_type_check;
ALTER TABLE app_settings ADD CONSTRAINT app_settings_value_type_check
  CHECK (value_type IN ('number','boolean','string','json','text'));

-- ── 3. Słowniki CRM ──────────────────────────────────────────────

-- Etapy leadów
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'crm_lead_stages',
  '["new","qualification","presentation","offer","negotiation","closed_won","closed_lost"]',
  'Etapy Leada',
  'Dostepne etapy sprzedazy dla leadow. Wartosc ''new'' oznacza Nowy, ''qualification'' Kwalifikacja, ''presentation'' Prezentacja, ''offer'' Oferta, ''negotiation'' Negocjacje, ''closed_won'' Wygrana, ''closed_lost'' Przegrana.',
  'json', 'crm'
) ON CONFLICT (key) DO NOTHING;

-- Statusy partnerów
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'crm_partner_statuses',
  '["onboarding","active","inactive","churned"]',
  'Statusy Partnera',
  'Dostepne statusy dla partnerow. onboarding=Wdrozenie, active=Aktywny, inactive=Nieaktywny, churned=Utracony.',
  'json', 'crm'
) ON CONFLICT (key) DO NOTHING;

-- Stanowiska (kontakty)
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'crm_contact_titles',
  '["CEO","CFO","CTO","COO","VP","Director","Manager","Specialist","Owner","Other"]',
  'Stanowiska Kontaktow',
  'Dostepne stanowiska w formularzach kontaktu dla Leadow i Partnerow.',
  'json', 'crm'
) ON CONFLICT (key) DO NOTHING;

-- Branże
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'crm_industries',
  '["IT","Finance","Transport","Tourism","Healthcare","Retail","Manufacturing","Legal","Education","Other"]',
  'Branze',
  'Dostepne wartosci branzy dla Leadow i Partnerow.',
  'json', 'crm'
) ON CONFLICT (key) DO NOTHING;

-- Waluty
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'crm_currencies',
  '["PLN","EUR","USD","GBP","CHF"]',
  'Waluty',
  'Dostepne waluty w formularzach CRM.',
  'json', 'crm'
) ON CONFLICT (key) DO NOTHING;

-- Podstawy prowizji
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'crm_commission_basis',
  '["nie_dotyczy","segmenty","rezerwacje","progi_obrotowe"]',
  'Podstawy Prowizji',
  'Dostepne podstawy naliczania prowizji dla Partnerow. nie_dotyczy=Nie dotyczy, segmenty=Ilosc segmentow, rezerwacje=Ilosc rezerwacji, progi_obrotowe=Progi obrotowe.',
  'json', 'crm'
) ON CONFLICT (key) DO NOTHING;

-- ── 4. Słowniki Dokumentów ───────────────────────────────────────

INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'doc_statuses',
  '["new","being_edited","being_approved","being_signed","signed","completed","rejected"]',
  'Statusy Dokumentow',
  'Dostepne statusy dokumentow. new=Nowy, being_edited=W edycji, being_approved=Do akceptacji, being_signed=Do podpisu, signed=Podpisany, completed=Zakonczony, rejected=Odrzucony.',
  'json', 'documents'
) ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'doc_types',
  '["partner_agreement","nda","it_supplier_agreement","employee_agreement"]',
  'Typy Dokumentow',
  'Dostepne typy dokumentow. Wartosc musi byc zgodna z enum doc_type w bazie.',
  'json', 'documents'
) ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES (
  'doc_gdpr_types',
  '["no_gdpr","data_processing_entrustment","data_administration"]',
  'Typy GDPR Dokumentow',
  'Dostepne typy GDPR. no_gdpr=Brak GDPR, data_processing_entrustment=Powierzenie przetwarzania, data_administration=Wspoladministrowanie.',
  'json', 'documents'
) ON CONFLICT (key) DO NOTHING;

-- ── 5. Zaktualizuj crm_lead_sources na value_type='json' ─────────
UPDATE app_settings
SET value_type = 'json'
WHERE key = 'crm_lead_sources' AND value_type = 'string';

-- ── 6. Rozszerz enum import_type o 'documents' ───────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'import_type') THEN
    ALTER TYPE import_type ADD VALUE IF NOT EXISTS 'documents';
  END IF;
END $$;
