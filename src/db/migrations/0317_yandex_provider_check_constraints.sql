-- 0317_yandex_provider_check_constraints.sql
--
-- Dopuszcza 'yandex' w czterech CHECK constraintach, ktore trzymaja liste
-- dostawcow poczty na poziomie bazy.
--
-- Dlaczego osobna migracja, a nie czesc 0316: rejestr w config/email-providers.js
-- opisuje siebie jako "the ONE place that lists provider keys" i stwierdza, ze
-- dodanie providera nie wymaga zmian w innych plikach. To nieprawda — poza
-- rejestrem liste powtarzaja jeszcze te constrainty, i bez ich rozszerzenia
-- zapis konfiguracji tenanta konczy sie bledem 23514 (potwierdzone testem API:
-- PUT /admin/tenants/:id/email-providers/yandex -> 500).
--
-- Dwa pierwsze blokuja etap 1 (podlaczanie skrzynki):
--   tenant_email_providers_provider_check  — zapis client_id/secret tenanta
--   tenants_active_email_provider_check    — ustawienie yandexa jako aktywnego
-- Dwa kolejne blokowalyby etap 2 (odbieranie poczty), gdy przychodzaca
-- wiadomosc zapisuje sie jako aktywnosc z email_provider='yandex' — dodane od
-- razu, zeby nie wracac do tego przy IMAP-ie.

ALTER TABLE tenant_email_providers
  DROP CONSTRAINT IF EXISTS tenant_email_providers_provider_check;
ALTER TABLE tenant_email_providers
  ADD CONSTRAINT tenant_email_providers_provider_check
  CHECK (provider IN ('gmail', 'outlook', 'zoho', 'yandex'));

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_active_email_provider_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_active_email_provider_check
  CHECK (active_email_provider IN ('gmail', 'outlook', 'zoho', 'yandex'));

ALTER TABLE crm_lead_activities
  DROP CONSTRAINT IF EXISTS crm_lead_activities_email_provider_check;
ALTER TABLE crm_lead_activities
  ADD CONSTRAINT crm_lead_activities_email_provider_check
  CHECK (email_provider IN ('gmail', 'outlook', 'zoho', 'yandex'));

ALTER TABLE crm_partner_activities
  DROP CONSTRAINT IF EXISTS crm_partner_activities_email_provider_check;
ALTER TABLE crm_partner_activities
  ADD CONSTRAINT crm_partner_activities_email_provider_check
  CHECK (email_provider IN ('gmail', 'outlook', 'zoho', 'yandex'));
