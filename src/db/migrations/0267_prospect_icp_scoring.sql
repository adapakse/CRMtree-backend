-- Podmiana silnika scoringu Prospektów: z "potencjału podróży służbowych"
-- (pozostałość po worktrips, patrz travel_* kolumny) na prawdziwy scoring
-- dopasowania do ICP CRMtree (8 sygnałów + 2 bramki + bonusy), decyzja 19.08.2026.
-- Dane w starych travel_* kolumnach nie są migrowane — to inny, niezwiązany
-- model, a INT nie ma jeszcze realnych danych klienckich opartych o te wyniki.

ALTER TABLE prospect_companies
  DROP COLUMN IF EXISTS travel_potential_score,
  DROP COLUMN IF EXISTS travel_signals,
  DROP COLUMN IF EXISTS travel_scope,
  DROP COLUMN IF EXISTS field_teams_likely;

ALTER TABLE prospect_companies
  ADD COLUMN icp_score          INT,           -- 0-100, wagi+bonus, patrz calcIcpScore()
  ADD COLUMN icp_signals        JSONB,         -- breakdown 8 sygnałów: {id, label, tier, points, hit}[]
  ADD COLUMN icp_gates          JSONB,         -- {b2b: pass|fail|unknown, company_size: pass|fail|unknown}
  ADD COLUMN icp_gate_status    VARCHAR(20),   -- 'qualified' | 'disqualified' | 'needs_review'
  ADD COLUMN icp_bonus_signals  JSONB,         -- WhatsApp/CRM wykryte na stronie: {id, label, points, hit}[]
  ADD COLUMN icp_downgrade_flags JSONB;        -- miękkie obniżenia priorytetu: brak https, martwa strona

CREATE INDEX idx_prospect_companies_icp_score  ON prospect_companies(icp_score);
CREATE INDEX idx_prospect_companies_gate_status ON prospect_companies(icp_gate_status);
