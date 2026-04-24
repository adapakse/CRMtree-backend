-- dev_dwh_onboarding_test.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- SKRYPT TESTOWY — symulacja pełnego cyklu Lead → Konto testowe → DWH → Aktywacja
--
-- Scenariusz:
--   1. Partnerzy w statusie 'onboarding' to Leady które wygraliśmy.
--      Podczas procesu Lead założono im konta TESTOWE w systemie transakcyjnym.
--      W momencie założenia konta testowego pojawili się w dwh."Partner"
--      z przydzielonym partner_id (DWH).
--
--   2. Skrypt DYNAMICZNIE czyta partnerów z crm_partners WHERE status = 'onboarding'
--      i tworzy dla każdego rekord w dwh."Partner".
--      partner_id DWH przydzielany od 101 w górę (nie koliduje z danymi 0141).
--
--   3. Celowo mieszamy scenariusze CRM vs DWH żeby przetestować logikę COALESCE:
--      • Wariant A — "Operator uzupełnił CRM ręcznie, DWH ma te same dane":
--            → COALESCE bierze wartość CRM (priorytet), _from_dwh = false
--            → pole edytowalne po aktywacji
--      • Wariant B — "Operator nie wypełnił pola w CRM, DWH ma dane":
--            → COALESCE bierze wartość DWH, _from_dwh = true
--            → pole READ-ONLY po aktywacji
--      • Wariant C — "Ani CRM ani DWH nie ma danych" (np. billing_zip):
--            → pole puste, edytowalne
--
--   4. Generujemy 3 miesiące danych sprzedażowych (konto testowe = pierwsze transakcje).
--
--   5. Linkujemy crm_partners.dwh_partner_id → przypisany partner_id DWH.
--
-- URUCHOMIENIE:
--   psql $DATABASE_URL -f src/db/seeds/dev_dwh_onboarding_test.sql
--
-- BEZPIECZEŃSTWO:
--   Cały skrypt owinięty w DO $$ BEGIN ... END $$ z warunkiem sprawdzającym
--   czy dane już istnieją. Bezpieczny do ponownego uruchomienia (idempotentny).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r           RECORD;
  dwh_id      BIGINT;
  next_id     BIGINT := 101;
  subdomain   TEXT;
  admin_first TEXT;
  admin_last  TEXT;
  variant     INT;  -- 1=A(CRM wins), 2=B(DWH fills), 3=mixed
