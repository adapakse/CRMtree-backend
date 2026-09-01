-- Analizator Rozmów — port 1:1 z worktrips-doc (konsoliduje 6 przyrostowych
-- migracji tamtego repo w jeden krok, CRMtree tego jeszcze nie miało).
-- Kluczowane po NIP (nie po lead_id/partner_id bezpośrednio) — jedna firma może
-- mieć wiele rozmów z różnych źródeł (import CSV historyczny + rozmowy na żywo).
CREATE TABLE IF NOT EXISTS call_analysis_companies (
  nip                 VARCHAR(10)              PRIMARY KEY,
  company_name        VARCHAR(255),
  city                VARCHAR(255),
  calls_count         INTEGER                  NOT NULL DEFAULT 0,
  last_call_date      DATE,
  first_call_date     DATE,
  last_call_end_date  DATE,
  notes_text          TEXT,
  score               INTEGER,
  ai_summary          TEXT,
  ai_signals          JSONB                    NOT NULL DEFAULT '[]',
  ai_objections       JSONB                    NOT NULL DEFAULT '[]',
  analysis_status     VARCHAR(20)              NOT NULL DEFAULT 'pending',
  analysis_error      TEXT,
  analyzed_at         TIMESTAMP WITH TIME ZONE,
  imported_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  imported_by         UUID REFERENCES users(id),
  group_id            UUID REFERENCES group_profiles(id),
  crm_lead_id         INT  REFERENCES crm_leads(id) ON DELETE SET NULL,
  follow_up_required  BOOLEAN NOT NULL DEFAULT FALSE,
  follow_up_done      BOOLEAN NOT NULL DEFAULT FALSE,
  follow_up_date      DATE,
  salesperson         VARCHAR(255),
  salesperson_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  salesperson_name    TEXT
);

CREATE INDEX IF NOT EXISTS idx_call_analysis_followup_date
  ON call_analysis_companies (follow_up_date)
  WHERE follow_up_date IS NOT NULL;
