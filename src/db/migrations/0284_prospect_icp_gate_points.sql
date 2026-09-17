-- 0284_prospect_icp_gate_points.sql
-- Bramki (B2B, wielkość firmy) zaczynają liczyć się do icp_score — 10 pkt za
-- każdą bramkę ze statusem "pass" (decyzja 2026-09-17). Dotąd bramki służyły
-- wyłącznie do wyliczenia icp_gate_status (qualified/disqualified/needs_review),
-- nie wpływały na sam wynik punktowy. Ta kolumna przechowuje breakdown analogiczny
-- do icp_bonus_signals, żeby frontend mógł pokazać "+10" per bramka bez
-- powtarzania formuły scoringu (patrz calcScoreBreakdown w admin-prospects.component.ts).

ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS icp_gate_points JSONB;

COMMENT ON COLUMN prospect_companies.icp_gate_points IS
  'Breakdown punktów z bramek: [{id, label, points, hit}], analogicznie do
   icp_bonus_signals. hit=true gdy odpowiadająca bramka w icp_gates ma status
   "pass" — wtedy points (10) wlicza się do icp_score. NULL dla rekordów
   wzbogaconych przed wprowadzeniem tej kolumny (stare score NIE jest
   przeliczane retroaktywnie — wymaga ręcznego re-enrichmentu).';
