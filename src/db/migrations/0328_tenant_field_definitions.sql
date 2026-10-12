-- Migration 0328: pola dodatkowe definiowane przez admina tenanta na formatkach
-- leada, partnera i dokumentu.
--
-- UWAGA CO DO NUMERU: 0326 zajmuje migracja etapów leada
-- (feature/konfigurowalne-etapy-leada), 0327 konfiguracja AI
-- (feature/ai-provider-per-tenant). Jeśli któraś z tych gałęzi wejdzie w innej
-- kolejności, numer trzeba przenumerować — tak jak przy Yandeksie (commit
-- 185027f7). `_migrations` w bazie jest źródłem prawdy co realnie zaaplikowano.
--
-- PO CO: karty leada, partnera i dokumentu mają dziś wyłącznie pola wbudowane w
-- kod — odpowiednio 39, 61 i 38 kolumn. Każdy klient, który potrzebuje własnego
-- pola („numer umowy ramowej", „data audytu", „limit kupiecki"), wymagał
-- migracji i wdrożenia. Ta zmiana przenosi to do rąk admina tenanta.
--
-- WZORZEC: 1:1 z polami dodatkowymi Projektów (migracja 0309,
-- project_field_definitions + project_tasks.custom_values). Te same typy pól, ta
-- sama zasada „nie usuwamy, tylko dezaktywujemy", te same wartości w JSONB
-- kluczowane po id definicji. Świadomie NIE budujemy drugiego, równoległego
-- mechanizmu — gdyby kiedyś scalać go z projektowym, zgodność kształtu jest
-- warunkiem, żeby dało się to zrobić bez migracji danych.
--
-- DLACZEGO OSOBNA TABELA, A NIE ROZSZERZENIE project_field_definitions:
-- tamta należy do modułu Projekty, który jest za flagą `projects` i ma własne
-- reguły uprawnień (PM dokłada pola do projektu). Leady, partnerzy i dokumenty
-- są dostępne bez tej flagi, a ich pola są wspólne dla wszystkich rekordów
-- danego typu. Wspólna tabela wiązałaby ze sobą dwa moduły, które mogą być u
-- tenanta włączone niezależnie.
--
-- ZAKRES PÓL JEST PER FORMATKA (kolumna `entity`). Pole „Numer umowy ramowej"
-- zdefiniowane dla partnera nie pojawia się samo na leadzie — Adam dyktował
-- „definiuje pola na formatkach dokumentów, leadów, partnerów", czyli trzy
-- osobne listy. Jedna wspólna lista z checkboxami „gdzie pokazać" byłaby
-- wygodniejsza przy polach powtarzalnych, ale to inna decyzja produktowa i
-- wymaga potwierdzenia u Adama.
--
-- CZEGO TU NIE MA, ŚWIADOMIE: odpowiednika „PM wybiera, które pola chce" z
-- Projektów. Na projekcie wybiera PM, bo projekt ma właściciela konfiguracji;
-- lead, partner i dokument takiej roli nie mają. Wszystkie aktywne pola danej
-- formatki są widoczne na każdym rekordzie tego typu. Naturalnym miejscem na tę
-- warstwę — gdyby Adam jej chciał — jest typ dokumentu (faktura potrzebuje
-- innych pól niż umowa), bo słownik `doc_types` już istnieje.
--
-- TŁUMACZENIA: nazwa pola jest danymi wpisanymi przez tenanta, więc NIE jest
-- tłumaczona (ta sama zasada co nazwy etapów leada i sygnałów ICP). Tłumaczony
-- jest wyłącznie interfejs edytora — 10 plików i18n w zakresie `admin`.

CREATE TABLE IF NOT EXISTS tenant_field_definitions (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity      VARCHAR(16)  NOT NULL CHECK (entity IN ('lead', 'partner', 'document')),
  name        VARCHAR(120) NOT NULL,
  field_type  VARCHAR(20)  NOT NULL CHECK (field_type IN ('text', 'number', 'list', 'date', 'money')),
  options     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Nazwa unikalna w obrębie JEDNEJ formatki: „Data audytu" może istnieć
  -- osobno na partnerze i na dokumencie, bo to dwa niezależne pola.
  UNIQUE (tenant_id, entity, name)
);

CREATE INDEX IF NOT EXISTS idx_tenant_field_definitions_entity
  ON tenant_field_definitions(tenant_id, entity, sort_order);

COMMENT ON TABLE tenant_field_definitions IS
  'Pola dodatkowe definiowane przez admina tenanta na formatkach leada, partnera
   i dokumentu. Odpowiednik project_field_definitions dla modułu Projekty —
   kształt celowo identyczny.';
COMMENT ON COLUMN tenant_field_definitions.entity IS
  'Formatka, do której należy pole. Listy są rozłączne: pole partnera nie
   pojawia się na leadzie ani na dokumencie.';
COMMENT ON COLUMN tenant_field_definitions.field_type IS
  'Te same typy co w Projektach. money = kwota razem z walutą, trzymana jako
   {"amount": 12.5, "currency": "PLN"}. date = data z kalendarza, bez godziny
   (DO POTWIERDZENIA u Adama: dyktował „pole czasu kalendarza" — jeśli chodziło
   o datę Z GODZINĄ, dochodzi osobny typ datetime).';
COMMENT ON COLUMN tenant_field_definitions.options IS
  'Dozwolone wartości pola typu "list" jako tablica JSON stringów; dla
   pozostałych typów pusta.';
COMMENT ON COLUMN tenant_field_definitions.is_active IS
  'Pozycji się NIE usuwa, tylko dezaktywuje (zasada z modułu Projekty).
   Nieaktywne pole znika z formatki, ale wartości już zapisane na rekordach
   zostają — inaczej dezaktywacja po cichu kasowałaby dane klienta.';

-- Wartości. JSONB kluczowany po tenant_field_definitions.id, dokładnie jak
-- project_tasks.custom_values. Kolumna na rekordzie, a nie osobna tabela
-- wartości: formatki czytają rekord jednym SELECT-em i dołożenie JOIN-a do
-- każdego z tych zapytań (lista leadów, lista partnerów, lista dokumentów)
-- kosztowałoby więcej niż daje.
ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS custom_values JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS custom_values JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS custom_values JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN crm_leads.custom_values IS
  'Wartości pól dodatkowych tenanta (entity = ''lead''), kluczowane po
   tenant_field_definitions.id.';
COMMENT ON COLUMN crm_partners.custom_values IS
  'Wartości pól dodatkowych tenanta (entity = ''partner''), kluczowane po
   tenant_field_definitions.id.';
COMMENT ON COLUMN documents.custom_values IS
  'Wartości pól dodatkowych tenanta (entity = ''document''), kluczowane po
   tenant_field_definitions.id.';
