-- 0127_seed_group_profiles.sql
-- Opcjonalny seed grup użytkowników — analogiczne do środowiska deweloperskiego.
-- Uruchom na środowisku produkcyjnym jeśli group_profiles jest puste.
-- Bezpieczne do uruchomienia wielokrotnie (ON CONFLICT DO NOTHING).

INSERT INTO group_profiles (name, display_name, description, has_owner_restriction, is_active)
VALUES
  ('Accounting',      'Accounting',      'Dział finansów i księgowości',   false, true),
  ('HR',              'HR',              'Dział kadr i zasobów ludzkich',  false, true),
  ('Marketing',       'Marketing',       'Dział marketingu',               false, true),
  ('Obsługa Klienta', 'Obsługa Klienta', 'Dział obsługi klienta',          false, true),
  ('Operations',      'Operations',      'Dział operacyjny',               false, true),
  ('Sprzedaz',        'Sprzedaż',        'Dział sprzedaży',                false, true),
  ('Zarzad',          'Zarząd',          'Zarząd firmy',                   true,  true)
ON CONFLICT (name) DO NOTHING;
