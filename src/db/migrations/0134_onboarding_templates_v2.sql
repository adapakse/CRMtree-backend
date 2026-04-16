-- 0134_onboarding_templates_v2.sql
-- Aktualizuje szablony zadań onboardingowych w app_settings o nowe atrybuty:
--   standard  (bool) — czy zadanie tworzy się automatycznie przy migracji leada
--   assignee  (uuid) — UUID usera przypisanego automatycznie (null = brak, krok 0 = handlowiec leada)
--   days      (int)  — ile dni od daty migracji ustawić jako termin (null = brak terminu)

UPDATE app_settings
SET
  value = '[{"id":"umowa_wysylka","title":"Wysylka umowy do podpisu","type":"doc_sent","step":0,"standard":true,"assignee":null,"days":0},{"id":"umowa_podpis","title":"Podpisanie umowy","type":"doc_sent","step":0,"standard":true,"assignee":null,"days":3},{"id":"umowa_zwrot","title":"Odbior podpisanej umowy","type":"doc_sent","step":0,"standard":true,"assignee":null,"days":7},{"id":"config_konto","title":"Konfiguracja konta w systemie","type":"task","step":1,"standard":true,"assignee":null,"days":7},{"id":"config_integr","title":"Integracja z systemem partnera","type":"task","step":1,"standard":false,"assignee":null,"days":null},{"id":"config_test","title":"Testy konfiguracji","type":"call","step":1,"standard":true,"assignee":null,"days":10},{"id":"szkolenie_plan","title":"Ustalenie planu szkolenia","type":"meeting","step":2,"standard":true,"assignee":null,"days":10},{"id":"szkolenie_exec","title":"Przeprowadzenie szkolenia","type":"training","step":2,"standard":true,"assignee":null,"days":14},{"id":"szkolenie_follow","title":"Follow-up po szkoleniu","type":"call","step":2,"standard":false,"assignee":null,"days":null},{"id":"launch_go_live","title":"Uruchomienie produkcyjne","type":"task","step":3,"standard":true,"assignee":null,"days":21},{"id":"launch_check","title":"Weryfikacja dzialania systemu","type":"task","step":3,"standard":true,"assignee":null,"days":21},{"id":"launch_handover","title":"Przekazanie do obslugi klienta","type":"meeting","step":3,"standard":true,"assignee":null,"days":28}]',
  description = 'Definicje zadan dla kazdego kroku wdrozenia. Atrybuty: id, title, type, step, standard (auto-dodaj przy migracji), assignee (UUID usera lub null), days (dni od migracji lub null).',
  updated_at  = now()
WHERE key = 'onboarding_task_templates';
