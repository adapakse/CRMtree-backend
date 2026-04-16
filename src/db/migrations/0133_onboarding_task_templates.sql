-- 0133_onboarding_task_templates.sql
-- Dodaje kolumnę due_time do crm_onboarding_tasks (godzina wykonania, opcjonalna).
-- Dodaje klucz onboarding_task_templates do app_settings z domyślnymi szablonami.

-- Kolumna godziny wykonania (opcjonalna, brak = 09:00)
ALTER TABLE crm_onboarding_tasks
  ADD COLUMN IF NOT EXISTS due_time TIME DEFAULT NULL;

COMMENT ON COLUMN crm_onboarding_tasks.due_time IS
  'Godzina wykonania zadania. NULL = brak określonej godziny (domyślnie 09:00 w widoku)';

-- Szablony zadań onboardingowych (konfigurowane przez admina w AppSettings)
-- Kroki: 0=Umowy, 1=Konfiguracja, 2=Szkolenie, 3=Uruchomienie
INSERT INTO app_settings (key, value, value_type, label, description, category)
VALUES (
  'onboarding_task_templates',
  '[
    {"id":"umowa_wysylka","title":"Wysyłka umowy do podpisu","type":"doc_sent","step":0},
    {"id":"umowa_podpis","title":"Podpisanie umowy","type":"doc_sent","step":0},
    {"id":"umowa_zwrot","title":"Odbiór podpisanej umowy","type":"doc_sent","step":0},
    {"id":"config_konto","title":"Konfiguracja konta w systemie","type":"task","step":1},
    {"id":"config_integracja","title":"Integracja z systemem partnera","type":"task","step":1},
    {"id":"config_test","title":"Testy konfiguracji","type":"call","step":1},
    {"id":"szkolenie_plan","title":"Ustalenie planu szkolenia","type":"meeting","step":2},
    {"id":"szkolenie_exec","title":"Przeprowadzenie szkolenia","type":"training","step":2},
    {"id":"szkolenie_followup","title":"Follow-up po szkoleniu","type":"call","step":2},
    {"id":"launch_go_live","title":"Uruchomienie produkcyjne","type":"task","step":3},
    {"id":"launch_check","title":"Weryfikacja działania systemu","type":"task","step":3},
    {"id":"launch_handover","title":"Przekazanie do obsługi klienta","type":"meeting","step":3}
  ]',
  'json',
  'Szablony zadań onboardingowych',
  'Definicje standardowych zadań dla każdego kroku procesu wdrożenia. Atrybuty: id, title, type (task/call/email/meeting/doc_sent/training), step (0-3).',
  'crm'
)
ON CONFLICT (key) DO NOTHING;
