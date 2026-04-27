-- 0159_align_local_to_server.sql
-- Wyrównuje schemat lokalny do serwera produkcyjnego.
-- Idempotentna: sprawdza typy kolumn przed zmianą — bezpieczna na serwerze gdzie
-- zmiany są już zrobione.
--
-- Zmiany:
--   1. crm_partners.id: SERIAL INTEGER → UUID DEFAULT gen_random_uuid()
--   2. Wszystkie FK partner_id: INTEGER → UUID (dane są migrowane przez tymczasowe kolumny)
--   3. dwh.partner.emails: VARCHAR/brak → JSONB (wypełniana z billing_email_address)

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- CZĘŚĆ 1: crm_partners.id + wszystkie FK partner_id  INTEGER → UUID
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_id_type text;
BEGIN
  SELECT data_type INTO v_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'crm_partners'
    AND column_name  = 'id';

  IF v_id_type IS DISTINCT FROM 'integer' THEN
    RAISE NOTICE 'crm_partners.id nie jest INTEGER (jest: %), pomijam część 1', v_id_type;
    RETURN;
  END IF;

  -- ── 1. Dodaj tymczasową kolumnę UUID do crm_partners ──────────────────────
  ALTER TABLE crm_partners ADD COLUMN _uuid UUID DEFAULT gen_random_uuid();
  UPDATE crm_partners SET _uuid = gen_random_uuid() WHERE _uuid IS NULL;

  -- ── 2. Dodaj tymczasowe kolumny UUID do tabel FK ──────────────────────────
  ALTER TABLE crm_partner_activities ADD COLUMN _pid UUID;
  ALTER TABLE crm_partner_documents  ADD COLUMN _pid UUID;
  ALTER TABLE crm_onboarding_tasks   ADD COLUMN _pid UUID;
  ALTER TABLE crm_opportunities      ADD COLUMN _pid UUID;
  ALTER TABLE crm_transactions       ADD COLUMN _pid UUID;

  -- Tabele opcjonalne (mogą nie istnieć na starszych instalacjach)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='crm_partner_contacts') THEN
    ALTER TABLE crm_partner_contacts ADD COLUMN _pid UUID;
    UPDATE crm_partner_contacts c SET _pid = p._uuid FROM crm_partners p WHERE p.id = c.partner_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='crm_email_attachments') THEN
    ALTER TABLE crm_email_attachments ADD COLUMN _pid UUID;
    UPDATE crm_email_attachments a SET _pid = p._uuid FROM crm_partners p WHERE p.id = a.partner_id;
  END IF;

  -- ── 3. Przekopiuj UUID do tabel FK przez JOIN po starym INTEGER id ─────────
  UPDATE crm_partner_activities a SET _pid = p._uuid FROM crm_partners p WHERE p.id = a.partner_id;
  UPDATE crm_partner_documents  d SET _pid = p._uuid FROM crm_partners p WHERE p.id = d.partner_id;
  UPDATE crm_onboarding_tasks   t SET _pid = p._uuid FROM crm_partners p WHERE p.id = t.partner_id;
  UPDATE crm_opportunities      o SET _pid = p._uuid FROM crm_partners p WHERE p.id = o.partner_id;
  UPDATE crm_transactions       t SET _pid = p._uuid FROM crm_partners p WHERE p.id = t.partner_id;

  -- ── 4. Usuń PRIMARY KEY (CASCADE usuwa wszystkie FK constraints) ───────────
  ALTER TABLE crm_partners DROP CONSTRAINT crm_partners_pkey CASCADE;

  -- ── 5. Podmień id w crm_partners ──────────────────────────────────────────
  ALTER TABLE crm_partners DROP COLUMN id;           -- usuwa też sekwencję SERIAL
  ALTER TABLE crm_partners RENAME COLUMN _uuid TO id;
  ALTER TABLE crm_partners ADD PRIMARY KEY (id);
  ALTER TABLE crm_partners ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE crm_partners ALTER COLUMN id SET NOT NULL;

  -- ── 6. Podmień partner_id: crm_partner_activities ─────────────────────────
  ALTER TABLE crm_partner_activities DROP COLUMN partner_id;
  ALTER TABLE crm_partner_activities RENAME COLUMN _pid TO partner_id;
  ALTER TABLE crm_partner_activities ALTER COLUMN partner_id SET NOT NULL;
  ALTER TABLE crm_partner_activities
    ADD CONSTRAINT crm_partner_activities_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES crm_partners(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_crm_partner_act_partner ON crm_partner_activities(partner_id);

  -- ── 7. Podmień partner_id: crm_partner_documents ──────────────────────────
  ALTER TABLE crm_partner_documents DROP COLUMN partner_id;   -- usuwa też UNIQUE(partner_id,document_id)
  ALTER TABLE crm_partner_documents RENAME COLUMN _pid TO partner_id;
  ALTER TABLE crm_partner_documents ALTER COLUMN partner_id SET NOT NULL;
  ALTER TABLE crm_partner_documents
    ADD CONSTRAINT crm_partner_documents_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES crm_partners(id) ON DELETE CASCADE;
  ALTER TABLE crm_partner_documents
    ADD CONSTRAINT crm_partner_documents_partner_id_document_id_key
    UNIQUE (partner_id, document_id);

  -- ── 8. Podmień partner_id: crm_onboarding_tasks ───────────────────────────
  ALTER TABLE crm_onboarding_tasks DROP COLUMN partner_id;
  ALTER TABLE crm_onboarding_tasks RENAME COLUMN _pid TO partner_id;
  ALTER TABLE crm_onboarding_tasks ALTER COLUMN partner_id SET NOT NULL;
  ALTER TABLE crm_onboarding_tasks
    ADD CONSTRAINT crm_onboarding_tasks_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES crm_partners(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_cot_partner_id ON crm_onboarding_tasks(partner_id);
  CREATE INDEX IF NOT EXISTS idx_cot_step       ON crm_onboarding_tasks(partner_id, step);

  -- ── 9. Podmień partner_id: crm_opportunities ──────────────────────────────
  ALTER TABLE crm_opportunities DROP COLUMN partner_id;
  ALTER TABLE crm_opportunities RENAME COLUMN _pid TO partner_id;
  ALTER TABLE crm_opportunities ALTER COLUMN partner_id SET NOT NULL;
  ALTER TABLE crm_opportunities
    ADD CONSTRAINT crm_opportunities_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES crm_partners(id) ON DELETE CASCADE;

  -- ── 10. Podmień partner_id: crm_transactions (nullable) ───────────────────
  ALTER TABLE crm_transactions DROP COLUMN partner_id;
  ALTER TABLE crm_transactions RENAME COLUMN _pid TO partner_id;
  -- partner_id jest nullable w crm_transactions
  ALTER TABLE crm_transactions
    ADD CONSTRAINT crm_transactions_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES crm_partners(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_crm_txn_partner ON crm_transactions(partner_id);

  -- ── 11. Podmień partner_id: crm_partner_contacts (jeśli istnieje) ─────────
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='crm_partner_contacts') THEN
    ALTER TABLE crm_partner_contacts DROP COLUMN partner_id;
    ALTER TABLE crm_partner_contacts RENAME COLUMN _pid TO partner_id;
    ALTER TABLE crm_partner_contacts ALTER COLUMN partner_id SET NOT NULL;
    ALTER TABLE crm_partner_contacts
      ADD CONSTRAINT crm_partner_contacts_partner_id_fkey
      FOREIGN KEY (partner_id) REFERENCES crm_partners(id) ON DELETE CASCADE;
  END IF;

  -- ── 12. Podmień partner_id: crm_email_attachments (nullable, jeśli istnieje)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='crm_email_attachments') THEN
    ALTER TABLE crm_email_attachments DROP COLUMN partner_id;
    ALTER TABLE crm_email_attachments RENAME COLUMN _pid TO partner_id;
    ALTER TABLE crm_email_attachments
      ADD CONSTRAINT crm_email_attachments_partner_id_fkey
      FOREIGN KEY (partner_id) REFERENCES crm_partners(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_crm_email_att_partner
      ON crm_email_attachments(partner_id)
      WHERE partner_id IS NOT NULL;
  END IF;

  RAISE NOTICE 'Część 1 gotowa: crm_partners.id i wszystkie FK partner_id → UUID';
END $$;


-- ══════════════════════════════════════════════════════════════════════════════
-- CZĘŚĆ 2: dwh.partner.emails → JSONB
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_emails_type        text;
  v_has_billing_email  boolean;
BEGIN
  -- Sprawdź czy tabela dwh.partner w ogóle istnieje
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'dwh' AND table_name = 'partner') THEN
    RAISE NOTICE 'Tabela dwh.partner nie istnieje, pomijam część 2';
    RETURN;
  END IF;

  SELECT data_type INTO v_emails_type
  FROM information_schema.columns
  WHERE table_schema = 'dwh'
    AND table_name   = 'partner'
    AND column_name  = 'emails';

  IF v_emails_type IS NULL THEN
    -- Kolumna emails nie istnieje → dodaj jako JSONB
    ALTER TABLE dwh.partner ADD COLUMN emails JSONB;

    -- Populuj z billing_email_address (jeśli ta kolumna istnieje lokalnie)
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'dwh' AND table_name = 'partner'
        AND column_name = 'billing_email_address'
    ) INTO v_has_billing_email;

    IF v_has_billing_email THEN
      UPDATE dwh.partner
      SET    emails = to_jsonb(ARRAY[billing_email_address::text])
      WHERE  billing_email_address IS NOT NULL
        AND  trim(billing_email_address) <> '';
    END IF;

    RAISE NOTICE 'Dodano dwh.partner.emails jako JSONB';

  ELSIF v_emails_type IN ('character varying', 'text', 'varchar') THEN
    -- Kolumna istnieje jako VARCHAR → konwertuj na JSONB
    ALTER TABLE dwh.partner ADD COLUMN emails_jsonb JSONB;
    UPDATE dwh.partner
    SET    emails_jsonb = to_jsonb(ARRAY[emails::text])
    WHERE  emails IS NOT NULL AND trim(emails) <> '';
    ALTER TABLE dwh.partner DROP COLUMN emails;
    ALTER TABLE dwh.partner RENAME COLUMN emails_jsonb TO emails;
    RAISE NOTICE 'Skonwertowano dwh.partner.emails VARCHAR → JSONB';

  ELSE
    RAISE NOTICE 'dwh.partner.emails już jest JSONB, pomijam część 2';
  END IF;
END $$;

COMMIT;
