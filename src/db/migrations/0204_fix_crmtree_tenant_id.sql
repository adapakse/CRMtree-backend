-- 0204_fix_crmtree_tenant_id.sql
-- The internal CRMtree dogfood tenant was seeded with id
-- '00000000-0000-0000-0000-000000000001' — not a valid RFC 4122 UUID (the
-- version nibble is 0, not 1-8), so express-validator's isUUID() rejects it
-- on any admin route with a :id param.isUUID() check (e.g. PUT
-- /api/admin/tenants/:id/features), surfacing as a 400 Bad Request from the
-- tenant admin UI. Swap it for a real UUID, repointing every table that
-- references it. No-op if already fixed or if the tenant never existed here
-- (this environment hasn't run 0199/0203 yet, or already has the corrected ID).

DO $$
DECLARE
  old_id UUID := '00000000-0000-0000-0000-000000000001';
  new_id UUID := '4a299a1b-9e33-43d7-b649-ead5a17d61fc';
  r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = old_id) THEN
    RETURN;
  END IF;

  INSERT INTO tenants (id, name, slug, is_active, industry_vertical, seo_daily_article_limit)
  SELECT new_id, 'CRMtree-tmp-migration-0204', 'crmtree-tmp-migration-0204', is_active, industry_vertical, seo_daily_article_limit
  FROM tenants WHERE id = old_id
  ON CONFLICT (id) DO NOTHING;

  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'tenant_id' AND table_schema = 'public' AND table_name <> 'tenants'
  LOOP
    EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id = $2', r.table_name)
      USING new_id, old_id;
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'seo_backlinks' AND column_name = 'partner_tenant_id') THEN
    UPDATE seo_backlinks SET partner_tenant_id = new_id WHERE partner_tenant_id = old_id;
  END IF;

  UPDATE tenants SET created_from_tenant_id = new_id WHERE created_from_tenant_id = old_id;

  DELETE FROM tenants WHERE id = old_id;

  UPDATE tenants SET name = 'CRMtree', slug = 'crmtree' WHERE id = new_id;
END $$;
