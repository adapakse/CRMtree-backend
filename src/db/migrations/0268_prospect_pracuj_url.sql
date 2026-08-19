-- Ręczny link do listy ofert pracy firmy na Pracuj.pl (decyzja 19.08.2026) —
-- automatyczne wyszukiwanie ofert po nazwie firmy nie działa niezawodnie
-- (Pracuj.pl nie ma prostego filtra po pracodawcy), więc zamiast tego
-- pozwalamy wkleić link ręcznie, analogicznie do linkedin_url/linkedin_status.
ALTER TABLE prospect_companies
  ADD COLUMN pracuj_url    VARCHAR(500),
  ADD COLUMN pracuj_status VARCHAR(20);  -- 'ok' | 'not_found'
