-- 0198_tooltip_sales_kpi2_rename.sql
-- Rename tooltip key for Sales Dashboard KPI tile 2:
-- old key: crm.sales.kpi.new_companies  (label "Nowe Firmy")
-- new key: crm.sales.kpi.new_leads_value (tile now shows total value of leads added this week)

UPDATE app_settings
SET
  key         = 'crm.sales.kpi.new_leads_value',
  label       = 'Sales Dashboard – KPI: Wartość nowych leadów tygodnia',
  value       = 'Łączna wartość szans sprzedażowych dodanych do Twojego pipeline w bieżącym tygodniu (według daty założenia w systemie). Kliknij kafelek, aby zobaczyć tę listę. Trend pokazuje zmianę wartości względem poprzedniego tygodnia.',
  updated_at  = now()
WHERE key = 'crm.sales.kpi.new_companies'
  AND category = 'tooltip';

-- Fallback: insert for any tenant that is missing both keys
INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
SELECT
  t.id,
  'crm.sales.kpi.new_leads_value',
  'Łączna wartość szans sprzedażowych dodanych do Twojego pipeline w bieżącym tygodniu (według daty założenia w systemie). Kliknij kafelek, aby zobaczyć tę listę. Trend pokazuje zmianę wartości względem poprzedniego tygodnia.',
  'Sales Dashboard – KPI: Wartość nowych leadów tygodnia',
  '', 'string', 'tooltip'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;