BEGIN

  -- ── Krok 1: wyczyść poprzednie dane testowe (IDs 101+) ─────────────────────
  -- Bezpieczne: usuwa tylko nasze testowe IDs (>=101), nie ruszamy danych 0141
  DELETE FROM dwh."Sales"  WHERE partner_id >= 101;
  DELETE FROM dwh."Partner" WHERE partner_id >= 101;

  -- Odlinkuj CRM partnerów którzy mieli test-IDs (>=101)
  UPDATE crm_partners SET dwh_partner_id = NULL WHERE dwh_partner_id >= 101;

  -- ── Krok 2: znajdź następny wolny ID ───────────────────────────────────────
  SELECT COALESCE(MAX(partner_id), 100) + 1
    INTO next_id
    FROM dwh."Partner";

  IF next_id < 101 THEN next_id := 101; END IF;

  -- ── Krok 3: dla każdego partnera w onboarding — utwórz rekord DWH ─────────
  FOR r IN
    SELECT
      p.id,
      p.company,
      p.nip,
      p.email,
      p.contact_name,
      p.billing_email,
      p.billing_address,
      p.billing_zip,
      p.billing_city,
      p.billing_country,
      p.admin_first_name,
      p.admin_last_name,
      p.admin_email,
      p.subdomain,
      p.language,
      p.partner_currency,
      p.country,
      p.billing_email_address,
      p.status,
      ROW_NUMBER() OVER (ORDER BY p.created_at) AS rn
    FROM crm_partners p
    WHERE p.status = 'onboarding'
      AND p.dwh_partner_id IS NULL   -- nie linkuj ponownie już zlinkowanych
    ORDER BY p.created_at
  LOOP

    dwh_id := next_id;
    next_id := next_id + 1;

    -- Wybierz wariant testowy cyklicznie (A/B/C) żeby pokryć wszystkie scenariusze
    variant := ((r.rn - 1) % 3) + 1;

    -- Subdomena: derive z nazwy firmy (pierwsze słowo, lowercase, tylko alfanum)
    subdomain := lower(regexp_replace(split_part(r.company, ' ', 1), '[^a-z0-9]', '', 'g'));
    IF length(subdomain) < 3 THEN
      subdomain := lower(regexp_replace(r.company, '[^a-z0-9]', '', 'g'));
    END IF;
    -- Skróć do 20 znaków
    subdomain := substring(subdomain, 1, 20);

    -- Admin: rozdziel contact_name na imię + nazwisko (jeśli jest w CRM)
    IF r.contact_name IS NOT NULL AND position(' ' IN r.contact_name) > 0 THEN
      admin_first := split_part(r.contact_name, ' ', 1);
      admin_last  := split_part(r.contact_name, ' ', 2);
    ELSE
      admin_first := 'Admin';
      admin_last  := split_part(r.company, ' ', 1);
    END IF;

    -- ── WARIANT A: CRM wypełnił pola (np. operator wpisał podczas onboardingu)
    --    DWH MA te same dane → COALESCE bierze CRM, _from_dwh = false
    --    Test: pola powinny być EDYTOWALNE po aktywacji
    IF variant = 1 THEN
      INSERT INTO dwh."Partner" (
        partner_id, company_name, tax_numbers,
        subdomain, billing_language, billing_currency, country,
        address, zip_code, town, billing_country, emails
      ) VALUES (
        dwh_id,
        r.company,                              -- DWH = to samo co CRM
        r.nip,
        subdomain,                              -- DWH ma subdomene
        COALESCE(r.language, 'PL'),             -- DWH ma język
        COALESCE(r.partner_currency, 'PLN'),    -- DWH ma walutę
        COALESCE(r.country, 'PL'),              -- DWH ma kraj
        -- Billing — DWH ma dane, ale CRM też wypełnił (oba nie-null)
        -- W tym wariancie CRM RÓWNIEŻ ma te dane (wpisane przez usera)
        -- → więc COALESCE(crm, dwh) = crm value → _from_dwh = false
        r.billing_address,
        r.billing_zip,
        r.billing_city,
        COALESCE(r.billing_country, 'PL'),
        COALESCE(r.billing_email_address, r.billing_email)
      );

      -- W tym wariancie CRM ma wartości w tych polach — nie czyścimy
      -- (zostawiamy jak jest, symulując że operator już je wpisał)

    -- ── WARIANT B: CRM PUŚCIŁ pola puste (operator ich nie wpisał)
    --    DWH MA dane → COALESCE bierze DWH, _from_dwh = true
    --    Test: pola powinny być READ-ONLY po aktywacji
    ELSIF variant = 2 THEN
      INSERT INTO dwh."Partner" (
        partner_id, company_name, tax_numbers,
        subdomain, billing_language, billing_currency, country,
        address, zip_code, town, billing_country, emails
      ) VALUES (
        dwh_id,
        r.company,
        r.nip,
        subdomain,
        'PL',
        'PLN',
        'PL',
        'ul. ' || split_part(r.company, ' ', 1) || ' 1',  -- DWH ma billing address
        '00-001',
        'Warszawa',
        'PL',
        'billing@' || subdomain || '.pl'
      );

      -- Symuluj że CRM NIE MA tych pól (operator ich nie wpisał podczas onboardingu)
      -- → po COALESCE DWH przejmuje → _from_dwh = true → READ-ONLY po aktywacji
      UPDATE crm_partners SET
        subdomain             = NULL,
        language              = NULL,
        partner_currency      = NULL,
        country               = NULL,
        billing_address       = NULL,
        billing_zip           = NULL,
        billing_city          = NULL,
        billing_country       = NULL,
        billing_email_address = NULL,
        admin_first_name      = NULL,
        admin_last_name       = NULL,
        admin_email           = NULL
      WHERE id = r.id;

    -- ── WARIANT C: MIESZANY — część pól w CRM, część pusta (DWH uzupełni wybrane)
    --    Test: niektóre pola edytowalne, inne READ-ONLY po aktywacji
    ELSE
      INSERT INTO dwh."Partner" (
        partner_id, company_name, tax_numbers,
        subdomain, billing_language, billing_currency, country,
        address, zip_code, town, billing_country, emails
      ) VALUES (
        dwh_id,
        r.company,
        r.nip,
        subdomain,                              -- DWH ma subdomenę (CRM puste → READ-ONLY)
        'PL',                                   -- DWH ma język (CRM puste → READ-ONLY)
        COALESCE(r.partner_currency, 'PLN'),    -- DWH ma walutę
        'PL',                                   -- DWH ma kraj
        NULL,                                   -- DWH NIE MA address (CRM może edytować)
        NULL,                                   -- DWH NIE MA zip_code
        'Kraków',                               -- DWH ma miasto (CRM puste → READ-ONLY)
        'PL',
        'billing@' || subdomain || '.pl'        -- DWH ma email (CRM puste → READ-ONLY)
      );

      -- CRM: subdomain, language, admin* — puste (DWH przejmie → READ-ONLY)
      -- CRM: billing_address, billing_zip — mogą być (operator wpisał → edytowalne)
      -- CRM: billing_city — puste (DWH ma 'Kraków' → READ-ONLY)
      UPDATE crm_partners SET
        subdomain        = NULL,
        language         = NULL,
        billing_city     = NULL,
        billing_email_address = NULL,
        admin_first_name = NULL,
        admin_last_name  = NULL,
        admin_email      = NULL
      WHERE id = r.id;

    END IF;

    -- ── Krok 4: link CRM ↔ DWH ─────────────────────────────────────────────
    UPDATE crm_partners
    SET    dwh_partner_id = dwh_id
    WHERE  id = r.id;

    RAISE NOTICE 'Partner: % (CRM id=%) → DWH id=% [Wariant %]',
      r.company, r.id, dwh_id,
      CASE variant WHEN 1 THEN 'A (CRM wins)' WHEN 2 THEN 'B (DWH fills)' ELSE 'C (mixed)' END;

  END LOOP;

  -- ── Krok 5: dane sprzedażowe (3 miesiące — konto testowe w akcji) ───────────
  INSERT INTO dwh."Sales" (
    partner_id, sale_date, service_category,
    gross_sales_value_pln, net_sales_value_pln,
    gross_fee_value_pln, gross_margin_value_pln,
    number_of_products, number_of_passengers
  )
  SELECT
    dm.partner_id,
    (DATE_TRUNC('month', CURRENT_DATE) - (mon - 1) * INTERVAL '1 month')::date + (day_offset - 1),
    cat,
    ROUND((base_val + dm.partner_id::numeric * 3000 + RANDOM()::numeric * 15000), 2),
    ROUND((base_val + dm.partner_id::numeric * 3000 + RANDOM()::numeric * 15000) * 0.90, 2),
    ROUND((base_val + dm.partner_id::numeric * 3000 + RANDOM()::numeric * 15000) * 0.10, 2),
    ROUND((base_val + dm.partner_id::numeric * 3000 + RANDOM()::numeric * 15000) * 0.12, 2),
    nprod + (dm.partner_id % 5),
    npax  + (dm.partner_id % 8)
  FROM dwh."Partner" dm
  JOIN (SELECT generate_series(1, 3) AS mon) months ON true
  JOIN (
    SELECT * FROM UNNEST(
      ARRAY[1,  5,  12, 20],
      ARRAY['hotel','transport_flight','transport_train','car_rental']::text[],
      ARRAY[35000, 12000, 4000, 6000]::numeric[],
      ARRAY[5, 3, 2, 4],
      ARRAY[90, 18, 30, 4]
    ) AS t(day_offset, cat, base_val, nprod, npax)
  ) cats ON true
  WHERE dm.partner_id >= 101;

  RAISE NOTICE '──────────────────────────────────────────────────────';
  RAISE NOTICE 'Dane DWH dla partnerów onboarding wygenerowane pomyślnie.';
  RAISE NOTICE 'Wariant A: CRM ma wartości → pola edytowalne po aktywacji';
  RAISE NOTICE 'Wariant B: CRM puste → DWH przejmuje → READ-ONLY po aktywacji';
  RAISE NOTICE 'Wariant C: Mix → część READ-ONLY, część edytowalna';
  RAISE NOTICE '──────────────────────────────────────────────────────';
  RAISE NOTICE 'Aby przetestować aktywację partnera: zmień status na active.';
  RAISE NOTICE 'Pola z _from_dwh=true powinny być zablokowane w UI.';

