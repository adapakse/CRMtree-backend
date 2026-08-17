-- Dane uzupełnione z pliku importu (zewnętrzna baza klienta)
ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS employment_count    INT,            -- z pliku: "Zatrudnienie"
  ADD COLUMN IF NOT EXISTS annual_revenue      BIGINT,         -- z pliku: "obrot" (PLN)
  ADD COLUMN IF NOT EXISTS founding_year       SMALLINT,       -- z pliku: "Rok"
  ADD COLUMN IF NOT EXISTS company_size        VARCHAR(50),    -- z pliku: "Wielkość"
  ADD COLUMN IF NOT EXISTS industry            VARCHAR(200),   -- z pliku: "Branża"
  ADD COLUMN IF NOT EXISTS company_profile     TEXT,           -- z pliku: "Profil"
  ADD COLUMN IF NOT EXISTS decision_maker_name  VARCHAR(200),  -- z pliku: "Osoba Decyzyjna"
  ADD COLUMN IF NOT EXISTS decision_maker_title VARCHAR(200),  -- z pliku: "Stanowisko"
  ADD COLUMN IF NOT EXISTS decision_maker_dept  VARCHAR(100),  -- z pliku: "Komórka"
  ADD COLUMN IF NOT EXISTS decision_maker_phone VARCHAR(50),   -- z pliku: "Telefon"
  ADD COLUMN IF NOT EXISTS decision_maker_email VARCHAR(200),  -- z pliku: "Email"
  ADD COLUMN IF NOT EXISTS city                VARCHAR(100),   -- z pliku: "Miasto"
  ADD COLUMN IF NOT EXISTS voivodeship         VARCHAR(50),    -- z pliku: "Województwo"
  ADD COLUMN IF NOT EXISTS pkd_id              VARCHAR(20),    -- z pliku: "PKD-ID"
  ADD COLUMN IF NOT EXISTS pkd_description     TEXT;           -- z pliku: "PKD-opis"

CREATE INDEX IF NOT EXISTS idx_prospect_city        ON prospect_companies(city);
CREATE INDEX IF NOT EXISTS idx_prospect_industry    ON prospect_companies(industry);
CREATE INDEX IF NOT EXISTS idx_prospect_voivodeship ON prospect_companies(voivodeship);
