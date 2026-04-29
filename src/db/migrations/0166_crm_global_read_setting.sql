-- Dodaje ustawienie "Globalny dostęp do odczytu CRM".
-- Gdy włączone, wszyscy użytkownicy z rolą CRM (salesperson i sales_manager)
-- mogą przeglądać wszystkie Leady, Partnerów, Raporty Sprzedaży i Performance
-- niezależnie od przypisania. Uprawnienia do zapisu (edycja/tworzenie) pozostają niezmienione.

INSERT INTO app_settings (key, value, label, description, value_type, category)
VALUES (
  'crm_global_read',
  'false',
  'Globalny odczyt CRM',
  'Gdy włączone, wszyscy użytkownicy CRM mogą przeglądać Leady, Partnerów, Raporty Sprzedaży i Performance bez ograniczeń widoczności. Uprawnienia do edycji pozostają bez zmian.',
  'boolean',
  'crm'
) ON CONFLICT (key) DO NOTHING;
