-- 0245_seo_gsc_site_url.sql
-- Editable per-tenant Search Console property URL. The GSC OAuth callback
-- previously hardcoded https://{slug}.crmtree.pl/ unconditionally, which is
-- wrong for a client tenant whose real GSC property is their own domain
-- (e.g. a WordPress site). NULL/empty means "not configured yet" — the
-- callback falls back to the old crmtree.pl placeholder only in that case.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS seo_gsc_site_url TEXT;

COMMENT ON COLUMN tenants.seo_gsc_site_url IS
  'Manually configured Search Console property used when connecting GSC OAuth — either a URL-prefix property (https://client.pl/) or a domain property (sc-domain:client.pl). Falls back to https://{slug}.crmtree.pl/ only when unset.';
