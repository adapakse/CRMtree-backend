-- ============================================================
-- 0318 — INT only: dane demo CRM dla tenanta `brmtree-test1`
--
-- Tenant `brmtree-test1` na INT (https://brmtree-test1.int.crmtree.pl) ma
-- podlinkowane dane sprzedazowe w hurtowni (0313) i modul Projekty (0314),
-- ale glowny dashboard CRM, Pipeline leadow, Wyniki partnerow i Odnowienia
-- byly puste — nie bylo leadow w kolejnych etapach lejka, aktywnosci
-- rozlozonych w czasie, szans, transakcji ani zadan onboardingowych.
--
-- Seed dosylany jako migracja, bo baza INT jest osiagalna tylko z pipeline'u
-- deployu. Poza INT nic nie robi: pierwszy warunek to nazwa bazy, drugi tenant.
--
-- Dane po polsku (ustalone 2026-10-06). Modul Projekty zostaje po angielsku
-- tak, jak go zasial 0314 — tenant bedzie jezykowo mieszany i to jest swiadome.
--
-- WLASCICIEL DANYCH: wiekszosc rekordow trafia na konto `beata.momot` z tego
-- tenanta (dopasowanie po prefiksie adresu e-mail). Przy roli 'salesperson'
-- CRM pokazuje wylacznie wlasne rekordy, wiec bez tego jej dashboard bylby
-- pusty mimo zasianych danych. Co czwarty rekord idzie do innego handlowca,
-- zeby podzial na opiekunow wygladal realnie. Gdy konta nie ma — seed wraca do
-- rozkladu po wszystkich uzytkownikach i wypisuje NOTICE.
--
-- IDEMPOTENTNOSC: wiersze demo zyja w zarezerwowanych zakresach id (9_1xx_xxx
-- .. 9_7xx_xxx) i sa kasowane przed ponownym wstawieniem, wiec migracje mozna
-- bezpiecznie powtorzyc. Zakresy sa tak wysokie, ze sekwencje tabel nigdy ich
-- nie dosiegna, wiec zwykle wstawianie przez aplikacje nie zderzy sie z nimi i
-- nie trzeba ruszac setval. Ten sam pomysl co zakres 910001–910999 w 0313.
--
-- CZEGO TU NIE MA: workflow_tasks. Ta tabela wymaga document_id NOT NULL,
-- czyli istniejacego dokumentu w modulu Dokumenty — zasianie jej na slepo
-- tworzylo by zadania wiszace przy dokumentach, ktorych tenant nie ma.
-- Kafel zadan na dashboardzie zasilaja tu crm_lead_activities i
-- crm_onboarding_tasks, ktore wystarcza, zeby nie byl pusty.
-- ============================================================

DO $$
DECLARE
  -- Zarezerwowane zakresy id dla wierszy demo
  c_lead_base      CONSTANT integer := 9100000;
  c_lact_base      CONSTANT integer := 9200000;
  c_pact_base      CONSTANT integer := 9300000;
  c_opp_base       CONSTANT integer := 9400000;
  c_tx_base        CONSTANT integer := 9500000;
  c_txp_base       CONSTANT integer := 9600000;
  c_onb_base       CONSTANT integer := 9700000;
  c_range          CONSTANT integer := 99999;

  v_tenant_id      uuid;
  v_owner          uuid;        -- tworca wierszy (created_by)
  v_sales          uuid[];      -- handlowcy, na ktorych rozkladamy rekordy
  v_sales_count    integer;
  v_beata          uuid;        -- gdy istnieje: glowny wlasciciel danych demo
  v_partners       uuid[];
  v_partner_count  integer;

  v_today          date := CURRENT_DATE;
  i                integer;
  v_id             integer;
  v_lead_id        integer;
  v_partner        uuid;
  v_assignee       uuid;
  v_tx_id          integer;
  v_month          date;
  v_gross          numeric;
  v_net            numeric;

  -- Realne wartosci z app_settings, nie wymyslone
  c_stages   CONSTANT text[] := ARRAY['new','qualification','presentation','offer','negotiation','closed_won','closed_lost'];
  c_sources  CONSTANT text[] := ARRAY['Własne','Cold_Call','Partner','LinkedIn_Lead_Form','Formularz_online','GoogleAds_PMax'];
  c_prio     CONSTANT text[] := ARRAY['asap','important','medium','low'];
  c_products CONSTANT text[] := ARRAY['hotel','transport_flight','car_rental','transfer','travel_insurance'];

  c_companies CONSTANT text[] := ARRAY[
    'Nordwind Logistyka Sp. z o.o.','Karpacka Grupa Budowlana S.A.','Vistula Software House',
    'Bałtyckie Chłodnie Sp. z o.o.','Mazowiecka Fabryka Okien','Silesia Precision Tools S.A.',
    'Pomorski Dystrybutor Farb','Lubelskie Zakłady Mięsne','Wielkopolski Instytut Badań',
    'Dolnośląska Energia Odnawialna','Podlaski Transport Chłodniczy','Kujawska Grupa Medyczna',
    'Świętokrzyskie Kopalnie Kruszyw','Opolska Przetwórnia Owoców','Warmińskie Centrum Logistyki',
    'Łódzka Manufaktura Tekstylna','Małopolski Klaster IT','Lubuskie Tartaki Nadrzeczne'
  ];
  c_contacts CONSTANT text[] := ARRAY[
    'Anna Wiśniewska','Marek Zieliński','Katarzyna Dąbrowska','Tomasz Lewandowski',
    'Magdalena Kaczmarek','Piotr Grabowski','Joanna Pawlak','Rafał Sikora','Ewa Michalak',
    'Grzegorz Adamczyk','Monika Król','Łukasz Baran','Agnieszka Duda','Krzysztof Sadowski',
    'Beata Czarnecka','Paweł Wróblewski','Dorota Jasińska','Marcin Olszewski'
  ];
  c_titles CONSTANT text[] := ARRAY[
    'Dyrektor Zakupów','Prezes Zarządu','Kierownik Administracji','Dyrektor Finansowy',
    'Specjalista ds. Podróży','Kierownik Działu HR'
  ];
BEGIN
  IF current_database() <> 'crmtreedb_int' THEN
    RAISE NOTICE '0318: to nie baza INT (%), nic nie zasiewam', current_database();
    RETURN;
  END IF;

  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'brmtree-test1' AND deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE '0318: brak tenanta brmtree-test1, nic nie zasiewam';
    RETURN;
  END IF;

  -- Handlowcy tenanta — na nich rozkladamy leady i zadania, zeby filtr
  -- "przypisane do mnie" i podzial na opiekunow mialy sens.
  SELECT array_agg(id ORDER BY email) INTO v_sales
    FROM users
   WHERE tenant_id = v_tenant_id AND is_active = true
     AND (crm_role IN ('salesperson','sales_manager') OR is_admin = true);

  IF v_sales IS NULL OR array_length(v_sales, 1) = 0 THEN
    RAISE NOTICE '0318: tenant brmtree-test1 nie ma aktywnych uzytkownikow, nic nie zasiewam';
    RETURN;
  END IF;
  v_sales_count := array_length(v_sales, 1);
  v_owner := v_sales[1];

  -- Konto Beaty. Wiekszosc danych demo musi nalezec wlasnie do niej: przy roli
  -- 'salesperson' loadCrmScope zawezia widocznosc do wlasnych rekordow, wiec
  -- rozlozenie round-robin po wszystkich uzytkownikach zostawiloby jej prawie
  -- pusty dashboard. Dopasowanie po prefiksie adresu, bo domena tenanta na INT
  -- moze byc inna niz zakladamy.
  SELECT id INTO v_beata
    FROM users
   WHERE tenant_id = v_tenant_id AND is_active = true
     AND lower(email) LIKE 'beata.momot%'
   ORDER BY email
   LIMIT 1;

  IF v_beata IS NULL THEN
    RAISE NOTICE '0318: nie znaleziono konta beata.momot — dane zostana rozlozone po wszystkich handlowcach';
  END IF;

  SELECT array_agg(id ORDER BY company) INTO v_partners
    FROM crm_partners WHERE tenant_id = v_tenant_id;
  v_partner_count := COALESCE(array_length(v_partners, 1), 0);

  -- ── Czyszczenie poprzedniego przebiegu (tylko wiersze demo) ──────────────
  DELETE FROM crm_transaction_products
   WHERE tenant_id = v_tenant_id AND id BETWEEN c_txp_base AND c_txp_base + c_range;
  DELETE FROM crm_transactions
   WHERE tenant_id = v_tenant_id AND id BETWEEN c_tx_base AND c_tx_base + c_range;
  DELETE FROM crm_opportunities
   WHERE tenant_id = v_tenant_id AND id BETWEEN c_opp_base AND c_opp_base + c_range;
  DELETE FROM crm_onboarding_tasks
   WHERE tenant_id = v_tenant_id AND id BETWEEN c_onb_base AND c_onb_base + c_range;
  DELETE FROM crm_partner_activities
   WHERE tenant_id = v_tenant_id AND id BETWEEN c_pact_base AND c_pact_base + c_range;
  DELETE FROM crm_lead_activities
   WHERE tenant_id = v_tenant_id AND id BETWEEN c_lact_base AND c_lact_base + c_range;
  DELETE FROM crm_leads
   WHERE tenant_id = v_tenant_id AND id BETWEEN c_lead_base AND c_lead_base + c_range;

  -- ── 1. LEADY — po kilka w kazdym etapie lejka ────────────────────────────
  -- 18 leadow rozlozonych na 7 etapow, z wartosciami, prawdopodobienstwem i
  -- datami zamkniecia w przyszlosci (otwarte) lub przeszlosci (zamkniete).
  FOR i IN 1..18 LOOP
    v_id       := c_lead_base + i;
    -- Co czwarty rekord dostaje inny handlowiec, zeby podzial na opiekunow
    -- wygladal realnie; reszta nalezy do Beaty.
    v_assignee := CASE
      WHEN v_beata IS NOT NULL AND i % 4 <> 0 THEN v_beata
      ELSE v_sales[1 + (i % v_sales_count)]
    END;

    INSERT INTO crm_leads (
      id, company, contact_name, contact_title, email, phone, source, stage,
      value_pln, probability, close_date, industry, assigned_to, tags, notes,
      hot, created_by, created_at, first_contact_date, tenant_id
    ) VALUES (
      v_id,
      c_companies[i],
      c_contacts[i],
      c_titles[1 + (i % array_length(c_titles, 1))],
      'kontakt' || i || '@demo-crmtree.pl',
      '+48 ' || (500 + i) || ' ' || (100 + i) || ' ' || (200 + i),
      c_sources[1 + (i % array_length(c_sources, 1))],
      c_stages[1 + ((i - 1) % 7)],
      (25000 + (i * 8500))::numeric,
      CASE c_stages[1 + ((i - 1) % 7)]
        WHEN 'new' THEN 10 WHEN 'qualification' THEN 25 WHEN 'presentation' THEN 40
        WHEN 'offer' THEN 60 WHEN 'negotiation' THEN 80
        WHEN 'closed_won' THEN 100 ELSE 0 END,
      CASE
        WHEN c_stages[1 + ((i - 1) % 7)] IN ('closed_won','closed_lost')
          THEN v_today - ((i * 11) % 90)
        ELSE v_today + ((i * 9) % 75) + 5
      END,
      CASE WHEN i % 3 = 0 THEN 'Produkcja' WHEN i % 3 = 1 THEN 'Logistyka' ELSE 'Usługi IT' END,
      v_assignee,
      ARRAY['demo'],
      'Lead demonstracyjny — dane przykładowe do prezentacji i testów.',
      (i % 5 = 0),
      v_owner,
      NOW() - ((i * 6) || ' days')::interval,
      v_today - ((i * 6) % 120),
      v_tenant_id
    );
  END LOOP;

  -- ── 2. AKTYWNOSCI LEADOW — zadania przeterminowane, na dzis i przyszle ───
  -- Dashboard liczy kafle po reminder_at/activity_at i status, wiec rozkladamy
  -- je tak, zeby kazdy kafel mial co pokazac.
  i := 0;
  FOR v_lead_id IN SELECT id FROM crm_leads
                    WHERE tenant_id = v_tenant_id
                      AND id BETWEEN c_lead_base AND c_lead_base + c_range
                    ORDER BY id LOOP
    i := i + 1;
    -- Co czwarty rekord dostaje inny handlowiec, zeby podzial na opiekunow
    -- wygladal realnie; reszta nalezy do Beaty.
    v_assignee := CASE
      WHEN v_beata IS NOT NULL AND i % 4 <> 0 THEN v_beata
      ELSE v_sales[1 + (i % v_sales_count)]
    END;

    -- a) historia: zamknieta rozmowa telefoniczna w przeszlosci
    INSERT INTO crm_lead_activities (
      id, lead_id, type, title, body, activity_at, duration_min, status,
      assigned_to, created_by, created_at, tenant_id, priority, is_read
    ) VALUES (
      c_lact_base + (i * 10) + 1, v_lead_id, 'call',
      'Pierwszy kontakt telefoniczny',
      'Rozmowa wstępna — rozpoznanie potrzeb i skali wyjazdów służbowych.',
      NOW() - ((i * 5 + 20) || ' days')::interval, 18, 'closed',
      v_assignee, v_owner, NOW() - ((i * 5 + 20) || ' days')::interval, v_tenant_id, 'medium', true
    );

    -- b) historia: wyslana oferta
    INSERT INTO crm_lead_activities (
      id, lead_id, type, title, body, activity_at, status,
      assigned_to, created_by, created_at, tenant_id, priority, is_read
    ) VALUES (
      c_lact_base + (i * 10) + 2, v_lead_id, 'email',
      'Wysłana oferta wstępna',
      'Przesłano ofertę z cennikiem i zakresem obsługi.',
      NOW() - ((i * 4 + 9) || ' days')::interval, 'closed',
      v_assignee, v_owner, NOW() - ((i * 4 + 9) || ' days')::interval, v_tenant_id, 'medium', true
    );

    -- c) zadanie: co trzeci lead ma zaleglosc (reminder w przeszlosci)
    IF i % 3 = 0 THEN
      INSERT INTO crm_lead_activities (
        id, lead_id, type, title, body, activity_at, status, assigned_to,
        created_by, created_at, tenant_id, priority, reminder_type, reminder_at,
        reminder_sent, is_read
      ) VALUES (
        c_lact_base + (i * 10) + 3, v_lead_id, 'task',
        'Pilny follow-up — klient czeka na odpowiedź',
        'Zadanie przeterminowane — pokazuje kafel zaległości na dashboardzie.',
        NOW() - '2 days'::interval, 'open', v_assignee,
        v_owner, NOW() - '9 days'::interval, v_tenant_id, 'asap', 'task',
        NOW() - '2 days'::interval, true, false
      );
    END IF;

    -- d) zadanie: co czwarty lead ma zadanie na dzis
    IF i % 4 = 0 THEN
      INSERT INTO crm_lead_activities (
        id, lead_id, type, title, body, activity_at, status, assigned_to,
        created_by, created_at, tenant_id, priority, reminder_type, reminder_at,
        reminder_sent, is_read
      ) VALUES (
        c_lact_base + (i * 10) + 4, v_lead_id, 'meeting',
        'Spotkanie prezentacyjne u klienta',
        'Zaplanowane na dziś — kafel „na dziś" na dashboardzie.',
        v_today + TIME '11:00', 'open', v_assignee,
        v_owner, NOW() - '5 days'::interval, v_tenant_id, 'important', 'meeting',
        v_today + TIME '11:00', false, false
      );
    END IF;

    -- e) zadanie przyszle dla kazdego otwartego leada
    IF (SELECT stage FROM crm_leads WHERE id = v_lead_id) NOT IN ('closed_won','closed_lost') THEN
      INSERT INTO crm_lead_activities (
        id, lead_id, type, title, body, activity_at, status, assigned_to,
        created_by, created_at, tenant_id, priority, reminder_type, reminder_at,
        reminder_sent, is_read
      ) VALUES (
        c_lact_base + (i * 10) + 5, v_lead_id, 'task',
        'Przypomnieć się w sprawie decyzji',
        'Zadanie zaplanowane na przyszłość.',
        NOW() + ((i % 12 + 2) || ' days')::interval, 'new', v_assignee,
        v_owner, NOW() - '3 days'::interval, v_tenant_id,
        c_prio[1 + (i % 4)], 'task',
        NOW() + ((i % 12 + 2) || ' days')::interval, false, false
      );
    END IF;

    -- f) notatka
    INSERT INTO crm_lead_activities (
      id, lead_id, type, title, body, activity_at, status, assigned_to,
      created_by, created_at, tenant_id, is_read
    ) VALUES (
      c_lact_base + (i * 10) + 6, v_lead_id, 'note',
      'Notatka z rozpoznania',
      'Klient porównuje dwóch dostawców, decyzja po stronie zarządu.',
      NOW() - ((i * 3 + 4) || ' days')::interval, 'closed', v_assignee,
      v_owner, NOW() - ((i * 3 + 4) || ' days')::interval, v_tenant_id, true
    );
  END LOOP;

  -- ── 3. PARTNERZY: aktywnosci, szanse, transakcje, onboarding ─────────────
  IF v_partner_count = 0 THEN
    RAISE NOTICE '0318: tenant nie ma partnerow — pomijam aktywnosci partnerow, szanse, transakcje i onboarding';
  ELSE
    i := 0;
    FOREACH v_partner IN ARRAY v_partners LOOP
      i := i + 1;
      EXIT WHEN i > 20;   -- nie zasmiecamy, 20 partnerow wystarcza na wykresy
      -- Co czwarty rekord dostaje inny handlowiec, zeby podzial na opiekunow
    -- wygladal realnie; reszta nalezy do Beaty.
    v_assignee := CASE
      WHEN v_beata IS NOT NULL AND i % 4 <> 0 THEN v_beata
      ELSE v_sales[1 + (i % v_sales_count)]
    END;

      -- 3a. aktywnosci partnera
      INSERT INTO crm_partner_activities (
        id, partner_id, type, title, body, activity_at, duration_min, status,
        assigned_to, created_by, created_at, tenant_id, priority, is_read
      ) VALUES (
        c_pact_base + (i * 10) + 1, v_partner, 'call',
        'Przegląd kwartalny współpracy',
        'Omówienie wolumenów i poziomu obsługi w ostatnim kwartale.',
        NOW() - ((i * 7 + 12) || ' days')::interval, 35, 'closed',
        v_assignee, v_owner, NOW() - ((i * 7 + 12) || ' days')::interval, v_tenant_id, 'medium', true
      );

      IF i % 3 = 0 THEN
        INSERT INTO crm_partner_activities (
          id, partner_id, type, title, body, activity_at, status, assigned_to,
          created_by, created_at, tenant_id, priority, reminder_type, reminder_at,
          reminder_sent, is_read
        ) VALUES (
          c_pact_base + (i * 10) + 2, v_partner, 'task',
          'Zebrać dokumenty do odnowienia umowy',
          'Zadanie otwarte z terminem w przyszłym tygodniu.',
          NOW() + '6 days'::interval, 'open', v_assignee,
          v_owner, NOW() - '4 days'::interval, v_tenant_id, 'important', 'task',
          NOW() + '6 days'::interval, false, false
        );
      END IF;

      -- 3b. szanse sprzedazy (dashboard liczy tylko status='open')
      INSERT INTO crm_opportunities (
        id, partner_id, type, title, description, value_pln, status,
        assigned_to, created_by, created_at, tenant_id
      ) VALUES (
        c_opp_base + (i * 10) + 1, v_partner, 'upsell',
        'Rozszerzenie obsługi na oddziały zagraniczne',
        'Szansa demonstracyjna — upsell obsługi podróży dla kolejnych lokalizacji.',
        (40000 + (i * 12500))::numeric, 'open',
        v_assignee, v_owner, NOW() - ((i * 8) || ' days')::interval, v_tenant_id
      );

      IF i % 4 = 0 THEN
        INSERT INTO crm_opportunities (
          id, partner_id, type, title, description, value_pln, status,
          assigned_to, created_by, created_at, tenant_id
        ) VALUES (
          c_opp_base + (i * 10) + 2, v_partner, 'cross_sell',
          'Dodatkowy moduł ubezpieczeń podróżnych',
          'Szansa demonstracyjna — cross-sell ubezpieczeń.',
          (18000 + (i * 4200))::numeric, 'open',
          v_assignee, v_owner, NOW() - ((i * 5) || ' days')::interval, v_tenant_id
        );
      END IF;

      -- 3c. transakcje: 12 miesiecy wstecz, po jednej na miesiac
      FOR v_month IN
        SELECT generate_series(
          date_trunc('month', v_today) - INTERVAL '11 months',
          date_trunc('month', v_today),
          INTERVAL '1 month')::date
      LOOP
        v_tx_id := c_tx_base + (i * 100) + EXTRACT(MONTH FROM v_month)::integer;
        v_gross := (9000 + (i * 650) + (EXTRACT(MONTH FROM v_month)::integer * 420))::numeric;
        v_net   := round(v_gross * 0.86, 2);

        INSERT INTO crm_transactions (
          id, booking_ref, transaction_date, traveler_name, total_net, total_gross,
          total_commission, total_margin, currency, status, partner_id, tenant_id,
          created_at
        ) VALUES (
          v_tx_id,
          'DEMO-' || i || '-' || to_char(v_month, 'YYYYMM'),
          v_month + INTERVAL '12 days',
          c_contacts[1 + (i % array_length(c_contacts, 1))],
          v_net, v_gross,
          round(v_gross * 0.07, 2), round(v_gross - v_net, 2),
          'PLN', 'confirmed', v_partner, v_tenant_id,
          v_month + INTERVAL '12 days'
        );

        INSERT INTO crm_transaction_products (
          id, transaction_id, product_type, product_name, supplier,
          net_cost, gross_cost, commission_pct, commission_amt, margin_amt,
          currency, pax_count, tenant_id
        ) VALUES (
          c_txp_base + (i * 100) + EXTRACT(MONTH FROM v_month)::integer,
          v_tx_id,
          c_products[1 + ((i + EXTRACT(MONTH FROM v_month)::integer) % array_length(c_products, 1))],
          'Usługa demonstracyjna',
          'Dostawca Demo Sp. z o.o.',
          v_net, v_gross, 7.00, round(v_gross * 0.07, 2), round(v_gross - v_net, 2),
          'PLN', 1 + (i % 3), v_tenant_id
        );
      END LOOP;

      -- 3d. zadania onboardingowe — tylko dla partnerow w onboardingu
      IF (SELECT status FROM crm_partners WHERE id = v_partner) = 'onboarding' THEN
        INSERT INTO crm_onboarding_tasks
          (id, partner_id, step, title, body, type, assigned_to, due_date, done, done_at, done_by, created_by, created_at, tenant_id)
        VALUES
          (c_onb_base + (i * 10) + 1, v_partner, 0, 'Spotkanie startowe z klientem',
           'Przedstawienie zespołu i ustalenie harmonogramu wdrożenia.', 'meeting',
           v_assignee, v_today - 12, true, NOW() - '12 days'::interval, v_assignee,
           v_owner, NOW() - '20 days'::interval, v_tenant_id),
          (c_onb_base + (i * 10) + 2, v_partner, 1, 'Przekazanie danych do konfiguracji',
           'Lista pracowników, centra kosztów, polityka podróży.', 'doc_sent',
           v_assignee, v_today - 4, true, NOW() - '4 days'::interval, v_assignee,
           v_owner, NOW() - '18 days'::interval, v_tenant_id),
          (c_onb_base + (i * 10) + 3, v_partner, 2, 'Szkolenie dla użytkowników',
           'Szkolenie zdalne, dwie grupy po 60 minut.', 'training',
           v_assignee, v_today + 3, false, NULL, NULL,
           v_owner, NOW() - '15 days'::interval, v_tenant_id),
          (c_onb_base + (i * 10) + 4, v_partner, 3, 'Potwierdzenie uruchomienia produkcyjnego',
           'Zgoda klienta na przejście na pełną obsługę.', 'task',
           v_assignee, v_today + 10, false, NULL, NULL,
           v_owner, NOW() - '10 days'::interval, v_tenant_id);
      END IF;
    END LOOP;

    -- 3e. ODNOWIENIA: daty wygasniecia umow w najblizszych miesiacach, zeby
    -- widget Odnowien nie byl pusty.
    --
    -- UWAGA: to jedyny fragment tego seeda, ktory dotyka istniejacych wierszy
    -- tenanta, a nie wstawia wlasnych. Dlatego warunek contract_expires IS NULL
    -- — wypelniamy wylacznie puste pola i nigdy nie nadpisujemy daty, ktora
    -- ktos wpisal. Blok czyszczacy na gorze tego nie cofa (nie da sie odtworzyc
    -- "bylo NULL"), wiec jest to zmiana jednokierunkowa. Przy powtornym
    -- uruchomieniu nic tu sie juz nie wykona.
    WITH ponumerowani AS (
      SELECT id, row_number() OVER (ORDER BY company) AS lp
        FROM crm_partners
       WHERE tenant_id = v_tenant_id AND contract_expires IS NULL
    )
    UPDATE crm_partners p
       SET contract_expires = v_today + 15 + ((n.lp * 23) % 150)::integer,
           updated_at = NOW()
      FROM ponumerowani n
     WHERE p.id = n.id;

    -- 3f. OPIEKUN PARTNERA: bez tego zakladka "Wyniki partnerow" i widget
    -- Odnowien beda dla Beaty puste, jesli ma role 'salesperson' — scope
    -- partnerow idzie po manager_id. Ta sama zasada co wyzej: ustawiamy
    -- WYLACZNIE tam, gdzie opiekuna nie ma, nigdy nie odbieramy partnera
    -- komus, kto jest juz przypisany. Zmiana jednokierunkowa, blok czyszczacy
    -- jej nie cofa.
    IF v_beata IS NOT NULL THEN
      UPDATE crm_partners
         SET manager_id = v_beata,
             updated_at = NOW()
       WHERE tenant_id = v_tenant_id
         AND manager_id IS NULL;
    END IF;
  END IF;

  RAISE NOTICE '0318: zasiano dane demo CRM dla brmtree-test1 (handlowcow: %, partnerow uzytych: %, konto beata.momot: %)',
    v_sales_count, LEAST(v_partner_count, 20),
    COALESCE(v_beata::text, 'NIE ZNALEZIONO');
END $$;
