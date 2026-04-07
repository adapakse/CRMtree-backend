-- 0121_doc_entity1_options.sql
-- Dodaje słownik opcji dla pola Entity 1 w dokumentach

INSERT INTO app_settings (key, value, label, description, value_type, category)
VALUES (
  'doc_entity1_options',
  '["Worktrips Sp. z o.o.","Travel Manager Sp. z o.o."]',
  'Podmiot 1 – opcje słownika',
  'Lista podmiotów dostępnych w polu Entity 1 dokumentu. Edytuj przez dodawanie / usuwanie wartości.',
  'json',
  'documents'
)
ON CONFLICT (key) DO NOTHING;
