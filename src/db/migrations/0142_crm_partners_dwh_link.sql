-- 0142_crm_partners_dwh_link.sql
-- 1. Dodaje kolumnę dwh_partner_id do crm_partners (klucz obcy do dwh.dm_partner)
-- 2. Próbuje automatycznie połączyć partnerów po NIP lub nazwie firmy
-- 3. Usuwa tabelę crm_sales_transactions (zastąpiona przez dwh.dm_sales)
--
-- UWAGA: Kolumny crm_partners (subdomain, language, partner_currency, country,
-- billing_address, billing_zip, billing_city, billing_country, billing_email_address,
-- admin_first_name, admin_last_name, admin_email, address) POZOSTAJĄ w tabeli.
-- Działamy wg zasady "CRM-first, DWH fills gaps":
--  • Na etapie onboardingu user wypełnia pola ręcznie — dane w CRM mają pierwszeństwo.
--  • Po aktywacji DWH uzupełnia pola puste (COALESCE(crm_value, dwh_value)).
--  • Pole jest read-only dla usera dopiero gdy DWH dostarczyło wartość (pole_from_dwh=true)
--    i partner nie jest w statusie 'onboarding'.

-- ── 1. Dodaj kolumnę dwh_partner_id ──────────────────────────────────────────
ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS dwh_partner_id INTEGER UNIQUE;

CREATE INDEX IF NOT EXISTS idx_crm_partners_dwh_partner_id
  ON crm_partners(dwh_partner_id)
  WHERE dwh_partner_id IS NOT NULL;

-- ── 2. Automatyczne powiązanie po NIP lub nazwie firmy ────────────────────────
-- Bezpieczne: aktualizuje tylko gdy jest jednoznaczne dopasowanie
UPDATE crm_partners p
SET    dwh_partner_id = dm.partner_id
FROM   dwh.dm_partner dm
WHERE  p.dwh_partner_id IS NULL
  AND  (
         (p.nip IS NOT NULL AND p.nip = dm.nip)
         OR
         (p.company IS NOT NULL AND lower(trim(p.company)) = lower(trim(dm.company_name)))
       );

-- ── 3. Usuń tabelę crm_sales_transactions ────────────────────────────────────
-- Dane sprzedażowe są teraz czytane wyłącznie z dwh.dm_sales.
DROP TABLE IF EXISTS crm_sales_transactions CASCADE;
