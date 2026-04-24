-- 0153_dwh_rename_partner_sales.sql
-- Dostosowanie lokalnej bazy do nowego schematu DWH.
-- Na serwerach tabele Partner i Sales zostały założone przez devops — tu tylko ADD COLUMN IF NOT EXISTS.
-- Na local: rename z dm_partner/dm_sales + add columns.

DO $$
BEGIN

  -- ── Tabela Partner ─────────────────────────────────────────────────────────

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'dwh' AND table_name = 'dm_partner') THEN

    ALTER TABLE dwh.dm_partner RENAME TO "Partner";

    ALTER TABLE dwh."Partner" RENAME COLUMN billing_address      TO address;
    ALTER TABLE dwh."Partner" RENAME COLUMN nip                  TO tax_numbers;
    ALTER TABLE dwh."Partner" RENAME COLUMN billing_zip          TO zip_code;
    ALTER TABLE dwh."Partner" RENAME COLUMN billing_city         TO town;
    ALTER TABLE dwh."Partner" RENAME COLUMN language             TO billing_language;
    ALTER TABLE dwh."Partner" RENAME COLUMN partner_currency     TO billing_currency;
    ALTER TABLE dwh."Partner" RENAME COLUMN billing_email_address TO emails;

    ALTER TABLE dwh."Partner" DROP COLUMN IF EXISTS admin_first_name;
    ALTER TABLE dwh."Partner" DROP COLUMN IF EXISTS admin_last_name;
    ALTER TABLE dwh."Partner" DROP COLUMN IF EXISTS admin_email;
    ALTER TABLE dwh."Partner" DROP COLUMN IF EXISTS updated_at;

    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'dwh' AND indexname = 'idx_dwh_dm_partner_nip') THEN
      ALTER INDEX dwh.idx_dwh_dm_partner_nip RENAME TO idx_dwh_Partner_tax_numbers;
    END IF;

  END IF;

  -- Nowe kolumny Partner (ADD IF NOT EXISTS działa zawsze)
  ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS name                  VARCHAR(500);
  ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS max_debit             NUMERIC(14,2);
  ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS currency              VARCHAR(10);
  ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS customer_service_note TEXT;
  ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS switched_to_prod_at  TIMESTAMPTZ;

  -- ── Tabela Sales ───────────────────────────────────────────────────────────

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'dwh' AND table_name = 'dm_sales') THEN

    ALTER TABLE dwh.dm_sales RENAME TO "Sales";

    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'dwh' AND indexname = 'idx_dwh_dm_sales_partner_id') THEN
      ALTER INDEX dwh.idx_dwh_dm_sales_partner_id RENAME TO idx_dwh_Sales_partner_id;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'dwh' AND indexname = 'idx_dwh_dm_sales_sale_date') THEN
      ALTER INDEX dwh.idx_dwh_dm_sales_sale_date RENAME TO idx_dwh_Sales_sale_date;
    END IF;

  END IF;

  -- Nowe kolumny Sales
  ALTER TABLE dwh."Sales" ADD COLUMN IF NOT EXISTS currency                 VARCHAR(10);
  ALTER TABLE dwh."Sales" ADD COLUMN IF NOT EXISTS net_sales_value_currency NUMERIC(14,2);
  ALTER TABLE dwh."Sales" ADD COLUMN IF NOT EXISTS net_fee_value_pln        NUMERIC(14,2);

END $$;
