-- ============================================================
-- 0322 — INT only: sprzedaz w hurtowni dla tenanta testow Panelu
--
-- Raporty "Wyniki" (/crm/reports/partners) i "Analityka partnerow"
-- (/crm/partners/analytics) czytaja WYLACZNIE hurtownie:
-- GET /api/crm/sales-data/report i /analytics (routes/crm-sales-data.js)
-- licza z dwh.<prefix>_sales, laczac partnera CRM przez
-- crm_partners.dwh_partner_id, a handlowca przez crm_partners.manager_id.
-- Dla tenanta, w ktorym Panel Testow uruchamia scenariusze (tenant konta
-- wykonania `kstecdesigner@gmail.com`), hurtownia byla pusta w kazdym okresie,
-- a zaden z jego partnerow nie mial powiazania z hurtownia — Scorecard, KPI,
-- Obrot Brutto i Wyniki wg Handlowca byly puste.
--
-- Seed laczy do 10 istniejacych, aktywnych partnerow tego tenanta (tylko tych
-- BEZ powiazania z hurtownia) z partnerami demo w hurtowni i daje kazdemu po
-- jednym wierszu sprzedazy na miesiac od 15 miesiecy wstecz do dzis — czyli
-- kazdy z ostatnich 5 kwartalow, biezacy rok, biezacy i poprzedni kwartal.
-- Handlowiec w "Wynikach wg Handlowca" to opiekun partnera (manager_id) —
-- seed go nie zmienia.
--
-- Wzor: 0313 (to samo dla brmtree-test1). Tenant wskazany przez konto
-- wykonania, nie po slugu. Poza INT nic nie robi: pierwszy warunek to nazwa
-- bazy.
--
-- TABELE HURTOWNI: nie maja kolumny tenanta — kazdy tenant z tym samym
-- prefiksem widzi te same wiersze. Tak jak 0313: tenant bez prefiksu (czyta
-- wspolne crmtree_gold) dostaje najpierw wlasne tabele, chyba ze ma juz
-- partnerow powiazanych ze wspolnymi. Tenant z prefiksem dostaje dane w
-- swoich tabelach (dla tenanta crmtree-gold to sa wspolne tabele
-- crmtree_gold — wtedy wiersze demo zobacza tez inne tenanty INT bez
-- wlasnego prefiksu; seed wypisuje to w NOTICE).
--
-- IDEMPOTENTNOSC: partnerzy demo w hurtowni zyja w zakresie id
-- 920001–920999 (0313 uzywa 910001–910999) i sa oznaczeni
-- customer_service_note = 'SEED-INT-0322'. Przy ponownym uruchomieniu kasowane
-- sa wylacznie wiersze z tym znacznikiem i ich sprzedaz, a powiazania
-- crm_partners.dwh_partner_id z tego zakresu w tym tenancie sa zdejmowane.
-- Nic innego nie jest kasowane ani nadpisywane.
--
-- DANE SIE STARZEJA: wiersze sa liczone od daty uruchomienia migracji. Od
-- pierwszego dnia kolejnego miesiaca preset "Biezacy miesiac" bedzie pusty,
-- od nowego kwartalu — "Biezacy kwartal", od nowego roku — YTD.
-- ============================================================

DO $$
DECLARE
  c_user_id       CONSTANT uuid    := '2a34cb99-2fd5-455c-a232-34094b76da9c';
  c_email         CONSTANT text    := 'kstecdesigner@gmail.com';
  c_first_id      CONSTANT integer := 920001;
  c_last_id       CONSTANT integer := 920999;
  c_marker        CONSTANT text    := 'SEED-INT-0322';
  c_max_partners  CONSTANT integer := 10;
  c_months_back   CONSTANT integer := 15;

  v_tenant_id     uuid;
  v_slug          text;
  v_prefix        text;
  v_partner_table text;
  v_sales_table   text;
  v_this_month    date := date_trunc('month', CURRENT_DATE)::date;
  v_first_month   date := (date_trunc('month', CURRENT_DATE) - make_interval(months => c_months_back))::date;

  r               record;
  v_dwh_id        integer;
  v_month         date;
  v_month_index   integer;
  v_sale_date     date;
  v_base          numeric;
  v_gross         numeric;
  v_category      text;
  v_margin_rate   numeric;
  v_linked        integer := 0;
  v_exists        boolean;
