-- Empty DWH tables for tenants that have a DWH prefix but no tables.
--
-- A tenant without dwh.<prefix>_partner / dwh.<prefix>_sales got a 500 on the
-- partner onboarding list and a failing nightly score job (tenant "comparme").
-- New tenants now get the tables when they are created (ensureTenantDwhTables in
-- utils/dwh.js); this migration covers the tenants that already exist.
--
-- The structure is copied from an existing pair: crmtree_gold first, any other
-- tenant's otherwise. An environment without any pair is left untouched.

DO $$
DECLARE
  v_template TEXT;
  v_prefix   TEXT;
BEGIN
  SELECT left(p.table_name, length(p.table_name) - length('_partner'))
    INTO v_template
    FROM information_schema.tables p
   WHERE p.table_schema = 'dwh' AND p.table_name LIKE '%\_partner'
     AND EXISTS (
       SELECT 1 FROM information_schema.tables s
        WHERE s.table_schema = 'dwh'
          AND s.table_name = left(p.table_name, length(p.table_name) - length('_partner')) || '_sales')
   ORDER BY (p.table_name = 'crmtree_gold_partner') DESC, p.table_name
   LIMIT 1;

  IF v_template IS NULL THEN
    RAISE NOTICE '0341: no DWH tables to copy the structure from, nothing created';
    RETURN;
  END IF;

  FOR v_prefix IN
    SELECT DISTINCT dwh_schema_prefix FROM tenants
     WHERE dwh_schema_prefix ~ '^[a-z][a-z0-9_]*$'
  LOOP
    IF to_regclass(format('dwh.%I', v_prefix || '_partner')) IS NULL THEN
      EXECUTE format('CREATE TABLE dwh.%I (LIKE dwh.%I INCLUDING ALL)', v_prefix || '_partner', v_template || '_partner');
      RAISE NOTICE '0341: created dwh.%_partner', v_prefix;
    END IF;
    IF to_regclass(format('dwh.%I', v_prefix || '_sales')) IS NULL THEN
      EXECUTE format('CREATE TABLE dwh.%I (LIKE dwh.%I INCLUDING ALL)', v_prefix || '_sales', v_template || '_sales');
      RAISE NOTICE '0341: created dwh.%_sales', v_prefix;
    END IF;
  END LOOP;
END $$;
