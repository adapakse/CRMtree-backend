-- Migration 0327: dostawca AI, klucz API i modele per tenant.
--
-- UWAGA CO DO NUMERU: 0326 zajmuje migracja etapów leada
-- (feature/konfigurowalne-etapy-leada). Jeśli ta gałąź wejdzie pierwsza, numer
-- trzeba przenumerować — tak jak zrobiono przy Yandeksie (commit 185027f7
-- "migracje Yandex jako 0324/0325 — kolizja numerów"). `_migrations` w bazie jest
-- źródłem prawdy co realnie zaaplikowano.
--
-- PO CO: wywołania AI brały klucz z env, czyli z Key Vaulta CRM Tree — tenant
-- korzystał z NASZEGO klucza i my płaciliśmy za jego zużycie. Model był wpisany
-- na sztywno w kodzie każdego serwisu, a wybór dostawcy istniał tylko w
-- Prospektach (app_settings.prospect.ai_provider).
--
-- ZAKRES TEJ ZMIANY (decyzja 2026-10-08) — konfiguracji tenanta używają na razie
-- DWIE funkcje, te same, które chodziły na systemowym DeepSeeku:
--   * enrichment ICP prospektów  (prospectEnrichmentService)
--   * analizator rozmów          (callAnalysisService)
--
-- NA KLUCZU SYSTEMOWYM ŚWIADOMIE ZOSTAJĄ, bez zmian w działaniu:
--   * Znajdź konkurencję (competitorDiscoveryService)
--   * SEO: research faktów i generowanie treści (seoFacts/seoContent/seoStrategy/seoSocial)
--   * asystent formularzy aplikacji mobilnej (Azure OpenAI)
-- Dwie pierwsze opierają się na SERWEROWYM narzędziu web_search Anthropica, które
-- nie ma odpowiednika o tym samym kontrakcie u OpenAI, Gemini ani DeepSeeka —
-- przeniesienie ich wymaga osobnej decyzji, nie samej wymiany klucza.
--
-- DECYZJA: dla objętych funkcji brak klucza = funkcja wyłączona, BEZ fallbacku na
-- klucz systemowy. Po wdrożeniu każdy istniejący tenant musi wpisać klucz, inaczej
-- enrichment i analizator rozmów przestaną mu działać — czysty model kosztów:
-- każdy płaci za swoje AI.
--
-- DWA MODELE, NIE JEDEN. Funkcje AI mają różne potrzeby: enrichment to tanie
-- przetwarzanie masowe, a generowanie długich treści wymaga mocniejszego modelu.
-- Jeden model dla wszystkiego byłby albo za słaby, albo absurdalnie drogi przy
-- przetwarzaniu masowym. Admin ustawia więc dwa:
--   model_fast    — zadania masowe i tanie (dziś: enrichment, analizator rozmów)
--   model_quality — długie treści i trudniejsze rozumowanie; puste = model_fast
-- model_quality nie ma dziś konsumenta (SEO zostaje na kluczu systemowym), ale
-- pole istnieje, bo tier 'quality' jest już w aiClient i czeka na przepięcie SEO.
--
-- Klucz jest szyfrowany AES-256-GCM (src/utils/encrypt.js — ten sam mechanizm co
-- tokeny KSeF, WhatsApp i skrzynek) i NIGDY nie wraca z API; na zewnątrz idzie
-- tylko api_key_hint (4 ostatnie znaki), dokładnie jak token_hint w ksef_companies.

CREATE TABLE IF NOT EXISTS tenant_ai_config (
  tenant_id       UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider        VARCHAR(32)  NOT NULL CHECK (provider IN ('anthropic','openai','gemini','deepseek')),
  api_key         TEXT         NOT NULL,
  api_key_hint    VARCHAR(8)   NOT NULL,
  model_fast      VARCHAR(128) NOT NULL,
  model_quality   VARCHAR(128),
  base_url        TEXT,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','error')),
  last_error      TEXT,
  last_checked_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by      UUID         REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE tenant_ai_config IS
  'Dostawca AI, klucz i modele JEDNEGO tenanta. Brak wiersza = tenant nie
   skonfigurował AI, więc wszystkie funkcje AI są dla niego wyłączone (nie ma
   fallbacku na klucz systemowy — decyzja 2026-10-08).';
COMMENT ON COLUMN tenant_ai_config.api_key IS
  'Klucz API dostawcy, zaszyfrowany AES-256-GCM (src/utils/encrypt.js). NIGDY nie
   wraca z API i nie trafia do logów — na zewnątrz idzie wyłącznie api_key_hint.';
COMMENT ON COLUMN tenant_ai_config.api_key_hint IS
  '4 ostatnie znaki klucza, do pokazania adminowi, że klucz jest zapisany i który
   to klucz. Ten sam wzorzec co ksef_companies.token_hint.';
COMMENT ON COLUMN tenant_ai_config.model_fast IS
  'Model do zadań masowych i tanich: enrichment ICP, analizator rozmów, asystent
   formularzy, tańsze kroki znajdowania konkurencji. Pole tekstowe, nie enum —
   katalogi modeli dostawców zmieniają się częściej niż ten kod, a wpisanie
   nieistniejącego modelu i tak wychodzi przy walidacji klucza przed zapisem.';
COMMENT ON COLUMN tenant_ai_config.model_quality IS
  'Model do długich treści i trudniejszego rozumowania (SEO, droższe kroki).
   NULL = używaj model_fast.';
COMMENT ON COLUMN tenant_ai_config.base_url IS
  'Opcjonalne nadpisanie adresu API — dla dostawców zgodnych z OpenAI stojących
   pod własnym adresem (proxy, self-hosted, Azure). NULL = adres domyślny
   dostawcy z rejestru w src/services/ai/aiProviders.js.';
COMMENT ON COLUMN tenant_ai_config.status IS
  'active — klucz zweryfikowany u dostawcy przy zapisie; invalid — dostawca
   odrzucił klucz (401/403), funkcje AI nie działają do podmiany; error — inny
   błąd (sieć, 5xx, limit), wart ponowienia. Wzorzec jak ksef_companies.status.';

-- Stary, systemowy przełącznik dostawcy dla Prospektów przestaje mieć znaczenie:
-- dostawca jest teraz jeden na tenanta i dotyczy wszystkich funkcji AI, a nie
-- tylko enrichmentu. Zostawiamy go jednak w bazie do czasu wdrożenia, żeby
-- rollback kodu nie zostawił enrichmentu bez żadnego ustawienia dostawcy —
-- usunięcie wiersza to osobna, późniejsza migracja porządkowa.
COMMENT ON COLUMN app_settings.key IS
  'Klucz ustawienia. UWAGA: prospect.ai_provider jest od migracji 0327 NIEUŻYWANY
   — dostawcę AI trzyma tenant_ai_config.provider i obowiązuje on wszystkie
   funkcje AI, nie tylko enrichment. Wiersz zostaje do czasu wdrożenia 0327.';
