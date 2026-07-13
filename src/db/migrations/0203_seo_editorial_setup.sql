-- 0203_seo_editorial_setup.sql
-- Faza 1 (SEObot): editorial permission group + enable dogfooding on the
-- internal CRMtree tenant itself.

INSERT INTO group_profiles (tenant_id, name, display_name, description, is_active)
SELECT '00000000-0000-0000-0000-000000000001', 'SEO', 'SEO', 'Przegląd i akceptacja treści SEObota przed publikacją.', true
WHERE NOT EXISTS (
  SELECT 1 FROM group_profiles
  WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND name = 'SEO'
);

UPDATE tenants
SET industry_vertical = 'saas_crm', seo_daily_article_limit = 1
WHERE id = '00000000-0000-0000-0000-000000000001';

INSERT INTO tenant_features (tenant_id, feature, is_enabled)
VALUES ('00000000-0000-0000-0000-000000000001', 'seo_bot', true)
ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = true;
