-- Migration 0331: app settings — minimalny czas rozmowy telefonicznej (sekundy).
-- Port z WorkTrips (0243). Próg checkboxa „≥ X s” w panelu „Moje połączenia
-- telefoniczne” na dashboardzie handlowca i na wykresie „Połączenia per
-- handlowiec” w Dashboardzie Prospektów. Frontend ma fallback 35, gdy brak
-- wiersza. Per-tenant, także crmtree-gold, z którego nowe tenanty kopiują ustawienia.

INSERT INTO app_settings (tenant_id, key, value, value_type, label, description, category)
SELECT t.id, 'min_call_duration_sec', '35', 'number',
       'PBX: min. czas trwania rozmowy (sek.)',
       'Rozmowy krótsze niż ta wartość są pomijane, gdy zaznaczony jest filtr „≥ X s” w panelu „Moje połączenia telefoniczne” i na wykresie połączeń per handlowiec w Dashboardzie Prospektów.',
       'crm'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;
