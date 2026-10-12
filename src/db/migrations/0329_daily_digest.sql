-- Migration 0329: dzienny raport zadań („digest") — wyłącznik per użytkownik
-- i zamek na dobę dla wielu replik.
--
-- UWAGA CO DO NUMERU: 0326 to etapy leada, 0327 konfiguracja AI, 0328 pola
-- dodatkowe formatek. Przy innej kolejności mergów numer trzeba przenumerować —
-- tak jak przy Yandeksie (commit 185027f7). `_migrations` w bazie jest źródłem
-- prawdy co realnie zaaplikowano.
--
-- PO CO: CRMtree wysyła dziś WYŁĄCZNIE przypomnienia PRZED terminem, jednorazowo
-- (crmReminderService: `reminder_at <= now() AND reminder_sent = false`, potem
-- `reminder_sent = true` i nigdy więcej). Zadanie, które minęło termin i nadal
-- jest otwarte, nie generuje żadnego sygnału — a zadanie bez ustawionego
-- przypomnienia nie generuje go nigdy, bo `reminder_at` jest wtedy NULL.
--
-- Mechanizm przeniesiony z worktrips-doc (followUpService + followUpScheduler),
-- gdzie działa i jest sprawdzony: jeden zbiorczy mail o 09:00 czasu
-- Europe/Warsaw, tylko w dni robocze, z czterema sekcjami — po terminie, na
-- dziś, nieprzeczytane, bez daty. CRMtree dokłada piąte źródło, którego
-- worktrips nie ma: zadania modułu Projekty.
--
-- ZASADY PRZENIESIONE 1:1 (nie zmieniaj ich bez pytania — to decyzje z worktrips):
--   * jeden mail na osobę, nie jeden na zadanie,
--   * tylko osoba PRZYPISANA do zadania; nigdzie nie ma eskalacji do
--     przełożonego ani do PM-a projektu,
--   * pusta lista = mail NIE wychodzi (inaczej ludzie dostają codzienne „nie
--     masz nic do zrobienia" i po tygodniu przestają czytać),
--   * odbiorca może to wyłączyć.

-- ── Wyłącznik per użytkownik ──────────────────────────────────────────────
-- worktrips trzyma to w osobnej tabeli user_notification_prefs. W CRMtree
-- flagi per użytkownik mieszkają na `users` (can_create_projects, is_external,
-- can_view_ksef_invoices), więc zakładanie drugiego miejsca na jedną kolumnę
-- rozjeżdżałoby wzorzec.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN users.digest_enabled IS
  'Czy wysyłać tej osobie dzienny raport zadań (09:00, dni robocze). Domyślnie
   TRUE — raport jest wartością, nie spamem, bo przy pustej liście w ogóle nie
   wychodzi. Wyłączany przez samego użytkownika w Moich ustawieniach.';

-- ── Zamek na dobę ─────────────────────────────────────────────────────────
-- Czego worktrips nie potrzebował: chodzi w jednej instancji, a CRMtree stoi na
-- Container Appsie z wieloma replikami. Bez zamka każda replika wysłałaby ten
-- sam raport, czyli trzy identyczne maile dziennie.
--
-- Nie da się tu użyć wzorca z crmReminderService (UPDATE ... RETURNING na
-- wierszu zadania), bo raport nie ma własnego wiersza do „zaklepania" — zamkiem
-- jest sam fakt wysyłki w danym dniu. Replika, której uda się INSERT, wysyła;
-- pozostałe dostają konflikt i odpuszczają.
--
-- Klucz obejmuje tenant_id, bo raporty lecą per tenant: awaria u jednego nie
-- może zablokować wysyłki u pozostałych.
CREATE TABLE IF NOT EXISTS notification_digest_runs (
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_date    DATE        NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  sent_count  INT         NOT NULL DEFAULT 0,
  error       TEXT,
  PRIMARY KEY (tenant_id, run_date)
);

COMMENT ON TABLE notification_digest_runs IS
  'Jedna wysyłka dziennego raportu na tenanta na dzień. Wiersz powstaje PRZED
   wysyłką i służy jako zamek dla wielu replik backendu (INSERT ... ON CONFLICT
   DO NOTHING — kto wstawi, ten wysyła). Zostaje po wysyłce jako ślad: ile maili
   poszło i czy był błąd.';
COMMENT ON COLUMN notification_digest_runs.finished_at IS
  'NULL przy wierszu, który powstał, ale wysyłka się nie dokończyła — np. replika
   padła w trakcie. Taki dzień nie zostanie powtórzony automatycznie: lepszy
   brak raportu niż jego duplikat u wszystkich, którzy już go dostali.';
