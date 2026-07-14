-- 0203_seo_editorial_setup.sql
-- Faza 1 (SEObot): editorial permission group + enable dogfooding on the
-- internal CRMtree tenant itself.

INSERT INTO group_profiles (tenant_id, name, display_name, description, is_active)
SELECT '4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'SEO', 'SEO', 'Przegląd i akceptacja treści SEObota przed publikacją.', true
WHERE NOT EXISTS (
  SELECT 1 FROM group_profiles
  WHERE tenant_id = '4a299a1b-9e33-43d7-b649-ead5a17d61fc' AND name = 'SEO'
);

UPDATE tenants
SET industry_vertical = 'saas_crm', seo_daily_article_limit = 1
WHERE id = '4a299a1b-9e33-43d7-b649-ead5a17d61fc';

INSERT INTO tenant_features (tenant_id, feature, is_enabled)
VALUES ('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'seo_bot', true)
ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = true;
