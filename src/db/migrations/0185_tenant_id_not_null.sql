-- ============================================================
-- Sprint 2 — tenant_id NOT NULL enforcement
-- Wszystkie wiersze backfillowane w 0182 → można nałożyć NOT NULL.
-- CRM tabele w blokach IF EXISTS (baza może nie mieć wszystkich).
-- app_settings i doc_number_seq: NOT NULL + composite PK.
-- generate_doc_number() zaktualizowany pod (tenant_id, year).
-- ============================================================

-- ── Safety re-backfill: łapie wiersze wstawione po 0182 bez tenant_id ────────

DO $$
DECLARE
  v_tenant_id UUID;
  t           TEXT;
  crm_tables  TEXT[] := ARRAY[
    'crm_partner_groups', 'crm_leads', 'crm_lead_activities',
    'crm_lead_documents', 'crm_lead_contacts', 'crm_lead_test_accounts',
    'crm_partners', 'crm_partner_activities', 'crm_partner_documents',
    'crm_partner_contacts', 'crm_onboarding_tasks', 'crm_opportunities',
    'crm_transactions', 'crm_transaction_products', 'crm_sales_transactions',
    'crm_sales_budgets', 'crm_import_logs', 'crm_api_keys',
    'crm_email_attachments', 'crm_email_message_reads',
    'user_gmail_tokens', 'user_email_signatures'
  ];
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'crmtree-gold';
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant crmtree-gold nie istnieje — uruchom najpierw 0182_backfill.sql';
  END IF;

  UPDATE users              SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE group_profiles     SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE user_group_roles   SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE document_groups    SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE documents          SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE document_versions  SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE document_tags      SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE document_attachments SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE attachment_versions  SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE workflow_tasks     SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE audit_logs         SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE app_settings       SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE doc_number_seq     SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;

  FOREACH t IN ARRAY crm_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'public' AND table_name = t AND column_name = 'tenant_id'
    ) THEN
      EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL', t)
        USING v_tenant_id;
    END IF;
  END LOOP;

  RAISE NOTICE 'Safety re-backfill zakończony (tenant: %)', v_tenant_id;
END $$;

BEGIN;

-- ── CORE tables (001-005, zawsze obecne) ─────────────────────

ALTER TABLE users              ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE group_profiles     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE user_group_roles   ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE document_groups      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE documents            ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE document_versions    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE document_tags        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE document_attachments ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE attachment_versions  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE workflow_tasks       ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE audit_logs           ALTER COLUMN tenant_id SET NOT NULL;

-- ── app_settings: NOT NULL + zmiana PK na (tenant_id, key) ───

ALTER TABLE app_settings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);

-- ── doc_number_seq: NOT NULL + zmiana PK na (tenant_id, year) ─

ALTER TABLE doc_number_seq ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE doc_number_seq DROP CONSTRAINT doc_number_seq_pkey;
ALTER TABLE doc_number_seq ADD PRIMARY KEY (tenant_id, year);

-- ── Zaktualizuj generate_doc_number() pod nowy PK ─────────────

CREATE OR REPLACE FUNCTION generate_doc_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_year  SMALLINT := EXTRACT(YEAR FROM NOW());
  v_seq   INTEGER;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'documents.tenant_id is required (cannot generate doc_number without tenant)';
  END IF;
  INSERT INTO doc_number_seq (tenant_id, year, last_n) VALUES (NEW.tenant_id, v_year, 1)
    ON CONFLICT (tenant_id, year) DO UPDATE SET last_n = doc_number_seq.last_n + 1
    RETURNING last_n INTO v_seq;
  NEW.doc_number := 'DOC-' || v_year || '-' || LPAD(v_seq::TEXT, 4, '0');
  RETURN NEW;
END;
$$;

-- ── CRM tables (0100+) — IF EXISTS ───────────────────────────

DO $$
DECLARE
  crm_tables TEXT[] := ARRAY[
    'crm_partner_groups',
    'crm_leads',
    'crm_lead_activities',
    'crm_lead_documents',
    'crm_lead_contacts',
    'crm_lead_test_accounts',
    'crm_partners',
    'crm_partner_activities',
    'crm_partner_documents',
    'crm_partner_contacts',
    'crm_onboarding_tasks',
    'crm_opportunities',
    'crm_transactions',
    'crm_transaction_products',
    'crm_sales_transactions',
    'crm_sales_budgets',
    'crm_import_logs',
    'crm_api_keys',
    'crm_email_attachments',
    'crm_email_message_reads',
    'user_gmail_tokens',
    'user_email_signatures'
  ];
  t TEXT;
BEGIN
  FOREACH t IN ARRAY crm_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'public' AND table_name = t AND column_name = 'tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
      RAISE NOTICE 'SET NOT NULL tenant_id: %', t;
    ELSE
      RAISE NOTICE 'Pomijam (brak kolumny): %', t;
    END IF;
  END LOOP;
END $$;

COMMIT;
