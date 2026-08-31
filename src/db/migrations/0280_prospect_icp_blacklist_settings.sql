-- Migration 0280: app settings — blacklista ICP dla scoringu prospektów.
-- Firmy, których nazwa / branża / opis PKD pasuje do słów kluczowych
-- (domyślnie: hurtownie) dostają karę punktową odejmowaną od icp_score —
-- nie mieszczą się w ICP CRMtree. Kod ma fallback na wartości domyślne gdy
-- brak wiersza dla tenanta, więc te wiersze są głównie po to, by admin mógł
-- listę i karę edytować w UI. Per-tenant, wzorzec jak 0265_prospect_ai_provider.

INSERT INTO app_settings (tenant_id, key, value, value_type, label, description, category)
SELECT t.id, 'prospect.icp_blacklist_keywords',
       '["hurtow","sprzedaż hurtowa","handel hurtowy","dystrybucja hurtowa"]', 'json',
       'Prospekty — słowa kluczowe blacklisty ICP',
       'Jeśli którekolwiek słowo (dopasowanie po fragmencie, bez rozróżniania wielkości liter) pojawi się w nazwie firmy, branży, opisie PKD lub nazwie kodu PKD z GUS, od icp_score odejmowana jest kara (patrz "Prospekty — kara punktowa za blacklistę ICP"). Domyślnie "hurtow" wychwytuje hurtownie oraz działalność PKD sekcji 46 (handel hurtowy) — te firmy nie pasują do ICP CRMtree.',
       'crm'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO app_settings (tenant_id, key, value, value_type, label, description, category)
SELECT t.id, 'prospect.icp_blacklist_penalty', '15', 'number',
       'Prospekty — kara punktowa za blacklistę ICP',
       'Ile punktów odjąć od icp_score, gdy firma pasuje do słów kluczowych blacklisty ICP. Wynik nie spada poniżej 0.',
       'crm'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;
