-- ============================================================
-- 0313 — INT only: demo sales in the data warehouse for the test tenant
--
-- The partners of the `brmtree-test1` tenant on INT had no data-warehouse
-- link, so neither the web nor the mobile app could show turnover, margin
-- or "active since" for them. This links up to 30 of its active partners to
-- demo warehouse partners and gives each a sales history from January of
-- last year until today.
--
-- It is a seed, shipped as a migration because the INT database is reachable
-- only from the deploy pipeline. It does nothing anywhere else: the first
-- check is the database name, the second the tenant.
--
-- Safe to re-run by hand: the demo rows live in the warehouse id range
-- 910001–910999 and are replaced, never duplicated.
-- ============================================================

DO $$
DECLARE
  c_first_id      CONSTANT integer := 910001;
  c_last_id       CONSTANT integer := 910999;
  c_max_partners  CONSTANT integer := 30;

  v_tenant_id     uuid;
  v_prefix        text;
  v_partner_table text;
  v_sales_table   text;
  v_first_month   date := (date_trunc('year', CURRENT_DATE) - INTERVAL '1 year')::date;
  v_this_month    date := date_trunc('month', CURRENT_DATE)::date;

  r               record;
  v_dwh_id        integer;
  v_active_since  date;
  v_month         date;
  v_month_index   integer;
  v_base          numeric;
  v_factor        numeric;
  v_gross         numeric;
  v_linked        integer := 0;
  category        record;
