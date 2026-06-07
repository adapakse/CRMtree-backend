-- =============================================================================
-- seed: dev_dwh_scoring_test.sql
-- Dane testowe DWH dla weryfikacji algorytmów Churn + Health Score.
--
-- ref_date = MAX(sale_date) = 2026-04-20
--   m1 (bieżący miesiąc)    = kwiecień 2026
--   m2 (poprzedni miesiąc)  = marzec   2026
--   "ostatnie 20 dni"       = sale_date >= 2026-03-31
--
-- Oczekiwane wyniki po uruchomieniu:
--
--   Partner 1  Sigma Hotels          Churn CRITICAL (100 pkt)  Health RISK    ( 0 pkt)
--   Partner 6  NordTravel            Churn NONE     (  0 pkt)  Health GOOD    (100 pkt)
--   Partner 7  Alpine Business       Churn MEDIUM   ( 60 pkt)  Health WARNING ( 30 pkt)
--
-- Uruchomienie:
--   psql -U postgres -d crmtree -f src/db/seeds/dev_dwh_scoring_test.sql
-- =============================================================================

BEGIN;

-- Czyść dane mar–kwi 2026 dla testowanych partnerów
-- (starsze dane zostawiam — wpływają tylko na trend, nie na scoring)
DELETE FROM dwh.crmtree_gold_sales
WHERE partner_id IN (1, 6, 7)
  AND sale_date >= '2026-03-01';

-- =============================================================================
-- Partner 1 · Sigma Hotels · dwh_partner_id = 1
-- =============================================================================
-- Cel: CHURN CRITICAL (100 pkt) + HEALTH RISK (0 pkt)
--
-- Składowe Churn:
--   days_score:  ostatnie zamówienie 2026-03-10 → 41 dni przed ref → T3 → 50 pkt
--   sales_score: marzec=200 000, kwiecień=0 → spadek 100% → T2 → 50 pkt
--   RAZEM:       100 pkt → CRITICAL
--
-- Składowe Health:
--   activity_score: brak zamówień po 2026-03-31 → 0 pkt
--   growth_score:   przychód spadł (nie wzrósł) → 0 pkt
--   RAZEM:          0 pkt → RISK
-- -----------------------------------------------------------------------------

INSERT INTO dwh.crmtree_gold_sales
  (partner_id, sale_date, service_category, currency,
   gross_sales_value_pln, net_sales_value_pln, net_sales_value_currency,
   gross_fee_value_pln, net_fee_value_pln, gross_margin_value_pln,
   number_of_products)
VALUES
  -- Marzec 2026 (m2): 200 000 PLN — jedno duże zamówienie hotelowe
  (1, '2026-03-10', 'hotel', 'PLN',
   200000.00, 180000.00, 180000.00, 20000.00, 18000.00, 28000.00, 24);

-- Kwiecień 2026 (m1): brak zamówień → partner "zamilkł" od 2026-03-10


-- =============================================================================
-- Partner 6 · NordTravel · dwh_partner_id = 6
-- =============================================================================
-- Cel: CHURN NONE (0 pkt) + HEALTH GOOD (100 pkt)
--
-- Składowe Health:
--   activity_score: 8 zamówień w ostatnich 20 dniach (≥ 2026-03-31) → T4 → 50 pkt
--   growth_score:   marzec=50 000, kwiecień=85 000 → wzrost 70% → T4 → 50 pkt
--   RAZEM:          100 pkt → GOOD
--
-- Składowe Churn:
--   days_score:  ostatnie zamówienie 2026-04-19 → 1 dzień → < 10 → 0 pkt
--   sales_score: przychód wzrósł (brak spadku) → 0 pkt
--   RAZEM:       0 pkt → NONE
-- -----------------------------------------------------------------------------

INSERT INTO dwh.crmtree_gold_sales
  (partner_id, sale_date, service_category, currency,
   gross_sales_value_pln, net_sales_value_pln, net_sales_value_currency,
   gross_fee_value_pln, net_fee_value_pln, gross_margin_value_pln,
   number_of_products)
VALUES
  -- Marzec 2026 (m2): 50 000 PLN — 3 transakcje
  (6, '2026-03-05', 'hotel',            'PLN', 20000.00, 18000.00, 18000.00, 2000.00, 1800.00, 2800.00, 4),
  (6, '2026-03-14', 'transport_flight', 'PLN', 15000.00, 13500.00, 13500.00, 1500.00, 1350.00, 2100.00, 3),
  (6, '2026-03-25', 'car_rental',       'PLN', 15000.00, 13500.00, 13500.00, 1500.00, 1350.00, 2100.00, 6),

  -- Kwiecień 2026 (m1): 85 000 PLN — 8 transakcji (wszystkie >= 2026-03-31 → "recent")
  (6, '2026-04-01', 'hotel',            'PLN', 10000.00,  9000.00,  9000.00, 1000.00,  900.00, 1400.00, 3),
  (6, '2026-04-03', 'transport_flight', 'PLN',  9000.00,  8100.00,  8100.00,  900.00,  810.00, 1260.00, 2),
  (6, '2026-04-06', 'hotel',            'PLN', 12000.00, 10800.00, 10800.00, 1200.00, 1080.00, 1680.00, 4),
  (6, '2026-04-08', 'car_rental',       'PLN',  8000.00,  7200.00,  7200.00,  800.00,  720.00, 1120.00, 5),
  (6, '2026-04-11', 'hotel',            'PLN', 14000.00, 12600.00, 12600.00, 1400.00, 1260.00, 1960.00, 3),
  (6, '2026-04-14', 'transport_flight', 'PLN', 11000.00,  9900.00,  9900.00, 1100.00,  990.00, 1540.00, 2),
  (6, '2026-04-17', 'hotel',            'PLN', 12000.00, 10800.00, 10800.00, 1200.00, 1080.00, 1680.00, 4),
  (6, '2026-04-19', 'car_rental',       'PLN',  9000.00,  8100.00,  8100.00,  900.00,  810.00, 1260.00, 3);
