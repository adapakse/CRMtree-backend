-- Migration 0286: config_revision dla LIVE edycji ICP — niezależny licznik
-- optimistic-concurrency, ODDZIELONY od "version"/current_version_id w
-- tenant_icp_config_versions (decyzja: LIVE working config vs ostatnia
-- PUBLISHED poprawna wersja, patrz tenantIcpConfigService.js).
--
-- Dlaczego osobny licznik: LIVE config (tenant_icp_signals) może być chwilowo
-- invalid w trakcie edycji (np. admin przenosi punkty między sygnałami: suma
-- na chwilę wynosi 75/70) — to NIE może wpływać na enrichment ani przerywać
-- numeracji opublikowanych wersji. current_version_id/version w
-- tenant_icp_config_versions rosną WYŁĄCZNIE gdy live config jest poprawny
-- (signals_sum == wymagana suma) — invalid stany nigdy tam nie trafiają.
-- config_revision rośnie przy KAŻDEJ mutacji LIVE, poprawnej czy nie, i służy
-- tylko do wykrywania konfliktu dwóch adminów edytujących ten sam tenant.

ALTER TABLE tenant_icp_configs
  ADD COLUMN IF NOT EXISTS config_revision INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN tenant_icp_configs.config_revision IS
  'Licznik optimistic-concurrency dla LIVE edycji tenant_icp_signals/
   qualification_threshold — rośnie przy KAŻDEJ mutacji, niezależnie od tego czy
   config jest w danym momencie poprawny i niezależnie od current_version_id/version
   w tenant_icp_config_versions (osobny licznik dla faktycznie opublikowanych,
   poprawnych configów, jedynych używanych przez enrichOne() do scoringu).';
