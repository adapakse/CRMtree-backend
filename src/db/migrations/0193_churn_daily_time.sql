-- Migration 0193: Godzina dziennego przeliczenia churn + health
INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
SELECT t.id, 'churn_daily_run_time', '06:00',
       'Churn: godzina dziennego przeliczenia',
       'Format HH:MM — o tej godzinie serwer przelicza scoring i wysyła alerty email',
       'string', 'crm'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;