BEGIN
  IF current_database() <> 'crmtreedb_int' THEN
    RAISE NOTICE '0313: not the INT database (%), nothing to seed', current_database();
    RETURN;
  END IF;

  SELECT id, dwh_schema_prefix INTO v_tenant_id, v_prefix
    FROM tenants WHERE slug = 'brmtree-test1' AND deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE '0313: tenant brmtree-test1 not found, nothing to seed';
    RETURN;
  END IF;

  -- The warehouse tables hold no tenant column: every tenant on the same
  -- prefix sees the same sales. A tenant without a prefix reads the shared
  -- crmtree_gold tables, so it gets tables of its own first — unless some of
  -- its partners are already linked to rows in the shared ones.
  IF COALESCE(v_prefix, '') = '' THEN
    IF EXISTS (SELECT 1 FROM crm_partners
                WHERE tenant_id = v_tenant_id AND dwh_partner_id IS NOT NULL) THEN
      v_prefix := 'crmtree_gold';
    ELSIF to_regclass('dwh.crmtree_gold_partner') IS NULL
       OR to_regclass('dwh.crmtree_gold_sales') IS NULL THEN
      RAISE NOTICE '0313: warehouse tables to copy the structure from are missing, nothing to seed';
      RETURN;
    ELSE
      v_prefix := 'brmtree_test1';
      CREATE TABLE IF NOT EXISTS dwh.brmtree_test1_partner (LIKE dwh.crmtree_gold_partner INCLUDING ALL);
      CREATE TABLE IF NOT EXISTS dwh.brmtree_test1_sales   (LIKE dwh.crmtree_gold_sales   INCLUDING ALL);
      UPDATE tenants SET dwh_schema_prefix = v_prefix WHERE id = v_tenant_id;
    END IF;
  END IF;

  v_partner_table := v_prefix || '_partner';
  v_sales_table   := v_prefix || '_sales';
  IF to_regclass(format('dwh.%I', v_partner_table)) IS NULL
     OR to_regclass(format('dwh.%I', v_sales_table)) IS NULL THEN
    RAISE NOTICE '0313: dwh.% or dwh.% is missing, nothing to seed', v_partner_table, v_sales_table;
    RETURN;
  END IF;

  -- Replace what an earlier run left behind.
  EXECUTE format('DELETE FROM dwh.%I WHERE partner_id BETWEEN $1 AND $2', v_sales_table)   USING c_first_id, c_last_id;
  EXECUTE format('DELETE FROM dwh.%I WHERE partner_id BETWEEN $1 AND $2', v_partner_table) USING c_first_id, c_last_id;
  UPDATE crm_partners SET dwh_partner_id = NULL
   WHERE tenant_id = v_tenant_id AND dwh_partner_id BETWEEN c_first_id AND c_last_id;

  FOR r IN
    SELECT id, company, (row_number() OVER (ORDER BY company, id))::integer AS n
      FROM crm_partners
     WHERE tenant_id = v_tenant_id
       AND COALESCE(status, 'active') = 'active'
       AND dwh_partner_id IS NULL
       AND company IS NOT NULL
     ORDER BY company, id
     LIMIT c_max_partners
  LOOP
    v_dwh_id := c_first_id + r.n - 1;
    -- dwh_partner_id is unique across all tenants.
    CONTINUE WHEN EXISTS (SELECT 1 FROM crm_partners WHERE dwh_partner_id = v_dwh_id);

    -- A customer for 6 to 35 months, so "active since" differs per partner.
    v_active_since := (v_this_month - make_interval(months => 6 + (r.n * 5) % 30))::date;
    EXECUTE format(
      'INSERT INTO dwh.%I
         (partner_id, name, company_name, country, currency, billing_currency, billing_language,
          is_test_account, is_contract_signed, created_at, updated_at)
       VALUES ($1, $2, $2, ''PL'', ''PLN'', ''PLN'', ''pl'', false, true, $3, now())',
      v_partner_table)
    USING v_dwh_id, r.company, v_active_since::timestamp;

    UPDATE crm_partners SET dwh_partner_id = v_dwh_id WHERE id = r.id;
    v_linked := v_linked + 1;

    -- 40 000 to 190 000 PLN a month, the same for a partner on every run.
    v_base := 40000 + ((r.n * 37) % 11) * 15000;

    -- No sales before the customer started.
    v_month := GREATEST(v_first_month, v_active_since);
    v_month_index := 0;
    WHILE v_month <= v_this_month LOOP
      -- Four kinds of customer, so the lists and the churn scoring have
      -- something to tell apart: growing, steady, declining, gone quiet.
      v_factor := CASE r.n % 4
        WHEN 0 THEN 0.70 + 0.04 * v_month_index
        WHEN 1 THEN 1.00
        WHEN 2 THEN GREATEST(0.20, 1.30 - 0.05 * v_month_index)
        ELSE CASE WHEN v_month >= (v_this_month - INTERVAL '2 months') THEN 0 ELSE 1.00 END
      END * (1 + 0.15 * sin(v_month_index + r.n));
      v_gross := round(v_base * v_factor, 2);

      IF v_gross > 0 THEN
        FOR category IN
          SELECT * FROM (VALUES
            ('hotel',            0.55,  8, 0.14),
            ('transport_flight', 0.30, 16, 0.06),
            ('transport_train',  0.15, 24, 0.09)
          ) AS c(service_category, share, day_of_month, margin_rate)
        LOOP
          CONTINUE WHEN (v_month + (category.day_of_month - 1)) > CURRENT_DATE;
          EXECUTE format(
            'INSERT INTO dwh.%I
               (partner_id, sale_date, service_category, currency,
                gross_sales_value_pln, net_sales_value_pln, net_sales_value_currency,
                gross_fee_value_pln, net_fee_value_pln, gross_margin_value_pln, number_of_products)
             VALUES ($1, $2, $3, ''PLN'', $4, $5, $5, $6, $7, $8, $9)',
            v_sales_table)
          USING v_dwh_id,
                v_month + (category.day_of_month - 1),
                category.service_category,
                round(v_gross * category.share, 2),
                round(v_gross * category.share * 0.90, 2),
                round(v_gross * category.share * 0.03, 2),
                round(v_gross * category.share * 0.027, 2),
                round(v_gross * category.share * category.margin_rate, 2),
                GREATEST(1, round(v_gross * category.share / 900))::bigint;
        END LOOP;
      END IF;

      v_month := (v_month + INTERVAL '1 month')::date;
      v_month_index := v_month_index + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE '0313: linked % partners of brmtree-test1 to demo warehouse data in dwh.%', v_linked, v_sales_table;
END $$;
