-- Słownik powodów przegranej leada (zarządzany przez admina w AppSettings)
INSERT INTO app_settings (key, value, value_type, label, description, category)
VALUES (
  'crm_lost_reasons',
  '["Wysoka cena","Niepełna oferta","Inne"]',
  'json',
  'Powody przegranej leada',
  'Lista powodów przegranej. Wyświetlana jako lista wyboru w polu "Powód przegranej" przy zmianie etapu leada na Przegrany.',
  'crm'
)
ON CONFLICT (key) DO NOTHING;
