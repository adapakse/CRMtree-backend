-- Moduł prospektów — firmy do wzbogacenia i potencjalni klienci CRM
CREATE TABLE prospect_companies (
  id                     SERIAL PRIMARY KEY,

  -- Dane wejściowe (z CSV)
  nip                    VARCHAR(10)  NOT NULL,
  regon                  VARCHAR(14),
  company_name           VARCHAR(255),
  imported_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Dane z KRS
  krs_number             VARCHAR(10),
  legal_form             VARCHAR(100),
  registered_address     TEXT,
  registration_date      DATE,
  branches_count         INT,
  branches_scope         VARCHAR(10),   -- 'pl' | 'eu' | 'global'
  krs_website             VARCHAR(500),

  -- Strona WWW
  website_url            VARCHAR(500),

  -- Dane z GUS BIR (uzupełniane gdy dostępne)
  pkd_codes               JSONB,
  employment_range        VARCHAR(20),   -- np. '50-249', '250-499'

  -- Wyniki analizy AI
  travel_potential_score INT,           -- 0-100
  travel_signals          JSONB,         -- ["opis sygnału 1", ...]
  travel_scope             VARCHAR(10),   -- 'local' | 'national' | 'eu' | 'global'
  field_teams_likely     BOOLEAN,
  ai_summary              TEXT,

  -- Status enrichmentu
  enriched_at             TIMESTAMPTZ,
  enrichment_status       VARCHAR(20)  NOT NULL DEFAULT 'pending',
                         -- 'pending' | 'done' | 'error' | 'no_website' | 'no_krs'
  enrichment_error        TEXT,

  -- Powiązanie z CRM
  crm_lead_id             INT REFERENCES crm_leads(id) ON DELETE SET NULL,

  CONSTRAINT prospect_companies_nip_unique UNIQUE (nip)
);

CREATE INDEX idx_prospect_companies_status      ON prospect_companies(enrichment_status);
CREATE INDEX idx_prospect_companies_imported_at ON prospect_companies(imported_at);
CREATE INDEX idx_prospect_companies_enriched_at ON prospect_companies(enriched_at);
CREATE INDEX idx_prospect_companies_score       ON prospect_companies(travel_potential_score);