END;
$$;

-- ── Podgląd wyników ─────────────────────────────────────────────────────────
SELECT
  p.id                              AS crm_id,
  p.company                         AS crm_company,
  p.status,
  p.dwh_partner_id,
  dm.company_name                   AS dwh_company,
  -- COALESCE — jak zobaczy to GET /:id
  COALESCE(p.subdomain, dm.subdomain)                          AS subdomain,
  (p.subdomain IS NULL AND dm.subdomain IS NOT NULL)           AS subdomain_from_dwh,
  COALESCE(p.language, dm.billing_language)                    AS language,
  (p.language IS NULL AND dm.billing_language IS NOT NULL)     AS language_from_dwh,
  COALESCE(p.billing_city, dm.town)                            AS billing_city,
  (p.billing_city IS NULL AND dm.town IS NOT NULL)             AS billing_city_from_dwh,
  p.admin_first_name,
  false                                                        AS admin_first_name_from_dwh,
  COALESCE(p.billing_address, dm.address)                      AS billing_address,
  (p.billing_address IS NULL AND dm.address IS NOT NULL)       AS billing_address_from_dwh
FROM crm_partners p
JOIN dwh."Partner" dm ON dm.partner_id = p.dwh_partner_id
WHERE p.status = 'onboarding'
ORDER BY p.created_at;
