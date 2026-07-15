-- 0206_seo_crmtree_business_description_v2.sql
-- Faza 1 (SEObot): richer business_description for CRMtree's own dogfooding
-- tenant, generalized from the xCRM business spec (Adam, 2026-07-15) — keeps
-- the fuller feature set (documents/workflow, DWH-based reporting, Gmail +
-- WhatsApp, onboarding, roles/groups, SSO) but drops the travel-specific
-- product dictionary from that spec, since CRMtree is explicitly positioned
-- as industry-agnostic (see CLAUDE.md project notes).
--
-- Replaces the short v1 description seeded in 0205. Also replaces the 8
-- pillars generated from v1 with 7 pillars regenerated from this richer
-- description (Claude Sonnet 5, run once by hand — hardcoded here so fresh
-- environments don't need a live LLM call during migration).

UPDATE tenants
   SET business_description =
     'CRMtree to generyczny system CRM dla przedsiębiorstw z różnych branż (nie tylko turystyki), '
     || 'łączący trzy obszary: sprzedaż (leady, pipeline, konwersja na klientów, aktywności handlowców), '
     || 'zarządzanie dokumentami i umowami (wersjonowanie, obieg podpisów i zatwierdzeń, alerty wygaśnięcia) '
     || 'oraz raportowanie i analitykę sprzedaży oparte na danych (KPI: pipeline, win rate, average cycle, '
     || 'źródła leadów). Komunikacja z klientami odbywa się bezpośrednio w CRM dzięki integracji z Gmail '
     || 'i WhatsApp (wysyłka, odbiór, historia konwersacji przypisana do leada/klienta). System wspiera też '
     || 'ustrukturyzowany onboarding nowych klientów z zadaniami i terminami, role i grupy użytkowników '
     || '(np. region/dział) do kontroli dostępu, oraz logowanie SSO przez Google Workspace. Odbiorcy: '
     || 'menedżerowie sprzedaży, właściciele firm, zespoły handlowe i operacyjne szukające jednego narzędzia '
     || 'do zarządzania leadami, klientami, dokumentami, zadaniami i raportowaniem.'
 WHERE id = '4a299a1b-9e33-43d7-b649-ead5a17d61fc';

DELETE FROM seo_content_pillars WHERE tenant_id = '4a299a1b-9e33-43d7-b649-ead5a17d61fc';

INSERT INTO seo_content_pillars (tenant_id, name, description, target_keyword_theme, priority) VALUES
('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'Zarządzanie sprzedażą i pipeline',
 'Praktyczne treści o zarządzaniu leadami, etapami pipeline''u, konwersją na klientów i codziennej pracy handlowców. Kluczowe dla menedżerów sprzedaży szukających sposobów na zwiększenie efektywności zespołu.',
 'zarządzanie leadami, pipeline sprzedażowy, konwersja leadów, CRM dla handlowców', 0),
('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'Zarządzanie dokumentami i umowami w CRM',
 'Artykuły o obiegu dokumentów, wersjonowaniu, elektronicznym podpisywaniu umów i automatycznych alertach o wygasających kontraktach. Odpowiada na potrzeby firm chcących ucywilizować pracę z dokumentacją klientów.',
 'obieg dokumentów, elektroniczny podpis, wersjonowanie umów, alerty wygaśnięcia umów', 1),
('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'Raportowanie i analityka sprzedaży',
 'Treści dotyczące budowania dashboardów, śledzenia KPI (win rate, average cycle, źródła leadów) i podejmowania decyzji na podstawie danych sprzedażowych. Kluczowe dla właścicieli firm i menedżerów analizujących wyniki zespołów.',
 'raportowanie sprzedaży, KPI sprzedażowe, win rate, analiza pipeline', 2),
('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'Komunikacja z klientami w CRM (Gmail, WhatsApp)',
 'Poradniki o integracji CRM z Gmail i WhatsApp, centralizacji historii konwersacji i utrzymywaniu kontekstu komunikacji przypisanego do leada lub klienta. Ważne dla zespołów chcących uniknąć rozproszenia informacji między kanałami.',
 'integracja CRM z Gmail, CRM WhatsApp, historia komunikacji z klientem', 3),
('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'Onboarding klientów i zarządzanie zadaniami',
 'Treści o budowaniu ustrukturyzowanych procesów wdrażania nowych klientów, przypisywaniu zadań, terminów i odpowiedzialności. Przydatne dla zespołów operacyjnych dbających o jakość obsługi po sprzedaży.',
 'onboarding klienta, zarządzanie zadaniami, proces wdrożenia klienta', 4),
('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'Bezpieczeństwo, role i kontrola dostępu w CRM',
 'Artykuły o zarządzaniu rolami użytkowników, grupami działowymi/regionalnymi, logowaniu SSO przez Google Workspace i bezpieczeństwie danych firmowych. Istotne dla firm z rozproszonymi zespołami i wymogami zgodności.',
 'role użytkowników CRM, SSO Google Workspace, kontrola dostępu, bezpieczeństwo danych CRM', 5),
('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'Wybór i wdrożenie generycznego CRM dla firm',
 'Treści porównawcze i poradnikowe pomagające firmom z różnych branż wybrać, wdrożyć i skalować uniwersalny system CRM zamiast rozwiązań niszowych. Kluczowe dla decydentów oceniających narzędzia na etapie zakupu.',
 'wybór systemu CRM, wdrożenie CRM w firmie, CRM dla różnych branż', 6);
