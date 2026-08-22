-- Migration 0253: app setting — minimalny score do konwersji prospektu na lead CRM
-- Wstawiane dla każdego istniejącego tenanta (app_settings jest per-tenant w CRMtree).
INSERT INTO app_settings (tenant_id, key, value, value_type, label, description, category)
SELECT t.id, 'prospect_lead_min_score', '45', 'number',
       'Prospekty — minimalny score do konwersji na Lead',
       'Przycisk "→ Lead" na liście prospektów aktywuje się tylko gdy Travel Potential Score firmy jest większy lub równy tej wartości (skala 0–100).',
       'crm'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;
