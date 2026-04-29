-- Przypisuje handlowca (manager_id) do crm_partners na podstawie pola
-- customer_service_note w dwh.partner. Dopasowanie po imieniu i nazwisku
-- (pełna forma, first+last, wersja bez polskich znaków, zdrobnienia).
--
-- Dla partnerów DWH bez rekordu w crm_partners: tworzy nowy rekord (status='active').
-- Dla istniejących rekordów bez manager_id: uzupełnia manager_id.
-- Nie nadpisuje już przypisanych handlowców.

WITH user_meta (display_name, email_name, nickname) AS (
  VALUES
    ('Katarzyna Kulikowska',     'Katarzyna Kulikowska',  'Kasia Kulikowska'),
    ('Łukasz Chrabąszcz',        'Lukasz Chrabaszcz',      NULL),
    ('Anna Redzinska',            'Anna Redzinska',         'Ania Redzinska'),
    ('Wioletta Jaworska',         'Wioletta Jaworska',      'Wiola Jaworska'),
    ('Patrycja Milczarek',        'Patrycja Milczarek',     NULL),
    ('Daniel Petryk',             'Daniel Petryk',          NULL),
    ('Angelika Wojniak',          'Angelika Wojniak',       NULL),
    ('Michał Jarosławski',        'Michal Jaroslawski',     'Michal Jaroslawski'),
    ('Katarzyna Syguła-Šimunová', 'Katarzyna Sygula',       'Kasia Syguła'),
    ('Weronika Dega',             'Weronika Dega',          NULL),
    ('Beata Golubińska',          'Beata Golubinska',       NULL),
    ('Barbara Radomska',          'Barbara Radomska',       'Basia Radomska'),
    ('Anna Siewczyk',             'Anna Siewczyk',          'Ania Siewczyk'),
    ('Ireneusz Słomski',          'Ireneusz Slomski',       'Irek Słomski'),
    ('Michał Gramatnikowski',     'Michal Gramatnikowski',  NULL),
    ('Paweł Tomczyk',             'Pawel Tomczyk',          NULL),
    ('Szymon Kubica',             'Szymon Kubica',          NULL),
    ('Dominik Biegaj',            'Dominik Biegaj',         NULL),
    ('Jakub Nestorowicz',         'Jakub Nestorowicz',      NULL)
),
users_list AS (
  SELECT
    u.id                                AS user_id,
    u.display_name,
    split_part(u.display_name, ' ', 1)  AS first_name,
    split_part(u.display_name, ' ', 2)  AS last_name,
    m.email_name,
    m.nickname
  FROM users u
  JOIN user_meta m ON m.display_name = u.display_name
),
matches AS (
  SELECT DISTINCT ON (dm.partner_id)
    dm.partner_id                              AS dwh_id,
    COALESCE(dm.company_name, dm.name)         AS company,
    ul.user_id,
    CASE
      WHEN dm.customer_service_note ILIKE '%' || ul.display_name || '%'                      THEN 1
      WHEN dm.customer_service_note ILIKE '%' || ul.first_name || ' ' || ul.last_name || '%' THEN 2
      WHEN dm.customer_service_note ILIKE '%' || ul.email_name || '%'                         THEN 3
      WHEN ul.nickname IS NOT NULL
       AND dm.customer_service_note ILIKE '%' || ul.nickname || '%'                           THEN 4
    END AS priority
  FROM dwh.partner dm
  CROSS JOIN users_list ul
  WHERE dm.customer_service_note IS NOT NULL
    AND (
      dm.customer_service_note ILIKE '%' || ul.display_name || '%'
      OR dm.customer_service_note ILIKE '%' || ul.first_name || ' ' || ul.last_name || '%'
      OR dm.customer_service_note ILIKE '%' || ul.email_name || '%'
      OR (ul.nickname IS NOT NULL AND dm.customer_service_note ILIKE '%' || ul.nickname || '%')
    )
  ORDER BY dm.partner_id, priority ASC
),
inserted AS (
  INSERT INTO crm_partners (company, dwh_partner_id, manager_id, status)
  SELECT m.company, m.dwh_id, m.user_id, 'active'
  FROM matches m
  WHERE NOT EXISTS (
    SELECT 1 FROM crm_partners p WHERE p.dwh_partner_id = m.dwh_id
  )
  RETURNING dwh_partner_id
)
UPDATE crm_partners cp
SET    manager_id = m.user_id,
       updated_at = NOW()
FROM   matches m
WHERE  cp.dwh_partner_id = m.dwh_id
  AND  cp.manager_id IS NULL;
