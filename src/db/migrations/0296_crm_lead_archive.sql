-- Etap "Archiwum" dla leadów (crm_leads) — dostępny z każdego etapu przez
-- dedykowaną akcję "Archiwizuj" (PUT /:id/archive), niewidoczny domyślnie na
-- żadnej liście/dashboardzie/raporcie (patrz zmiany w crm-leads.js/crm-dashboard.js),
-- widoczny tylko po jawnym wybraniu filtra Etap = Archiwum. Wyjście z Archiwum
-- wyłącznie do etapu 'new' (przez zwykły PATCH), analogicznie do closed_lost→new.
-- Port z worktrips (migracja 0257 tam).
--
-- 'archived' celowo NIE jest wartością do swobodnego wyboru w formularzu edycji —
-- ustawia ją wyłącznie backend w akcji Archiwizuj.

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id);
