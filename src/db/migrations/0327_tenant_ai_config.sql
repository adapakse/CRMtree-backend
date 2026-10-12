-- Migration 0327: dostawca AI, klucz API i model — osobno DLA KAŻDEJ FUNKCJI,
-- wszystko per tenant.
--
-- UWAGA CO DO NUMERU: 0326 zajmuje migracja etapów leada
-- (feature/konfigurowalne-etapy-leada), 0328 pola dodatkowe formatek. Jeśli te
-- gałęzie wejdą w innej kolejności, numer trzeba przenumerować — tak jak przy
-- Yandeksie (commit 185027f7). `_migrations` w bazie jest źródłem prawdy co
-- realnie zaaplikowano.
--
-- PO CO: wywołania AI brały klucz z env, czyli z Key Vaulta CRM Tree — tenant
-- korzystał z NASZEGO klucza i my płaciliśmy za jego zużycie. Model był wpisany
-- na sztywno w kodzie każdego serwisu, a wybór dostawcy istniał tylko w
-- Prospektach (app_settings.prospect.ai_provider, od tej migracji nieużywany).
--
-- Dla porównania: worktrips-doc ma wyłącznie ten sam przełącznik dostawcy
-- (migracja 0212_enrichment_ai_provider) i klucz z env — nie ma klucza per
-- tenant. Nie było więc czego przenosić; ten plik ustala wzorzec.
--
-- ZIARNISTOŚĆ: JEDEN WIERSZ NA FUNKCJĘ (decyzja 2026-10-09). Pierwsza wersja
-- trzymała jednego dostawcę na tenanta i tylko model per funkcja. Za mało:
-- klient może chcieć enrichment na tanim DeepSeeku, analizator rozmów na
-- OpenAI, a „Znajdź konkurencję" na Anthropicu — bo to trzy różne zadania o
-- różnej cenie i różnych wymaganiach. Dlatego każda funkcja ma własny komplet:
-- dostawca + klucz + model.
--
-- Funkcje (kolumna `purpose`):
--   enrichment            — enrichment ICP prospektów
--   call_analysis         — analizator rozmów
--   competitor_discovery  — Znajdź konkurencję          [wymaga web_search]
--   seo_facts             — SEO: research faktów        [wymaga web_search]
--   seo_research          — SEO: frazy, konspekt, mapa filarów
--   seo_content           — SEO: pisanie treści i social
--   assistant             — asystent formularzy aplikacji mobilnej
--
-- `purpose` NIE MA CHECK-a z listą wartości, celowo: lista funkcji żyje w
-- services/ai/aiProviders.js i rośnie razem z aplikacją. Gdyby była w bazie,
-- dołożenie funkcji AI wymagałoby migracji, a walidację i tak robi warstwa
-- aplikacji (nieznana funkcja jest odrzucana przy zapisie).
--
-- KLUCZ JEST PRZY KAŻDEJ FUNKCJI, ale admin nie musi go wklejać wielokrotnie:
-- zapis funkcji bez klucza bierze klucz zapisany już dla TEGO SAMEGO dostawcy
-- przy innej funkcji (patrz aiConfigService.saveConfig). Dzięki temu „DeepSeek
-- do enrichmentu i do analizatora rozmów" to jedno wklejenie, a mimo to każda
-- funkcja może mieć osobny klucz, gdy ktoś chce rozdzielić rozliczenia.
--
-- CZEGO NIE DA SIĘ OBEJŚĆ WYBOREM DOSTAWCY — zdolności, nie preferencje:
--   * web_search (Znajdź konkurencję, research faktów SEO) ma serwerowo tylko
--     Anthropic; OpenAI i Gemini mają własne, niekompatybilne mechanizmy
--     groundingu, DeepSeek nie ma żadnego,
--   * wymuszony JSON wg schematu (SEO, asystent) potrafią Anthropic i OpenAI;
--     Gemini ma niezgodny responseSchema, DeepSeek tylko „jakikolwiek JSON".
-- Egzekwuje to services/ai/aiClient.js, nie baza: to reguła o zdolnościach
-- dostawcy, która zmienia się razem z kodem, nie o danych.
--
-- DECYZJA: brak wiersza dla funkcji = ta funkcja jest wyłączona, BEZ fallbacku
-- na klucz systemowy. Po wdrożeniu każdy tenant musi skonfigurować te funkcje,
-- z których korzysta — cichy fallback na nasz klucz oznaczałby, że
-- niedokonfigurowany tenant generuje nam koszty, o których nikt nie wie.
--
-- Klucz jest szyfrowany AES-256-GCM (src/utils/encrypt.js — ten sam mechanizm co
-- tokeny KSeF, WhatsApp i skrzynek) i NIGDY nie wraca z API; na zewnątrz idzie
-- tylko api_key_hint (4 ostatnie znaki), dokładnie jak token_hint w ksef_companies.

