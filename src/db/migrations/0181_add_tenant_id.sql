-- ============================================================
-- Sprint 1 / M2 — Add nullable tenant_id to all domain tables
-- Krok 1: Kolumna nullable (NOT NULL + enforcement w Sprint 2).
-- Krok 2: Indeksy pomocnicze (zmiany PK/UNIQUE w 0183).
--
-- Tabele z migracji 001-005 (core) — bezpośredni ALTER TABLE.
-- Tabele z migracji 0100+ (CRM) — IF EXISTS guard (różne bazy
-- mogą mieć podzbiór migracji CRM).
-- ============================================================

-- ── CORE: USERS & AUTH (001_initial.sql) ─────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_users_tenant_id
  ON users(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE group_profiles
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_group_profiles_tenant_id
  ON group_profiles(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE user_group_roles
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_user_group_roles_tenant_id
  ON user_group_roles(tenant_id) WHERE tenant_id IS NOT NULL;

-- ── CORE: DOCUMENTS (001_initial.sql) ────────────────────────

ALTER TABLE document_groups
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_document_groups_tenant_id
  ON document_groups(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_id
  ON documents(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_document_versions_tenant_id
  ON document_versions(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE document_tags
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_document_tags_tenant_id
  ON document_tags(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE workflow_tasks
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_tenant_id
  ON workflow_tasks(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id
  ON audit_logs(tenant_id) WHERE tenant_id IS NOT NULL;

-- ── CORE: ATTACHMENTS (002_attachments.sql) ──────────────────

ALTER TABLE document_attachments
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_document_attachments_tenant_id
  ON document_attachments(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE attachment_versions
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_attachment_versions_tenant_id
  ON attachment_versions(tenant_id) WHERE tenant_id IS NOT NULL;

-- ── CORE: CONFIG (005_app_settings.sql + 001_initial.sql) ────
-- PK changes odłożone do Sprintu 2

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE doc_number_seq
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

-- ── CRM: tabele z migracji 0100+ (IF EXISTS guard) ───────────

DO $$
BEGIN

  -- crm_partner_groups (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_partner_groups') THEN
    ALTER TABLE crm_partner_groups
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_partner_groups_tenant_id
      ON crm_partner_groups(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_leads (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_leads') THEN
    ALTER TABLE crm_leads
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_leads_tenant_id
      ON crm_leads(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_lead_activities (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_lead_activities') THEN
    ALTER TABLE crm_lead_activities
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_lead_activities_tenant_id
      ON crm_lead_activities(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_lead_documents (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_lead_documents') THEN
    ALTER TABLE crm_lead_documents
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_lead_documents_tenant_id
      ON crm_lead_documents(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_lead_contacts (0136)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_lead_contacts') THEN
    ALTER TABLE crm_lead_contacts
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_lead_contacts_tenant_id
      ON crm_lead_contacts(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_lead_test_accounts (0124)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_lead_test_accounts') THEN
    ALTER TABLE crm_lead_test_accounts
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_lead_test_accounts_tenant_id
      ON crm_lead_test_accounts(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_partners (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_partners') THEN
    ALTER TABLE crm_partners
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_partners_tenant_id
      ON crm_partners(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_partner_activities (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_partner_activities') THEN
    ALTER TABLE crm_partner_activities
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_partner_activities_tenant_id
      ON crm_partner_activities(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_partner_documents (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_partner_documents') THEN
    ALTER TABLE crm_partner_documents
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_partner_documents_tenant_id
      ON crm_partner_documents(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_partner_contacts (0140)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_partner_contacts') THEN
    ALTER TABLE crm_partner_contacts
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_partner_contacts_tenant_id
      ON crm_partner_contacts(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_onboarding_tasks (0108)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_onboarding_tasks') THEN
    ALTER TABLE crm_onboarding_tasks
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_onboarding_tasks_tenant_id
      ON crm_onboarding_tasks(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_opportunities (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_opportunities') THEN
    ALTER TABLE crm_opportunities
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_opportunities_tenant_id
      ON crm_opportunities(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_transactions (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_transactions') THEN
    ALTER TABLE crm_transactions
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_transactions_tenant_id
      ON crm_transactions(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_transaction_products (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_transaction_products') THEN
    ALTER TABLE crm_transaction_products
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_transaction_products_tenant_id
      ON crm_transaction_products(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_sales_transactions (0103)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_sales_transactions') THEN
    ALTER TABLE crm_sales_transactions
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_sales_transactions_tenant_id
      ON crm_sales_transactions(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_sales_budgets (0114)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_sales_budgets') THEN
    ALTER TABLE crm_sales_budgets
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_sales_budgets_tenant_id
      ON crm_sales_budgets(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_import_logs (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_import_logs') THEN
    ALTER TABLE crm_import_logs
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_import_logs_tenant_id
      ON crm_import_logs(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_api_keys (0100)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_api_keys') THEN
    ALTER TABLE crm_api_keys
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_api_keys_tenant_id
      ON crm_api_keys(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_email_attachments (0138)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_email_attachments') THEN
    ALTER TABLE crm_email_attachments
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_email_attachments_tenant_id
      ON crm_email_attachments(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- crm_email_message_reads (0147)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'crm_email_message_reads') THEN
    ALTER TABLE crm_email_message_reads
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_crm_email_message_reads_tenant_id
      ON crm_email_message_reads(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- user_gmail_tokens (0118)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'user_gmail_tokens') THEN
    ALTER TABLE user_gmail_tokens
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_user_gmail_tokens_tenant_id
      ON user_gmail_tokens(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

  -- user_email_signatures (0167)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'user_email_signatures') THEN
    ALTER TABLE user_email_signatures
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_user_email_signatures_tenant_id
      ON user_email_signatures(tenant_id) WHERE tenant_id IS NOT NULL;
  END IF;

END $$;

COMMENT ON COLUMN users.tenant_id          IS 'NULL dozwolony w Sprint 1; NOT NULL enforcement w Sprint 2.';
COMMENT ON COLUMN documents.tenant_id      IS 'NULL dozwolony w Sprint 1; NOT NULL enforcement w Sprint 2.';
COMMENT ON COLUMN app_settings.tenant_id   IS 'NULL dozwolony w Sprint 1; PK (tenant_id,key) w Sprint 2.';
COMMENT ON COLUMN doc_number_seq.tenant_id IS 'NULL dozwolony w Sprint 1; PK (tenant_id,year) w Sprint 2.';