--                   ^^^^^^^^^^^
--                   ostatnie zamówienie: 1 dzień przed ref → days_score = 0


-- =============================================================================
-- Partner 7 · Alpine Business Travel · dwh_partner_id = 7
-- =============================================================================
-- Cel: CHURN MEDIUM (60 pkt) + HEALTH WARNING (30 pkt)
--
-- Składowe Churn:
--   days_score:  ostatnie zamówienie 2026-04-09 → 11 dni przed ref → T1 (10-20 dni) → 10 pkt
--   sales_score: marzec=100 000, kwiecień=45 000 → spadek 55% → T2 (≥51%) → 50 pkt
--   RAZEM:       60 pkt → MEDIUM  (próg medium = 51, próg high = 71)
--
-- Składowe Health:
--   activity_score: 3 zamówienia >= 2026-03-31 → T3 (2–5 zamówień) → 30 pkt
--   growth_score:   przychód spadł (nie wzrósł) → 0 pkt
--   RAZEM:          30 pkt → WARNING  (próg warning = 21, próg good = 61)
-- -----------------------------------------------------------------------------

INSERT INTO dwh.crmtree_gold_sales
  (partner_id, sale_date, service_category, currency,
   gross_sales_value_pln, net_sales_value_pln, net_sales_value_currency,
   gross_fee_value_pln, net_fee_value_pln, gross_margin_value_pln,
   number_of_products)
VALUES
  -- Marzec 2026 (m2): 100 000 PLN — 3 transakcje
  (7, '2026-03-04', 'hotel',            'PLN', 40000.00, 36000.00, 36000.00, 4000.00, 3600.00, 5600.00, 8),
  (7, '2026-03-12', 'transport_flight', 'PLN', 35000.00, 31500.00, 31500.00, 3500.00, 3150.00, 4900.00, 7),
  (7, '2026-03-22', 'car_rental',       'PLN', 25000.00, 22500.00, 22500.00, 2500.00, 2250.00, 3500.00, 6),

  -- Kwiecień 2026 (m1): 45 000 PLN — 3 transakcje (wszystkie >= 2026-03-31 → "recent")
  (7, '2026-04-01', 'hotel',            'PLN', 18000.00, 16200.00, 16200.00, 1800.00, 1620.00, 2520.00, 5),
  (7, '2026-04-05', 'transport_flight', 'PLN', 15000.00, 13500.00, 13500.00, 1500.00, 1350.00, 2100.00, 4),
  (7, '2026-04-09', 'car_rental',       'PLN', 12000.00, 10800.00, 10800.00, 1200.00, 1080.00, 1680.00, 3);
--               ^^^^^^^^^^^
--               ostatnie zamówienie: 11 dni przed ref → T1 → 10 pkt days_score

COMMIT;

-- =============================================================================
-- Weryfikacja (uruchom po seedzie aby potwierdzić wartości):
-- =============================================================================
/*
WITH ref_date AS (SELECT MAX(sale_date)::date AS ref FROM dwh.crmtree_gold_sales),
m1 AS (
  SELECT partner_id, SUM(gross_sales_value_pln) AS sales
  FROM dwh.crmtree_gold_sales, ref_date
  WHERE TO_CHAR(sale_date,'YYYY-MM') = TO_CHAR(ref,'YYYY-MM') GROUP BY partner_id
),
m2 AS (
  SELECT partner_id, SUM(gross_sales_value_pln) AS sales
  FROM dwh.crmtree_gold_sales, ref_date
  WHERE TO_CHAR(sale_date,'YYYY-MM') = TO_CHAR(ref - INTERVAL '1 month','YYYY-MM') GROUP BY partner_id
),
last_ord AS (SELECT partner_id, MAX(sale_date)::date AS last_date FROM dwh.crmtree_gold_sales GROUP BY partner_id),
recent   AS (
  SELECT partner_id, COUNT(*)::int AS orders_cnt, MAX(sale_date)::date AS last_date
  FROM dwh.crmtree_gold_sales, ref_date
  WHERE sale_date >= ref - 20 GROUP BY partner_id
)
SELECT
  p.partner_id,
  r.ref,
  lo.last_date,
  (r.ref - lo.last_date)::int                          AS days_since,
  COALESCE(m1.sales,0)                                 AS apr_sales,
  COALESCE(m2.sales,0)                                 AS mar_sales,
  COALESCE(rc.orders_cnt,0)                            AS recent_orders
FROM (VALUES (1),(6),(7)) AS p(partner_id)
CROSS JOIN ref_date r
LEFT JOIN last_ord lo ON lo.partner_id = p.partner_id
LEFT JOIN m1 ON m1.partner_id = p.partner_id
LEFT JOIN m2 ON m2.partner_id = p.partner_id
LEFT JOIN recent rc ON rc.partner_id = p.partner_id;

-- Oczekiwany wynik:
--  partner_id | ref        | last_date  | days_since | apr_sales | mar_sales | recent_orders
-- ------------+------------+------------+------------+-----------+-----------+---------------
--           1 | 2026-04-20 | 2026-03-10 |         41 |         0 |    200000 |             0
--           6 | 2026-04-20 | 2026-04-19 |          1 |     85000 |     50000 |             8
--           7 | 2026-04-20 | 2026-04-09 |         11 |     45000 |    100000 |             3
*/