CREATE TABLE IF NOT EXISTS tenant_ai_config (
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose         VARCHAR(32)  NOT NULL,
  provider        VARCHAR(32)  NOT NULL CHECK (provider IN ('anthropic','openai','gemini','deepseek')),
  api_key         TEXT         NOT NULL,
  api_key_hint    VARCHAR(8)   NOT NULL,
  model           VARCHAR(128),
  base_url        TEXT,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','error')),
  last_error      TEXT,
  last_checked_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, purpose)
);

COMMENT ON TABLE tenant_ai_config IS
  'Dostawca AI, klucz i model JEDNEJ funkcji AI jednego tenanta. Brak wiersza =
   ta funkcja jest u tego tenanta wyłączona (nie ma fallbacku na klucz
   systemowy — decyzja 2026-10-08).';
COMMENT ON COLUMN tenant_ai_config.purpose IS
  'Funkcja AI, np. enrichment, call_analysis, seo_content. Lista żyje w
   services/ai/aiProviders.js — celowo bez CHECK-a, żeby dołożenie funkcji nie
   wymagało migracji.';
COMMENT ON COLUMN tenant_ai_config.api_key IS
  'Klucz API dostawcy, zaszyfrowany AES-256-GCM (src/utils/encrypt.js). NIGDY nie
   wraca z API i nie trafia do logów — na zewnątrz idzie wyłącznie api_key_hint.
   Dwie funkcje u tego samego dostawcy zwykle trzymają tę samą wartość: klucz
   jest kopiowany przy zapisie, żeby każdy wiersz był samowystarczalny i żeby
   usunięcie jednej funkcji nie rozbroiło pozostałych.';
COMMENT ON COLUMN tenant_ai_config.api_key_hint IS
  '4 ostatnie znaki klucza, do pokazania adminowi, że klucz jest zapisany i który
   to klucz. Ten sam wzorzec co ksef_companies.token_hint.';
COMMENT ON COLUMN tenant_ai_config.model IS
  'Nazwa modelu u dostawcy. NULL = użyj domyślnego dla tego dostawcy i tej
   funkcji (domyślne trzymane w services/ai/aiProviders.js, nie w bazie, bo
   katalogi modeli zmieniają się częściej niż schemat — a tenant, który nic nie
   wybrał, ma po aktualizacji dostać nowszy model bez edycji wiersza).';
COMMENT ON COLUMN tenant_ai_config.base_url IS
  'Opcjonalne nadpisanie adresu API — dla dostawcy zgodnego z OpenAI stojącego pod
   własnym adresem (proxy, self-hosted). NULL = adres domyślny dostawcy.';
COMMENT ON COLUMN tenant_ai_config.status IS
  'active — klucz i model zweryfikowane u dostawcy przy zapisie; invalid —
   dostawca odrzucił klucz (401/403), funkcja nie działa do podmiany; error —
   inny błąd (sieć, 5xx, limit, brak środków), wart ponowienia. Wzorzec jak
   ksef_companies.status. Status jest PER FUNKCJA: wyczerpany klucz w jednej nie
   wyłącza pozostałych.';

-- Stary, systemowy przełącznik dostawcy dla Prospektów przestaje mieć znaczenie:
-- dostawca jest teraz ustawiany per funkcja. Wiersz zostaje w bazie do czasu
-- wdrożenia, żeby rollback kodu nie zostawił enrichmentu bez ustawienia dostawcy
-- — usunięcie to osobna, późniejsza migracja porządkowa.
COMMENT ON COLUMN app_settings.key IS
  'Klucz ustawienia. UWAGA: prospect.ai_provider jest od migracji 0327 NIEUŻYWANY
   — dostawcę AI trzyma tenant_ai_config.provider, osobno dla każdej funkcji.
   Wiersz zostaje do czasu wdrożenia 0327.';
