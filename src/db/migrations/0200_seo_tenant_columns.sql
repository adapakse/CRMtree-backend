-- 0200_seo_tenant_columns.sql
-- Faza 1 (SEObot): per-tenant fields needed for safe backlinks and pricing.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS industry_vertical VARCHAR(50),
  ADD COLUMN IF NOT EXISTS seo_daily_article_limit INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN tenants.industry_vertical IS
  'Scopes the SEO backlink partner pool to tenants in a related vertical — CRMtree spans many industries, so this is never assumed, only explicitly set (see project_crmtree_target_market memory).';
COMMENT ON COLUMN tenants.seo_daily_article_limit IS
  'Max SEObot articles/day for this tenant — 0 means the module is off. Doubles as the Faza 2a pricing lever.';
