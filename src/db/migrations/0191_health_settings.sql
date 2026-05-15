-- Migration 0191: Health Score algorithm settings
-- Parametry algorytmu Health Score — konfigurowalne przez admina w app_settings.
-- Wstawiane dla każdego istniejącego tenanta.

INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
SELECT t.id, s.key, s.value, s.label, s.description, s.value_type, s.category
FROM tenants t
CROSS JOIN (VALUES
  ('health_act_t1_max_days',   '20', 'Health: max dni dla T1 aktywności',      'Ostatnie zamówienie w ciągu N dni → T1 punkty',       'number', 'crm'),
  ('health_act_t1_pts',        '10', 'Health: punkty T1 aktywności',            'Punkty za 1 zamówienie do X dni temu',                'number', 'crm'),
  ('health_act_t2_min_days',    '5', 'Health: min dni T2 aktywności',           'Min. dni temu dla okna T2 (5-10 dni)',                 'number', 'crm'),
  ('health_act_t2_max_days',   '10', 'Health: max dni T2 aktywności',           'Max. dni temu dla okna T2',                           'number', 'crm'),
  ('health_act_t2_pts',        '20', 'Health: punkty T2 aktywności',            'Punkty za 1 zamówienie w oknie 5-10 dni',             'number', 'crm'),
  ('health_act_t3_min_orders',  '2', 'Health: min zamówień T3 aktywności',      'Min. zamówień w 20d dla progu T3',                    'number', 'crm'),
  ('health_act_t4_min_orders',  '5', 'Health: min zamówień T4 aktywności',      '>N zamówień w 20d → T4 (max tier)',                   'number', 'crm'),
  ('health_act_t3_pts',        '30', 'Health: punkty T3 aktywności',            'Punkty za 2–5 zamówień w 20 dniach',                  'number', 'crm'),
  ('health_act_t4_pts',        '50', 'Health: punkty T4 aktywności',            'Punkty za >5 zamówień w 20 dniach',                   'number', 'crm'),
  ('health_rev_t1_pct',        '20', 'Health: wzrost T1 %',                     'Min. % wzrostu M-2→M-1 dla T1',                       'number', 'crm'),
  ('health_rev_t1_pts',        '20', 'Health: punkty T1 wzrostu',               'Punkty za wzrost ≥20%',                               'number', 'crm'),
  ('health_rev_t2_pct',        '30', 'Health: wzrost T2 %',                     'Min. % wzrostu M-2→M-1 dla T2',                       'number', 'crm'),
  ('health_rev_t2_pts',        '30', 'Health: punkty T2 wzrostu',               'Punkty za wzrost ≥30%',                               'number', 'crm'),
  ('health_rev_t3_pct',        '41', 'Health: wzrost T3 %',                     'Min. % wzrostu M-2→M-1 dla T3',                       'number', 'crm'),
  ('health_rev_t3_pts',        '40', 'Health: punkty T3 wzrostu',               'Punkty za wzrost ≥41%',                               'number', 'crm'),
  ('health_rev_t4_pct',        '51', 'Health: wzrost T4 %',                     'Min. % wzrostu M-2→M-1 dla T4',                       'number', 'crm'),
  ('health_rev_t4_pts',        '50', 'Health: punkty T4 wzrostu',               'Punkty za wzrost >50%',                               'number', 'crm'),
  ('health_good_min',          '61', 'Health: próg Zdrowy',                     'Min. punktów dla statusu Zdrowy',                     'number', 'crm'),
  ('health_warn_min',          '21', 'Health: próg Uwaga',                      'Min. punktów dla statusu Uwaga (poniżej = Ryzyko)',    'number', 'crm')
) AS s(key, value, label, description, value_type, category)
ON CONFLICT (tenant_id, key) DO NOTHING;
