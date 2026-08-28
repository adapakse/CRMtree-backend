-- Dodaje przypomnienia + priorytet do aktywności CRM (lead i partner), port 1:1
-- z worktrips (0185_crm_activity_reminder.sql).
--
-- reminder_type  — kiedy wysłać przypomnienie ('at_due','1d_before','2d_before',
--                  '3d_before','custom'; NULL = brak przypomnienia)
-- reminder_at    — wyliczona data/godzina wysyłki maila (NULL = brak przypomnienia)
-- reminder_sent  — czy mail już wysłany (job przypomnień jeszcze nie istnieje w
--                  CRMtree — to kolumna pod przyszłe użycie, patrz TODO w
--                  callAnalysisService.js)
-- priority       — 'low'/'medium'/'high', ustawiane ręcznie lub przez Analizator
--                  Rozmów przy tworzeniu zadania follow-up
--
-- Uwaga: crm_partner_activities miała już reminder_type/reminder_at/priority
-- lokalnie na tej maszynie (migracja aplikowana ręcznie, nigdy niescommitowana
-- do repo — stąd rozjazd między lokalną bazą a resztą środowisk). Ta migracja
-- porządkuje to na stałe (IF NOT EXISTS — bezpieczna zarówno tam, gdzie kolumny
-- już są, jak i tam gdzie ich nigdy nie było, np. INT/PROD) i dokłada brakujące
-- reminder_sent + te same kolumny na crm_lead_activities, które ich w ogóle
-- nie miała.

ALTER TABLE crm_lead_activities
  ADD COLUMN IF NOT EXISTS reminder_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS reminder_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priority      VARCHAR(20);

ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS reminder_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS reminder_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priority      VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_lead_act_reminder
  ON crm_lead_activities (reminder_at)
  WHERE reminder_sent = false AND reminder_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_part_act_reminder
  ON crm_partner_activities (reminder_at)
  WHERE reminder_sent = false AND reminder_at IS NOT NULL;
