-- 0249_prospects_editorial_setup.sql
-- Faza 1 (Prospekty): "Prospekty" permission group + enable dogfooding on the
-- internal CRMtree tenant itself. Mirrors 0203_seo_editorial_setup.sql.

INSERT INTO group_profiles (tenant_id, name, display_name, description, is_active)
SELECT '4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'Prospekty', 'Prospekty', 'Dostęp do modułu Prospektów (import CSV, enrichment, konwersja na lead).', true
WHERE NOT EXISTS (
  SELECT 1 FROM group_profiles
  WHERE tenant_id = '4a299a1b-9e33-43d7-b649-ead5a17d61fc' AND name = 'Prospekty'
);

INSERT INTO tenant_features (tenant_id, feature, is_enabled)
VALUES ('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'prospects', true)
ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = true;
