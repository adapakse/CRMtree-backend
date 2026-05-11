-- 0171_crm_training_mode.sql
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES
('crm_training_mode',
 'false',
 'Tryb szkoleniowy',
 'Symuluje wysyłkę maili, podpisy dokumentów i połączenia telefoniczne bez rzeczywistych akcji zewnętrznych. Przeznaczony do szkoleń z obsługi CRM.',
 'boolean',
 'general')
ON CONFLICT (key) DO NOTHING;
