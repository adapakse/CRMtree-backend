-- ============================================================
-- Sprint 1 / M5 — DWH: rename partner/sales → crmtree_gold_*
-- Zmienia nazwy tabel DWH na format per-tenant (prefiks slugu tenanta).
-- Idempotentna: sprawdza istnienie tabel przed rename.
-- Komentarze i indeksy aktualizowane po zmianie nazw.
-- ============================================================

DO $$
BEGIN

  -- ── dwh.partner → dwh.crmtree_gold_partner ──────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'dwh' AND table_name = 'partner'
  ) THEN
    ALTER TABLE dwh.partner RENAME TO crmtree_gold_partner;
    RAISE NOTICE 'Renamed dwh.partner → dwh.crmtree_gold_partner';
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'dwh' AND table_name = 'crmtree_gold_partner'
  ) THEN
    RAISE WARNING 'Tabela dwh.partner nie istnieje i dwh.crmtree_gold_partner też nie — sprawdź schemat DWH';
  ELSE
    RAISE NOTICE 'dwh.crmtree_gold_partner już istnieje, pomijam rename';
  END IF;

  -- ── dwh.sales → dwh.crmtree_gold_sales ──────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'dwh' AND table_name = 'sales'
  ) THEN
    ALTER TABLE dwh.sales RENAME TO crmtree_gold_sales;
    RAISE NOTICE 'Renamed dwh.sales → dwh.crmtree_gold_sales';
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'dwh' AND table_name = 'crmtree_gold_sales'
  ) THEN
    RAISE WARNING 'Tabela dwh.sales nie istnieje i dwh.crmtree_gold_sales też nie — sprawdź schemat DWH';
  ELSE
    RAISE NOTICE 'dwh.crmtree_gold_sales już istnieje, pomijam rename';
  END IF;

END $$;

-- ── Przebuduj indeksy po rename ──────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'dwh' AND table_name = 'crmtree_gold_partner'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'dwh' AND table_name = 'crmtree_gold_partner' AND column_name = 'nip'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE  schemaname = 'dwh' AND indexname = 'idx_dwh_crmtree_gold_partner_nip'
    ) THEN
      CREATE INDEX idx_dwh_crmtree_gold_partner_nip
        ON dwh.crmtree_gold_partner(nip);
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'dwh' AND table_name = 'crmtree_gold_sales'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'dwh' AND table_name = 'crmtree_gold_sales' AND column_name = 'partner_id'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE  schemaname = 'dwh' AND indexname = 'idx_dwh_crmtree_gold_sales_partner_id'
    ) THEN
      CREATE INDEX idx_dwh_crmtree_gold_sales_partner_id
        ON dwh.crmtree_gold_sales(partner_id);
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'dwh' AND table_name = 'crmtree_gold_sales' AND column_name = 'sale_date'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE  schemaname = 'dwh' AND indexname = 'idx_dwh_crmtree_gold_sales_sale_date'
    ) THEN
      CREATE INDEX idx_dwh_crmtree_gold_sales_sale_date
        ON dwh.crmtree_gold_sales(sale_date);
    END IF;
  END IF;
END $$;

COMMENT ON SCHEMA dwh IS
  'Data Warehouse. Tabele per-tenant z prefiksem slug tenanta, np. dwh.crmtree_gold_partner.';
