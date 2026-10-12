-- Migration 0326: konfigurowalne etapy leada per tenant.
--
-- PO CO: do dziś etapy leada były zahardkodowane w crm-leads.js (isIn([...]),
-- STAGE_SEQ/STAGE_LABELS/allowedNext, HOLD_STAGES) i w komponentach frontendu
-- (KANBAN_STAGES, PROB_MAP, ręcznie wypisane <option>, klasy CSS .stage-*).
-- Tenant nie mógł nawet zmienić NAZWY etapu — a to główna realna potrzeba
-- („Wygrana" nazywa się u klienta inaczej).
--
-- KLUCZOWA DECYZJA — `key` jest niezmienny, `label` edytowalny (ten sam wzorzec
-- co tenant_icp_signals, migracja 0285). `key` to wartość zapisywana w
-- crm_leads.stage i używana w SQL raportów, dashboardów, Holdu i konwersji na
-- partnera. Dzięki rozdzieleniu key/label zmiana nazwy etapu NIE rusza ani
-- jednego zapytania raportowego i nie migruje żadnych danych leadów — zmienia
-- się wyłącznie to, co widzi user.
--
-- label = NULL oznacza „użyj wbudowanego tłumaczenia dla tego key"
-- (crm.labels.stages.<key> w 10 językach). Dopiero gdy admin wpisze własną
-- nazwę, label przestaje być NULL i wygrywa we WSZYSTKICH językach — zgodnie z
-- zasadą projektu „danych wpisanych przez tenanta nie tłumaczymy". Wyczyszczenie
-- pola wraca do NULL, czyli do tłumaczeń.
--
-- NIE MA pojęcia etapu „systemowego". Wszystko, co jest krokiem lejka albo
-- zamknięciem — włącznie z Wygraną i Przegraną — admin może usunąć, przemianować
-- i przestawić. Tenant, który nie rozlicza wygranych, po prostu nie ma etapu
-- `won`; metryki oparte na nim (win rate, wartość wygrana, długość cyklu) znikają
-- wtedy z ekranów, zamiast pokazywać zero, bo zero byłoby nieprawdą.
--
-- `kind` mówi, CZYM etap jest, a nie czy wolno go tknąć:
--   open      — krok lejka. Dodawaj, usuwaj, przestawiaj, zmieniaj nazwę.
--   won/lost  — zamknięcie. Też w pełni usuwalne.
--   converted — stan ustawiany PRZEZ KOD przy konwersji leada na partnera
--               (crm-partners.js: UPDATE crm_leads SET stage='onboarded').
--   archived  — stan ustawiany PRZEZ KOD przy archiwizacji leada.
--
-- Granice są strukturalne, nie uznaniowe, i są dokładnie trzy (egzekwowane w
-- leadStageService.js, nie w bazie):
--   1. Lejek musi mieć co najmniej jeden etap `open` — lead musi gdzieś powstać.
--   2. `converted` i `archived` są nieusuwalne, bo to nie kroki lejka, których
--      ktoś nie chce, a stany, które aplikacja zapisuje sama. Nazwę i im można
--      zmienić.
--   3. Najwyżej jeden etap `won` i jeden `lost` — nowe etapy powstają zawsze jako
--      `open`, więc nie da się tego naruszyć.

CREATE TABLE IF NOT EXISTS tenant_lead_stages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         VARCHAR(60) NOT NULL,
  label       VARCHAR(80),
  kind        VARCHAR(16) NOT NULL CHECK (kind IN ('open','won','lost','converted','archived')),
  probability INT         CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100)),
  color       VARCHAR(7),
  active      BOOLEAN     NOT NULL DEFAULT true,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_lead_stages_tenant
  ON tenant_lead_stages(tenant_id, sort_order);

COMMENT ON COLUMN tenant_lead_stages.key IS
  'Niezmienny kod etapu — dokładnie ta wartość leży w crm_leads.stage i w
   audit_logs.after_state->>''stage''. NIGDY nie zmieniany po utworzeniu (w
   przeciwieństwie do label). Dla etapów customowych: slug z nazwy + deduplikacja,
   nadawany raz przy tworzeniu.';
COMMENT ON COLUMN tenant_lead_stages.label IS
  'Własna nazwa tenanta. NULL = użyj wbudowanego tłumaczenia crm.labels.stages.<key>
   (10 języków). Wpisana nazwa wygrywa w każdym języku — danych tenanta nie tłumaczymy.';
COMMENT ON COLUMN tenant_lead_stages.kind IS
  'Czym etap JEST, nie czy wolno go zmieniać: open = krok lejka, won/lost =
   zamknięcie (oba w pełni usuwalne), converted/archived = stany zapisywane przez
   kod (konwersja na partnera, archiwizacja) — nieusuwalne, bo nie są krokami
   lejka, ale z edytowalną nazwą. Patrz leadStageService.js.';
COMMENT ON COLUMN tenant_lead_stages.probability IS
  'Domyślne prawdopodobieństwo wygranej dla leada na tym etapie (pasek postępu na
   kanbanie i wartość ważona). Lead z własną probability ma ją ważniejszą.
   NULL = 10, tak jak dotychczasowy fallback PROB_MAP we frontendzie. Admin tego
   nie wpisuje — dla nowego etapu backend liczy to z jego pozycji w lejku.';

-- ── SEED: dotychczasowy, zahardkodowany lejek jako punkt startowy KAŻDEGO
-- tenanta. Kody, kolejność, prawdopodobieństwa i kolory 1:1 z KANBAN_STAGES /
-- PROB_MAP / klas .stage-* we frontendzie oraz STAGE_SEQ w crm-leads.js —
-- zero zmiany zachowania w dniu wdrożenia. ─────────────────────────────────
INSERT INTO tenant_lead_stages (tenant_id, key, kind, probability, color, sort_order)
SELECT t.id, v.key, v.kind, v.probability, v.color, v.sort_order
FROM tenants t
CROSS JOIN (VALUES
  ('new',           'open',       10, '#94A3B8', 1),
  ('qualification', 'open',       25, '#F59E0B', 2),
  ('presentation',  'open',       50, '#3B82F6', 3),
  ('offer',         'open',       70, '#A855F7', 4),
  ('negotiation',   'open',       85, '#F97316', 5),
  ('closed_won',    'won',       100, '#22C55E', 6),
  ('closed_lost',   'lost',        0, '#EF4444', 7),
  ('onboarding',    'converted', 100, '#15803D', 8),
  ('onboarded',     'converted', 100, '#15803D', 9),
  ('archived',      'archived',    0, '#9CA3AF', 10)
) AS v(key, kind, probability, color, sort_order)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ── Usuń martwy słownik app_settings.crm_lead_stages ───────────────────────
-- Ten wiersz (migracja 0116) renderował się w Ustawieniach → Parametry
-- biznesowe CRM jako w pełni działający edytor listy „Etapy Leada" — z
-- przyciskiem usuwania i dodawaniem pozycji — ale NIC w aplikacji go nie
-- czytało: walidacja etapów siedziała na sztywno w crm-leads.js. Admin mógł
-- tam „usunąć" etap Wygrana i nie działo się nic. Migracja 0156 próbowała
-- zresztą dopisać do niego etap 'onboarded' pod kluczem 'lead_stages' —
-- literówka, klucz nazywa się 'crm_lead_stages', więc ten UPDATE też nigdy nic
-- nie zmienił. Od teraz jedynym źródłem prawdy jest tenant_lead_stages.
DELETE FROM app_settings WHERE key = 'crm_lead_stages';
