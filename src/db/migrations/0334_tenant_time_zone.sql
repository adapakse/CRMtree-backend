-- Migration 0334: strefa czasowa firmy (IANA, np. 'Asia/Bishkek').
-- Maile z przypomnieniem/przypisaniem zadania drukowały godzinę w strefie
-- procesu serwera (UTC w kontenerze), więc klient widział inną godzinę niż
-- w CRM. Teraz godzina idzie w strefie firmy. Domyślnie Warszawa — dla
-- obecnych firm jedyna zmiana to poprawiona godzina w mailu.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'Europe/Warsaw';
