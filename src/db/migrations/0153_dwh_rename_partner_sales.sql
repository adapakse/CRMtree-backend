-- 0153_dwh_rename_partner_sales.sql
-- Zmiana nazw tabel DWH: dm_partner → "Partner", dm_sales → "Sales"
-- Zmiana nazw kolumn w "Partner" zgodnie z nowym schematem.
-- Dodanie nowych kolumn.
-- UWAGA: Na serwerach nowe tabele założył Admin — migracja tylko dla LOCAL.

-- ── 1. Tabela Partner (was dm_partner) ────────────────────────────────────────
ALTER TABLE dwh.dm_partner RENAME TO "Partner";

-- Zmiana nazw kolumn (stare dm_partner → nowe Partner)
ALTER TABLE dwh."Partner" RENAME COLUMN billing_address     TO address;
ALTER TABLE dwh."Partner" RENAME COLUMN nip                 TO tax_numbers;
ALTER TABLE dwh."Partner" RENAME COLUMN billing_zip         TO zip_code;
ALTER TABLE dwh."Partner" RENAME COLUMN billing_city        TO town;
ALTER TABLE dwh."Partner" RENAME COLUMN language            TO billing_language;
ALTER TABLE dwh."Partner" RENAME COLUMN partner_currency    TO billing_currency;
ALTER TABLE dwh."Partner" RENAME COLUMN billing_email_address TO emails;

-- Nowa kolumna name (odpowiednik wyświetlanej nazwy partnera, COALESCE z company_name)
ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS name VARCHAR(500);

-- Nowe kolumny (zgodnie z mapowaniem)
ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS max_debit             NUMERIC(14,2);
ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS currency              VARCHAR(10);
ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS customer_service_note TEXT;
ALTER TABLE dwh."Partner" ADD COLUMN IF NOT EXISTS switched_to_prod_at  TIMESTAMPTZ;

-- Usuń stare kolumny adminowe (nie ma ich w nowym schemacie)
ALTER TABLE dwh."Partner" DROP COLUMN IF EXISTS admin_first_name;
ALTER TABLE dwh."Partner" DROP COLUMN IF EXISTS admin_last_name;
ALTER TABLE dwh."Partner" DROP COLUMN IF EXISTS admin_email;
ALTER TABLE dwh."Partner" DROP COLUMN IF EXISTS updated_at;

-- Zmiana nazwy indeksu
ALTER INDEX IF EXISTS dwh.idx_dwh_dm_partner_nip RENAME TO idx_dwh_Partner_tax_numbers;

-- ── 2. Tabela Sales (was dm_sales) ────────────────────────────────────────────
ALTER TABLE dwh.dm_sales RENAME TO "Sales";

-- Nowe kolumny (na razie "not to be used", dodajemy żeby tabela zgadzała się ze schematem)
ALTER TABLE dwh."Sales" ADD COLUMN IF NOT EXISTS currency                 VARCHAR(10);
ALTER TABLE dwh."Sales" ADD COLUMN IF NOT EXISTS net_sales_value_currency NUMERIC(14,2);
ALTER TABLE dwh."Sales" ADD COLUMN IF NOT EXISTS net_fee_value_pln        NUMERIC(14,2);

-- Zmiana nazw indeksów
ALTER INDEX IF EXISTS dwh.idx_dwh_dm_sales_partner_id RENAME TO idx_dwh_Sales_partner_id;
ALTER INDEX IF EXISTS dwh.idx_dwh_dm_sales_sale_date  RENAME TO idx_dwh_Sales_sale_date;
