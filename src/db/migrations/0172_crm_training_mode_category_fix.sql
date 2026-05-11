-- 0172_crm_training_mode_category_fix.sql
-- Przesuwa ustawienie trybu szkoleniowego do kategorii 'general' (zakładka Parametry globalne).
UPDATE app_settings
SET category = 'general'
WHERE key = 'crm_training_mode';
