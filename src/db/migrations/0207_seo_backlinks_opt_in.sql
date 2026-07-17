-- 0207_seo_backlinks_opt_in.sql
-- Faza 1 (SEObot): opt-in flag for cross-tenant backlinks (requirements §7 —
-- opt-in, industry_vertical-gated, capped, no forced reciprocity).
-- tenants.industry_vertical already exists (added earlier for this same
-- feature) — this just adds the missing opt-in switch.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS seo_backlinks_opt_in BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.seo_backlinks_opt_in IS
  'Tenant has opted in to being matched for cross-tenant SEO backlinks (seoBacklinkService) — requires industry_vertical to also be set.';
