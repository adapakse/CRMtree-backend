-- 0303_seo_editor_group_all_tenants.sql
-- SEO editors are members of a group named exactly 'SEO' with 'full' access
-- (crm-seo.js requireSeoEditor). 0203 created that group only for the local
-- crmtree dogfooding tenant, so on production Comparme there was no group to
-- assign an editor to (Adam, 2026-09-29). Create it for every tenant that
-- has SEObot enabled; admins then only assign users to it.

INSERT INTO group_profiles (tenant_id, name, display_name, description, is_active)
SELECT f.tenant_id, 'SEO', 'Redakcja SEO', 'Redaktorzy SEObota: edycja, uzupełnianie i akceptacja artykułów przed publikacją.', true
  FROM tenant_features f
 WHERE f.feature = 'seo_bot' AND f.is_enabled = true
   AND NOT EXISTS (
     SELECT 1 FROM group_profiles g WHERE g.tenant_id = f.tenant_id AND g.name = 'SEO'
   );
