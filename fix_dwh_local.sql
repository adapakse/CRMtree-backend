DROP TABLE IF EXISTS dwh.dm_partner CASCADE;
DROP TABLE IF EXISTS dwh.dm_sales CASCADE;

INSERT INTO dwh.partner
  (partner_id, company_name, tax_numbers, subdomain, partner_group, currency,
   country, address, zip_code, town, billing_country, emails, is_test_account,
   is_contract_signed, created_at, updated_at)
VALUES
  (1, 'Sigma Hotels Sp. z o.o.',    '5271234567', 'sigmahotels', 'Partner_premium', 'PLN', 'Polska', 'ul. Hotelowa 12',      '00-001', 'Warszawa', 'Polska', '["faktury@sigmahotels.pl"]',    false, true,  NOW(), NOW()),
  (2, 'Vanguard Travel S.A.',        '5262345678', 'vanguard',    'Partner_basic',   'EUR', 'Polska', 'al. Jerozolimskie 65', '00-697', 'Warszawa', 'Polska', '["finance@vanguardtravel.pl"]', false, true,  NOW(), NOW()),
  (3, 'EuroTravel Group Sp. z o.o.','5273456789', 'eurotravel',  'Partner_premium', 'EUR', 'Polska', 'ul. Europejska 3',     '31-001', 'Krakow',   'Polska', '["billing@eurotravel.pl"]',     false, true,  NOW(), NOW()),
  (4, 'BizTrip Poland Sp. z o.o.', '5264567890', 'biztrip',     'Partner_basic',   'PLN', 'Polska', 'ul. Biznesowa 7',      '60-001', 'Poznan',   'Polska', '["rozliczenia@biztrip.pl"]',    false, false, NOW(), NOW()),
  (5, 'CorporateJet Sp. z o.o.',   '5275678901', 'corpjet',     'Partner_premium', 'PLN', 'Polska', 'ul. Lotnicza 44',      '40-001', 'Katowice', 'Polska', '["finance@corporatejet.pl"]',   false, true,  NOW(), NOW()),
  (6, 'NordTravel Sp. z o.o.',      '5266789012', 'nordtravel',  'Partner_basic',   'PLN', 'Polska', 'ul. Gdanska 9',        '80-001', 'Gdansk',   'Polska', '["rachunkowosc@nordtravel.pl"]', false, true,  NOW(), NOW()),
  (7, 'Alpine Business Travel S.A.','5277890123', 'alpinebiz',   'Partner_premium', 'EUR', 'Polska', 'ul. Gorska 21',        '50-001', 'Wroclaw',  'Polska', '["fakturowanie@alpinebiz.pl"]',  false, true,  NOW(), NOW()),
  (8, 'MediaTravel Sp. z o.o.',     '5268901234', 'mediatravel', 'Partner_basic',   'PLN', 'Polska', 'ul. Medialna 5',       '90-001', 'Lodz',     'Polska', '["ksiegowosc@mediatravel.pl"]',  false, false, NOW(), NOW());

INSERT INTO dwh.sales
  (partner_id, sale_date, service_category, currency,
   gross_sales_value_pln, net_sales_value_pln, gross_fee_value_pln, gross_margin_value_pln, number_of_products)
SELECT
  p.partner_id,
  (DATE_TRUNC('month', CURRENT_DATE) - (m.mon - 1) * INTERVAL '1 month')::date + (s.d - 1),
  s.cat,
  'PLN',
  s.gross,
  ROUND(s.gross * 0.90, 2),
  ROUND(s.gross * 0.10, 2),
  ROUND(s.gross * 0.14, 2),
  s.nprod
FROM (VALUES (1),(2),(3),(4),(5),(6),(7),(8)) AS p(partner_id),
LATERAL (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16),(17),(18)) AS m(mon),
LATERAL (
  SELECT * FROM (VALUES
    (1,  'hotel',           ROUND((150000 + p.partner_id*20000 + m.mon*5000)::numeric, 2), 12+p.partner_id),
    (5,  'transport_flight',ROUND((60000  + p.partner_id*8000  + m.mon*2000)::numeric, 2), 8+p.partner_id),
    (10, 'transport_train', ROUND((20000  + p.partner_id*2000  + m.mon*800)::numeric, 2),  4+p.partner_id),
    (15, 'car_rental',      ROUND((30000  + p.partner_id*3000  + m.mon*1000)::numeric, 2), 10+p.partner_id),
    (20, 'other',           ROUND((10000  + p.partner_id*1000  + m.mon*300)::numeric, 2),  3+p.partner_id)
  ) AS raw(d, cat, gross, nprod)
) AS s(d, cat, gross, nprod);

SELECT 'dwh.partner' AS t, COUNT(*) FROM dwh.partner
UNION ALL SELECT 'dwh.sales', COUNT(*) FROM dwh.sales;
