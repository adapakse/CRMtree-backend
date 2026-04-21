-- 0141_dwh_schema.sql
-- Tworzy schemat DWH z tabelami dm_partner i dm_sales.
-- Na PROD tabele już istnieją z realnymi danymi — blok INSERT jest zabezpieczony
-- warunkiem WHERE NOT EXISTS, więc nie nadpisze istniejących danych.

-- ── 1. Schemat ────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS dwh;

-- ── 2. dm_partner ─────────────────────────────────────────────────────────────
-- Tabela partnerów z systemu transakcyjnego (DWH).
-- Dane płyną tylko w kierunku DWH → CRM. Edycja po stronie CRM zabroniona.
CREATE TABLE IF NOT EXISTS dwh.dm_partner (
  partner_id              BIGINT        PRIMARY KEY,
  company_name            VARCHAR(255),
  nip                     VARCHAR(20),
  subdomain               VARCHAR(50),
  language                VARCHAR(50),
  partner_currency        VARCHAR(10),
  country                 VARCHAR(100),
  billing_address         VARCHAR(255),
  billing_zip             VARCHAR(20),
  billing_city            VARCHAR(100),
  billing_country         VARCHAR(100),
  billing_email_address   VARCHAR(255),
  admin_first_name        VARCHAR(100),
  admin_last_name         VARCHAR(100),
  admin_email             VARCHAR(255),
  updated_at              TIMESTAMPTZ   DEFAULT NOW()
);

