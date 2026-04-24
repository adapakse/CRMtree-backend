-- 0154_dwh_lowercase_table_names.sql
-- Na local tabele mają nazwy "Partner" i "Sales" (wielka litera, quoted).
-- Na serwerach już są partner i sales (lowercase). Ujednolicamy.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'dwh' AND table_name = 'Partner') THEN
    ALTER TABLE dwh."Partner" RENAME TO partner;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'dwh' AND table_name = 'Sales') THEN
    ALTER TABLE dwh."Sales" RENAME TO sales;
  END IF;
END $$;
