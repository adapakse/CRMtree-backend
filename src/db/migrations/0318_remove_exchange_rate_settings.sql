-- 0318_remove_exchange_rate_settings.sql
-- The fixed EUR / USD / GBP / CHF rates seeded by 0114 are replaced by NBP
-- rates (nbp_exchange_rates, migration 0317) and are no longer read by any
-- code. Removed for every tenant, including the template tenant new tenants
-- copy their settings from, so the dead settings leave the settings screen
-- and are not handed on.

DELETE FROM app_settings
WHERE key IN ('exchange_rate_eur', 'exchange_rate_usd', 'exchange_rate_gbp', 'exchange_rate_chf');