BEGIN
  IF current_database() <> 'crmtreedb_int' THEN
    RAISE NOTICE '0322: to nie baza INT (%), nic nie zasiewam', current_database();
    RETURN;
  END IF;

  SELECT t.id, t.slug, t.dwh_schema_prefix
    INTO v_tenant_id, v_slug, v_prefix
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id AND t.deleted_at IS NULL
   WHERE u.id = c_user_id AND lower(u.email) = c_email;
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE '0322: brak konta wykonania % albo jego tenanta, nic nie zasiewam', c_email;
    RETURN;
  END IF;

  -- ── Ktore tabele hurtowni czyta ten tenant ───────────────────────────────
  -- middleware/auth.js: req.dwhPrefix = dwh_schema_prefix ?? 'crmtree_gold'
  IF v_prefix IS NULL THEN
    IF EXISTS (SELECT 1 FROM crm_partners
                WHERE tenant_id = v_tenant_id AND dwh_partner_id IS NOT NULL) THEN
      v_prefix := 'crmtree_gold';
    ELSIF to_regclass('dwh.crmtree_gold_partner') IS NULL
       OR to_regclass('dwh.crmtree_gold_sales') IS NULL THEN
      RAISE NOTICE '0322: brak tabel hurtowni, z ktorych mozna skopiowac strukture, nic nie zasiewam';
      RETURN;
    ELSE
      v_prefix := left(regexp_replace(replace(v_slug, '-', '_'), '^([^a-z])', 't_\1'), 24);
      IF EXISTS (SELECT 1 FROM tenants WHERE dwh_schema_prefix = v_prefix AND id <> v_tenant_id) THEN
        RAISE NOTICE '0322: prefiks % jest juz uzywany przez inny tenant, nic nie zasiewam', v_prefix;
        RETURN;
      END IF;
      EXECUTE format('CREATE TABLE IF NOT EXISTS dwh.%I (LIKE dwh.crmtree_gold_partner INCLUDING ALL)', v_prefix || '_partner');
      EXECUTE format('CREATE TABLE IF NOT EXISTS dwh.%I (LIKE dwh.crmtree_gold_sales   INCLUDING ALL)', v_prefix || '_sales');
      UPDATE tenants SET dwh_schema_prefix = v_prefix WHERE id = v_tenant_id;
      RAISE NOTICE '0322: tenant % dostal wlasne tabele hurtowni dwh.%_partner/_sales', v_slug, v_prefix;
    END IF;
  END IF;

  IF v_prefix = 'crmtree_gold' THEN
    RAISE NOTICE '0322: tenant % czyta wspolne tabele crmtree_gold — wiersze demo zobacza tez inne tenanty INT bez wlasnego prefiksu', v_slug;
  END IF;

  v_partner_table := v_prefix || '_partner';
  v_sales_table   := v_prefix || '_sales';
  IF to_regclass(format('dwh.%I', v_partner_table)) IS NULL
     OR to_regclass(format('dwh.%I', v_sales_table)) IS NULL THEN
    RAISE NOTICE '0322: brak dwh.% albo dwh.%, nic nie zasiewam', v_partner_table, v_sales_table;
    RETURN;
  END IF;

  -- ── Czyszczenie poprzedniego przebiegu (tylko wiersze z tym znacznikiem) ──
  EXECUTE format(
    'DELETE FROM dwh.%I s
      WHERE s.partner_id BETWEEN $1 AND $2
        AND s.partner_id IN (SELECT partner_id FROM dwh.%I
                              WHERE partner_id BETWEEN $1 AND $2
                                AND customer_service_note = $3)',
    v_sales_table, v_partner_table)
  USING c_first_id, c_last_id, c_marker;
  EXECUTE format(
    'DELETE FROM dwh.%I WHERE partner_id BETWEEN $1 AND $2 AND customer_service_note = $3',
    v_partner_table)
  USING c_first_id, c_last_id, c_marker;
  UPDATE crm_partners SET dwh_partner_id = NULL
   WHERE tenant_id = v_tenant_id AND dwh_partner_id BETWEEN c_first_id AND c_last_id;

  -- ── Partnerzy: powiazanie z hurtownia + sprzedaz miesiac po miesiacu ─────
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
    -- dwh_partner_id jest unikalny we wszystkich tenantach, a id w hurtowni
    -- nie moze zderzyc sie z wierszem, ktorego seed nie zalozyl.
    CONTINUE WHEN EXISTS (SELECT 1 FROM crm_partners WHERE dwh_partner_id = v_dwh_id);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM dwh.%I WHERE partner_id = $1)
                      OR EXISTS (SELECT 1 FROM dwh.%I WHERE partner_id = $1)',
                   v_partner_table, v_sales_table)
      INTO v_exists USING v_dwh_id;
    CONTINUE WHEN v_exists;

    EXECUTE format(
      'INSERT INTO dwh.%I
         (partner_id, name, company_name, country, currency, billing_currency, billing_language,
          is_test_account, is_contract_signed, customer_service_note, created_at, updated_at)
       VALUES ($1, $2, $2, ''PL'', ''PLN'', ''PLN'', ''pl'', false, true, $3, $4, now())',
      v_partner_table)
    USING v_dwh_id, r.company, c_marker, (v_first_month - INTERVAL '2 months')::timestamp;

    UPDATE crm_partners SET dwh_partner_id = v_dwh_id WHERE id = r.id;
    v_linked := v_linked + 1;

    -- 30 000 – 105 000 PLN miesiecznie, staly poziom dla danego partnera.
    v_base := 30000 + ((r.n * 37) % 6) * 15000;

    v_month := v_first_month;
    v_month_index := 0;
    WHILE v_month <= v_this_month LOOP
      -- Kategoria rotuje co miesiac, zeby "Wg produktu" mialo kilka pozycji.
      v_category := (ARRAY['hotel','transport_flight','transport_train'])[1 + ((v_month_index + r.n) % 3)];
      v_margin_rate := CASE v_category WHEN 'hotel' THEN 0.14 WHEN 'transport_flight' THEN 0.06 ELSE 0.09 END;
      v_gross := round(v_base * (1 + 0.15 * sin(v_month_index + r.n))::numeric, 2);

      -- Biezacy miesiac: nigdy po dzisiejszej dacie.
      v_sale_date := LEAST(v_month + (4 + (r.n * 3) % 20), CURRENT_DATE);

      EXECUTE format(
        'INSERT INTO dwh.%I
           (partner_id, sale_date, service_category, currency,
            gross_sales_value_pln, net_sales_value_pln, net_sales_value_currency,
            gross_fee_value_pln, net_fee_value_pln, gross_margin_value_pln, number_of_products)
         VALUES ($1, $2, $3, ''PLN'', $4, $5, $5, $6, $7, $8, $9)',
        v_sales_table)
      USING v_dwh_id, v_sale_date, v_category,
            v_gross,
            round(v_gross * 0.90, 2),
            round(v_gross * 0.03, 2),
            round(v_gross * 0.027, 2),
            round(v_gross * v_margin_rate, 2),
            GREATEST(1, round(v_gross / 900))::bigint;

      v_month := (v_month + INTERVAL '1 month')::date;
      v_month_index := v_month_index + 1;
    END LOOP;
  END LOOP;

  IF v_linked = 0 THEN
    RAISE NOTICE '0322: tenant % nie ma aktywnych partnerow bez powiazania z hurtownia — nic nie zasiano', v_slug;
  ELSE
    RAISE NOTICE '0322: tenant % — powiazano % partnerow z danymi demo w dwh.% (od % do %)',
      v_slug, v_linked, v_sales_table, v_first_month, CURRENT_DATE;
  END IF;
END $$;