-- ── 3. dm_sales ───────────────────────────────────────────────────────────────
-- Tabela transakcji sprzedażowych z systemu transakcyjnego (DWH).
-- Dane tylko do odczytu w CRM (widok Performance).
CREATE TABLE IF NOT EXISTS dwh.dm_sales (
  id                      BIGSERIAL     PRIMARY KEY,
  partner_id              BIGINT,
  sale_date               DATE,
  service_category        VARCHAR(50),
  gross_sales_value_pln   NUMERIC(14,2),
  net_sales_value_pln     NUMERIC(14,2),
  gross_fee_value_pln     NUMERIC(14,2),
  gross_margin_value_pln  NUMERIC(14,2),
  number_of_products      INTEGER,
  number_of_passengers    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dwh_dm_sales_partner_id  ON dwh.dm_sales(partner_id);
CREATE INDEX IF NOT EXISTS idx_dwh_dm_sales_sale_date   ON dwh.dm_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_dwh_dm_partner_nip       ON dwh.dm_partner(nip);

-- ── 4. Dane testowe (tylko gdy tabele są puste — na PROD są realne dane) ──────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dwh.dm_partner LIMIT 1) THEN

    INSERT INTO dwh.dm_partner
      (partner_id, company_name, nip, subdomain, language, partner_currency,
       country, billing_address, billing_zip, billing_city, billing_country,
       billing_email_address, admin_first_name, admin_last_name, admin_email)
    VALUES
      (1, 'Sigma Hotels Sp. z o.o.',     'PL5271234567', 'sigmahotels',  'Polski',    'PLN',
       'Polska', 'ul. Hotelowa 12',     '00-001', 'Warszawa',  'Polska',
       'faktury@sigmahotels.pl',        'Anna',     'Kowalska',    'admin@sigmahotels.pl'),
      (2, 'Vanguard Travel S.A.',         'PL5262345678', 'vanguard',     'Angielski', 'EUR',
       'Polska', 'al. Jerozolimskie 65', '00-697', 'Warszawa',  'Polska',
       'finance@vanguardtravel.pl',     'Michał',   'Wiśniewski',  'admin@vanguardtravel.pl'),
      (3, 'EuroTravel Group Sp. z o.o.',  'PL5273456789', 'eurotravel',   'Angielski', 'EUR',
       'Polska', 'ul. Europejska 3',    '31-001', 'Kraków',    'Polska',
       'billing@eurotravel.pl',         'Piotr',    'Nowak',       'admin@eurotravel.pl'),
      (4, 'BizTrip Poland Sp. z o.o.',   'PL5264567890', 'biztrip',      'Polski',    'PLN',
       'Polska', 'ul. Biznesowa 7',     '60-001', 'Poznań',    'Polska',
       'rozliczenia@biztrip.pl',        'Karolina', 'Zielińska',   'admin@biztrip.pl'),
      (5, 'CorporateJet Sp. z o.o.',     'PL5275678901', 'corpjet',      'Angielski', 'PLN',
       'Polska', 'ul. Lotnicza 44',     '40-001', 'Katowice',  'Polska',
       'finance@corporatejet.pl',       'Tomasz',   'Lewandowski',  'admin@corporatejet.pl'),
      (6, 'NordTravel Sp. z o.o.',        'PL5266789012', 'nordtravel',   'Polski',    'PLN',
       'Polska', 'ul. Gdańska 9',       '80-001', 'Gdańsk',    'Polska',
       'rachunkowość@nordtravel.pl',    'Magdalena','Wójcik',      'admin@nordtravel.pl'),
      (7, 'Alpine Business Travel S.A.', 'PL5277890123', 'alpinebiz',    'Angielski', 'EUR',
       'Polska', 'ul. Górska 21',       '50-001', 'Wrocław',   'Polska',
       'fakturowanie@alpinebiz.pl',     'Łukasz',   'Dąbrowski',   'admin@alpinebiz.pl'),
      (8, 'MediaTravel Sp. z o.o.',       'PL5268901234', 'mediatravel',  'Rosyjski',  'PLN',
       'Polska', 'ul. Medialna 5',      '90-001', 'Łódź',      'Polska',
       'ksiegowosc@mediatravel.pl',     'Natalia',  'Krawczyk',    'admin@mediatravel.pl');

  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dwh.dm_sales LIMIT 1) THEN

    -- Generujemy 18 miesięcy danych (2024-01 do 2025-06) dla każdego partnera
    -- Kilka kategorii: hotel, transport_flight, transport_train, car_rental, other
    INSERT INTO dwh.dm_sales
      (partner_id, sale_date, service_category,
       gross_sales_value_pln, net_sales_value_pln, gross_fee_value_pln, gross_margin_value_pln,
       number_of_products, number_of_passengers)
    SELECT
      p.partner_id,
      (DATE_TRUNC('month', CURRENT_DATE) - (m.mon - 1) * INTERVAL '1 month')::date + (s.d - 1) AS sale_date,
      s.cat,
      s.gross,
      ROUND(s.gross * 0.90, 2),
      ROUND(s.gross * 0.10, 2),
      ROUND(s.gross * 0.14, 2),
      s.nprod,
      s.npax
    FROM (VALUES (1),(2),(3),(4),(5),(6),(7),(8)) AS p(partner_id),
    LATERAL (VALUES
      (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16),(17),(18)
    ) AS m(mon),
    LATERAL (
      SELECT * FROM (VALUES
        (1,  'hotel',           ROUND((150000 + p.partner_id * 20000 + m.mon * 5000 + RANDOM()*30000)::numeric, 2), 12 + p.partner_id, (12 + p.partner_id) * 18),
        (5,  'transport_flight',ROUND((60000  + p.partner_id * 8000  + m.mon * 2000 + RANDOM()*10000)::numeric, 2), 8  + p.partner_id, (8  + p.partner_id) * 6),
        (10, 'transport_train', ROUND((20000  + p.partner_id * 2000  + m.mon * 800  + RANDOM()*5000)::numeric, 2),  4  + p.partner_id, (4  + p.partner_id) * 10),
        (15, 'car_rental',      ROUND((30000  + p.partner_id * 3000  + m.mon * 1000 + RANDOM()*8000)::numeric, 2),  10 + p.partner_id, (10 + p.partner_id) * 1),
        (20, 'other',           ROUND((10000  + p.partner_id * 1000  + m.mon * 300  + RANDOM()*2000)::numeric, 2),  3  + p.partner_id, (3  + p.partner_id) * 2)
      ) AS raw(d, cat, gross, nprod, npax)
    ) AS s(d, cat, gross, nprod, npax);

  END IF;
END;
$$;
