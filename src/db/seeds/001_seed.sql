-- ============================================================
-- worktrips.doc — Seed 001: Default Groups & Admin User
-- ============================================================

-- Default group profiles (matching functional requirements)
INSERT INTO group_profiles (name, display_name, description, has_owner_restriction) VALUES
  ('Marketing',   'Marketing',   'Marketing department',                  FALSE),
  ('Sprzedaz',    'Sprzedaż',    'Sales department — owner restriction',  TRUE),
  ('HR',          'HR',          'Human Resources',                       FALSE),
  ('Accounting',  'Accounting',  'Finance & Accounting',                  FALSE),
  ('Operations',  'Operations',  'Operations & Logistics',                FALSE),
  ('Zarzad',      'Zarząd',      'Management Board',                      FALSE)
ON CONFLICT (name) DO NOTHING;

-- Seed year counter
INSERT INTO doc_number_seq (year, last_n) VALUES (EXTRACT(YEAR FROM NOW())::SMALLINT, 0)
ON CONFLICT (year) DO NOTHING;
