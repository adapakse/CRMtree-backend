-- 0302_seo_enrichment_slots.sql
-- SEObot content upgrade after an external expert review (Adam, 2026-09-28):
-- articles read as generic (the draft never saw what the product actually
-- does), had no screenshots, no first-hand commentary and too few sources.

-- 1. Places in an article that a human SEO editor must fill (expert comment,
--    quote with attribution, product screenshot) or explicitly remove before
--    approval. The body holds a [[SLOT:<id>]] marker line per open slot; this
--    column holds what each slot asks for and the AI's verified suggestion.
ALTER TABLE seo_content_pieces
  ADD COLUMN IF NOT EXISTS enrichment_slots JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2. Per-tenant product screenshot library, tagged by product feature, so
--    the generator can drop a matching screenshot straight into an article.
CREATE TABLE IF NOT EXISTS seo_screenshots (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  blob_path    TEXT NOT NULL,
  feature_tag  VARCHAR(80) NOT NULL,
  caption      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_screenshots_tenant ON seo_screenshots (tenant_id, feature_tag);

-- 3. Product name, so articles can name the product and validation can check
--    they do (tenants.name is the company, e.g. "Comparme", not the product).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS product_name VARCHAR(120);

-- 4. The CRMtree product description from 0206 predates most of the product
--    (AI call analysis, softphone, ICP scoring, churn score, GovAI...). The
--    feature list below follows the product section of crmtree.pl, which Adam
--    named as the source of truth (2026-09-28). Applies to the production
--    blog tenant (comparme) and the local dogfooding tenant (crmtree).
UPDATE tenants
   SET product_name = 'CRMtree',
       business_description =
     'CRMtree to generyczny system CRM dla firm z różnych branż, prowadzący cały cykl wzrostu firmy: '
  || 'od zimnego leada do stałego klienta. Funkcje: '
  || '(1) Prospekty — automatyczne wzbogacanie firm z zimnej bazy (branża, wielkość, dane z GUS/BIR 1.1) '
  || 'i scoring dopasowania do profilu idealnego klienta (ICP) w skali 0-100, żeby handlowiec dzwonił najpierw do najlepiej dopasowanych firm; '
  || '(2) cold calling jednym kliknięciem z wbudowanego softphone''u WebRTC, z nagrywaniem i transkrypcją rozmów; '
  || '(3) Analiza rozmów AI — ocena skłonności do zakupu z notatek lub transkrypcji, wykrywanie sygnałów zakupowych i obiekcji, '
  || 'analiza sentymentu oraz automatyczne oznaczenie follow-upu z datą kontaktu (także dla języka polskiego); '
  || '(4) lejek sprzedażowy (pipeline) z leadami i priorytetami, konwersja leada na klienta; '
  || '(5) dashboard sprzedaży w czasie rzeczywistym i 5 dashboardów analitycznych bez osobnego narzędzia BI, '
  || 'filtry po okresie, partnerze i handlowcu, eksport danych, poranny mail zbiorczy (Daily Digest), integracja z hurtownią danych (DWH); '
  || '(6) zarządzanie partnerami/klientami — historia transakcji, dokumenty i opiekun na jednej karcie, raporty wyników klienta; '
  || '(7) Health Score i Churn Score — wykrywanie klientów uśpionych i zagrożonych odejściem; '
  || '(8) budżety i cele roczne/miesięczne per handlowiec, automatycznie porównywane z wykonaniem; '
  || '(9) komunikacja wielokanałowa — e-mail (Gmail, Outlook, Zoho, synchronizacja w czasie rzeczywistym, śledzenie odczytania), '
  || 'WhatsApp Business (jeden firmowy numer dla zespołu) i telefon widoczne przy karcie leada i partnera; '
  || '(10) dokumenty i workflow — obieg podpisów i akceptacji przy karcie partnera, widać na czyim etapie utknął dokument; '
  || '(11) onboarding klienta krok po kroku z zadaniami i terminami; '
  || '(12) SEObot — AI pisze i planuje artykuły SEO i mierzy efekt w Google Search Console; '
  || '(13) aplikacja mobilna z leadami, partnerami, zadaniami i powiadomieniami push; '
  || '(14) bezpieczeństwo — pełna izolacja danych każdej firmy, role i uprawnienia (RBAC), logowanie SSO/SAML, '
  || 'serwery Microsoft Azure w regionie Polska Centralna, zgodność z RODO, możliwa dedykowana infrastruktura lub on-premise; '
  || '(15) zgodność z AI Act — funkcje AI (analiza rozmów, Prospekty, SEObot) działają przez bramkę zgodności GovAI: '
  || 'klasyfikacja ryzyka każdego wywołania AI (art. 5, Aneks III, art. 50 AI Act), skanowanie danych osobowych, '
  || 'nadzór człowieka nad wywołaniami wymagającymi przeglądu i niezmienny dziennik audytowy. '
  || 'Model cenowy bez limitu stanowisk, wdrożenie bez integracji IT (import CSV), 14 dni darmowego testu. '
  || 'Odbiorcy: menedżerowie sprzedaży, właściciele firm, zespoły handlowe i obsługi klienta.'
 WHERE id IN ('1e610ab7-1f34-427f-bd05-b4094b8077c7', '4a299a1b-9e33-43d7-b649-ead5a17d61fc');

-- 5. New "AI w CRM" pillar (Adam, 2026-09-28) for the same two tenants. The
--    generator always picks the least-covered pillar first, so it gets the
--    next articles without any extra scheduling logic.
INSERT INTO seo_content_pillars (tenant_id, name, description, target_keyword_theme, priority, slug)
SELECT t.id,
       'AI w CRM',
       'Jak sztuczna inteligencja działa w konkretnych funkcjach CRM: analiza rozmów handlowych i skłonności do zakupu, '
       || 'lead scoring i scoring ICP, wykrywanie ryzyka odejścia klienta (churn), automatyczne follow-upy, AI w content marketingu '
       || 'oraz zgodność tych funkcji z AI Act. Dla menedżerów sprzedaży, którzy chcą wiedzieć, co AI realnie robi w codziennej pracy handlowca.',
       'AI w CRM, analiza rozmów AI, lead scoring, scoring ICP, churn score, automatyzacja sprzedaży AI, AI Act w CRM',
       COALESCE((SELECT MAX(priority) + 1 FROM seo_content_pillars p WHERE p.tenant_id = t.id), 0),
       'ai-w-crm'
  FROM tenants t
 WHERE t.id IN ('1e610ab7-1f34-427f-bd05-b4094b8077c7', '4a299a1b-9e33-43d7-b649-ead5a17d61fc')
   AND NOT EXISTS (
     SELECT 1 FROM seo_content_pillars p WHERE p.tenant_id = t.id AND (p.slug = 'ai-w-crm' OR p.name = 'AI w CRM')
   );
