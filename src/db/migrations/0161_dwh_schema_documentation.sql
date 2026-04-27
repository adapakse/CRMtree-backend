-- 0161_dwh_schema_documentation.sql
-- Dokumentacja schematu DWH — tabele zasilane przez ETL z systemu transakcyjnego.
-- Ten plik służy wyłącznie do odtworzenia schematu w nowym środowisku.
-- Na środowisku produkcyjnym i stagingowym tabele te są zarządzane przez pipeline ETL
-- i NIE powinny być tworzone ręcznie (dane przychodzą z zewnątrz).
--
-- Zależności: schemat 'dwh' musi istnieć przed uruchomieniem.

CREATE SCHEMA IF NOT EXISTS dwh;

-- ── dwh.partner ───────────────────────────────────────────────────────────────
-- Dane partnerów synchronizowane z systemu transakcyjnego.
-- partner_id = klucz obcy do crm_partners.dwh_partner_id
-- Pole emails jest JSONB — zawiera tablicę adresów e-mail do fakturowania, np. ["billing@firma.pl"]

CREATE TABLE IF NOT EXISTS dwh.partner (
  partner_id                  INTEGER,
  name                        VARCHAR,
  subdomain                   VARCHAR,
  domain                      VARCHAR,
  config_json                 VARCHAR,
  super_partner               BOOLEAN,
  max_debit                   NUMERIC(8,2),
  country                     VARCHAR,
  default_price_from          INTEGER,
  default_price_to            INTEGER,
  currency                    VARCHAR,
  self_registered             BOOLEAN,
  partner_group               VARCHAR,
  is_test_account             BOOLEAN,
  customer_service_note       VARCHAR,
  switched_to_prod_at         TIMESTAMP,
  default_services_process_type VARCHAR,
  is_contract_signed          BOOLEAN,
  custom_contact_email        VARCHAR,
  partner_billing_address_id  INTEGER,
  company_name                VARCHAR,
  address                     VARCHAR,
  tax_numbers                 VARCHAR,
  zip_code                    VARCHAR,
  town                        VARCHAR,
  billing_country             VARCHAR,
  def                         BOOLEAN,
  billing_address_updated_at  TIMESTAMP,
  billing_language            VARCHAR,
  billing_currency            VARCHAR,
  emails                      JSONB,
  eknf_id                     INTEGER,
  partner_id_eknf             VARCHAR(50),
  created_at                  TIMESTAMP,
  updated_at                  TIMESTAMP
);

-- Indeks po partner_id — główny klucz wyszukiwania z CRM
CREATE INDEX IF NOT EXISTS idx_dwh_partner_partner_id ON dwh.partner(partner_id);

-- ── Mapowanie dwh.partner → crm_partners (dla dokumentacji) ──────────────────
-- dwh.partner.partner_id      = crm_partners.dwh_partner_id  (klucz łączący)
-- dwh.partner.company_name    → COALESCE z crm_partners.company
-- dwh.partner.address         → crm_partners.billing_address
-- dwh.partner.zip_code        → crm_partners.billing_zip
-- dwh.partner.town            → crm_partners.billing_city
-- dwh.partner.billing_country → crm_partners.billing_country
-- dwh.partner.emails          → crm_partners.billing_email_address (pierwsza pozycja tablicy JSONB)
-- dwh.partner.tax_numbers     → crm_partners.nip
-- dwh.partner.subdomain       → crm_partners.subdomain
-- dwh.partner.billing_currency→ crm_partners.partner_currency
-- dwh.partner.is_test_account → informacja czy partner jest kontem testowym
-- dwh.partner.is_contract_signed → crm_partners.contract_signed (uzupełnienie)
-- dwh.partner.switched_to_prod_at → data aktywacji produkcyjnej

-- ── dwh.sales ─────────────────────────────────────────────────────────────────
-- Dane sprzedażowe (zagregowane dziennie) synchronizowane z systemu transakcyjnego.
-- partner_id = klucz łączący z dwh.partner.partner_id i crm_partners.dwh_partner_id

CREATE TABLE IF NOT EXISTS dwh.sales (
  sale_date                   DATE,
  partner_id                  INTEGER,
  service_category            TEXT,
  currency                    VARCHAR(50),
  gross_sales_value_pln       NUMERIC,
  net_sales_value_pln         NUMERIC,
  net_sales_value_currency    NUMERIC,
  gross_fee_value_pln         NUMERIC,
  net_fee_value_pln           NUMERIC,
  gross_margin_value_pln      NUMERIC,
  number_of_products          BIGINT
);

-- Indeks po partner_id + sale_date — typowe zapytania w raportach
CREATE INDEX IF NOT EXISTS idx_dwh_sales_partner_date ON dwh.sales(partner_id, sale_date);
