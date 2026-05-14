-- Migration 0190: Churn analytics algorithm settings
-- Parametry algorytmu churn — konfigurowalne przez admina w app_settings.
-- Wstawiane dla każdego istniejącego tenanta.

INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
SELECT t.id, s.key, s.value, s.label, s.description, s.value_type, s.category
FROM tenants t
CROSS JOIN (VALUES
  ('churn_days_t1_min', '10',  'Churn: próg 1 dni — min',          'Min. dni bez zamówienia dla progu 1',                        'number', 'crm'),
  ('churn_days_t1_max', '20',  'Churn: próg 1 dni — max',          'Max. dni bez zamówienia dla progu 1',                        'number', 'crm'),
  ('churn_days_t1_pts', '10',  'Churn: punkty za próg 1 dni',      'Punkty za 10–20 dni bez zamówienia',                         'number', 'crm'),
  ('churn_days_t2_min', '21',  'Churn: próg 2 dni — min',          'Min. dni bez zamówienia dla progu 2',                        'number', 'crm'),
  ('churn_days_t2_max', '30',  'Churn: próg 2 dni — max',          'Max. dni bez zamówienia dla progu 2',                        'number', 'crm'),
  ('churn_days_t2_pts', '20',  'Churn: punkty za próg 2 dni',      'Punkty za 21–30 dni bez zamówienia',                        'number', 'crm'),
  ('churn_days_t3_pts', '50',  'Churn: punkty za próg 3 dni',      'Punkty za >30 dni bez zamówienia',                           'number', 'crm'),
  ('churn_sales_t1_pct', '30', 'Churn: spadek sprzedaży próg 1 %', 'Min. % spadku M-2→M-1 dla progu 1',                         'number', 'crm'),
  ('churn_sales_t2_pct', '51', 'Churn: spadek sprzedaży próg 2 %', 'Min. % spadku M-2→M-1 dla progu 2',                         'number', 'crm'),
  ('churn_sales_t1_pts', '30', 'Churn: punkty za próg 1 sprzedaży','Punkty za ≥30% spadku sprzedaży M-2→M-1',                   'number', 'crm'),
  ('churn_sales_t2_pts', '50', 'Churn: punkty za próg 2 sprzedaży','Punkty za ≥51% spadku sprzedaży M-2→M-1',                   'number', 'crm'),
  ('churn_risk_critical', '91','Churn: próg ryzyka krytycznego',    'Min. punktów dla poziomu ryzyka: Krytyczne',                 'number', 'crm'),
  ('churn_risk_high',     '71','Churn: próg ryzyka wysokiego',      'Min. punktów dla poziomu ryzyka: Wysokie',                   'number', 'crm'),
  ('churn_risk_medium',   '51','Churn: próg ryzyka średniego',      'Min. punktów dla poziomu ryzyka: Średnie',                   'number', 'crm'),
  ('churn_risk_low',      '21','Churn: próg ryzyka niskiego',       'Min. punktów dla poziomu ryzyka: Niskie',                    'number', 'crm')
) AS s(key, value, label, description, value_type, category)
ON CONFLICT (tenant_id, key) DO NOTHING;
