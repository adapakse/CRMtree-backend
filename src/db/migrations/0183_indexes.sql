-- ============================================================
-- Sprint 1 / M4 — Unique constraints + composite indexes
-- Usuwa globalne UNIQUE-e łamiące multi-tenancy.
-- Dodaje złożone indeksy (tenant_id + typowy filtr) pod wydajność.
-- Uwaga: zmiany PK (app_settings, doc_number_seq) i generate_doc_number()
--        odłożone do Sprintu 2 (wymagają NOT NULL enforcement).
-- CRM indeksy (tabele z 0100+) budowane w blokach IF EXISTS.
-- ============================================================

BEGIN;

-- ── 1. users.email: globalna unikalność → per-tenant ────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name        = 'users'
      AND constraint_name   = 'users_email_key'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_email_key;
    RAISE NOTICE 'Dropped users_email_key';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email
  ON users(tenant_id, email)
  WHERE tenant_id IS NOT NULL;

-- ── 2. group_profiles.name: globalna unikalność → per-tenant ────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name        = 'group_profiles'
      AND constraint_name   = 'group_profiles_name_key'
  ) THEN
    ALTER TABLE group_profiles DROP CONSTRAINT group_profiles_name_key;
    RAISE NOTICE 'Dropped group_profiles_name_key';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_profiles_tenant_name
  ON group_profiles(tenant_id, name)
  WHERE tenant_id IS NOT NULL;

-- ── 3. documents.doc_number: globalna unikalność → per-tenant ───────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name        = 'documents'
      AND constraint_name   = 'documents_doc_number_key'
  ) THEN
    ALTER TABLE documents DROP CONSTRAINT documents_doc_number_key;
    RAISE NOTICE 'Dropped documents_doc_number_key';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_tenant_doc_number
  ON documents(tenant_id, doc_number)
  WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;

-- ── 4. crm_sales_transactions unique (period,partner_name,product_type) + tenant_id

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'crm_sales_transactions'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_schema = 'public'
        AND table_name        = 'crm_sales_transactions'
        AND constraint_name   = 'crm_sales_transactions_period_partner_name_product_type_key'
    ) THEN
      ALTER TABLE crm_sales_transactions
        DROP CONSTRAINT crm_sales_transactions_period_partner_name_product_type_key;
      RAISE NOTICE 'Dropped crm_sales_transactions unique';
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cst_tenant_period_partner_product
      ON crm_sales_transactions(tenant_id, period, partner_name, product_type)
      WHERE tenant_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_cst_tenant_period
      ON crm_sales_transactions(tenant_id, period)
      WHERE tenant_id IS NOT NULL;
  END IF;
END $$;

-- ── 5. Złożone indeksy wydajnościowe — core tables (001-005, zawsze obecne) ─

-- users
CREATE INDEX IF NOT EXISTS idx_users_tenant_active
  ON users(tenant_id, is_active) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_tenant_crm_role
  ON users(tenant_id, crm_role) WHERE tenant_id IS NOT NULL AND crm_role IS NOT NULL;

-- documents
CREATE INDEX IF NOT EXISTS idx_documents_tenant_status
  ON documents(tenant_id, status) WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_owner
  ON documents(tenant_id, owner_id) WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_group
  ON documents(tenant_id, group_id) WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;

-- audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_action
  ON audit_logs(tenant_id, action) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_user
  ON audit_logs(tenant_id, user_id) WHERE tenant_id IS NOT NULL AND user_id IS NOT NULL;

-- ── 6. Złożone indeksy wydajnościowe — CRM tables (0100+, IF EXISTS) ─────────

DO $$
BEGIN

  -- crm_leads
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_leads') THEN
    CREATE INDEX IF NOT EXISTS idx_crm_leads_tenant_stage
      ON crm_leads(tenant_id, stage) WHERE tenant_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_leads_tenant_assigned
      ON crm_leads(tenant_id, assigned_to) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_partners
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_partners') THEN
    CREATE INDEX IF NOT EXISTS idx_crm_partners_tenant_status
      ON crm_partners(tenant_id, status) WHERE tenant_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_partners_tenant_manager
      ON crm_partners(tenant_id, manager_id) WHERE tenant_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_partners_tenant_group
      ON crm_partners(tenant_id, group_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_lead_activities
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_lead_activities') THEN
    CREATE INDEX IF NOT EXISTS idx_crm_lead_act_tenant_lead
      ON crm_lead_activities(tenant_id, lead_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_partner_activities
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_partner_activities') THEN
    CREATE INDEX IF NOT EXISTS idx_crm_partner_act_tenant_partner
      ON crm_partner_activities(tenant_id, partner_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_sales_budgets
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_sales_budgets') THEN
    CREATE INDEX IF NOT EXISTS idx_crm_sales_budgets_tenant_user_year
      ON crm_sales_budgets(tenant_id, user_id, year) WHERE tenant_id IS NOT NULL;
  END IF;

END $$;

COMMIT;
